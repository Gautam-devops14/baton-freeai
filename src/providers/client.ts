// Unified OpenAI-compatible chat client (spec §5, guardrails 1 & 3).
// One fetch helper for every provider; no vendor SDKs.

import type { CallTrace, ChatMessage, ProviderTarget, TokenUsage } from "../types.js";
import { listModels, rankModels } from "./discovery.js";
import { rememberCall } from "./trace.js";
import {
  clearProviderBusy,
  getDiscoveredModel,
  isModelDead,
  markModelDead,
  markProviderBusy,
  rememberDiscoveredModel,
} from "./memory.js";

export const DEFAULT_TIMEOUT_MS = Number(process.env.BATON_PROVIDER_TIMEOUT_MS ?? 30_000);

export type ProviderErrorKind =
  | "model_unavailable"
  | "overloaded"
  | "billing"
  | "rate_limit"
  | "timeout"
  | "network"
  | "auth"
  | "server"
  | "bad_response"
  | "client";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    /** Milliseconds the provider asked us to wait (from Retry-After), if any. */
    readonly retryAfterMs?: number,
    /** Models stepped past (retired / not found) before this error was raised. */
    readonly skippedModels: SkippedModel[] = [],
    /** The provider's own error message, shortened (shown in logs for non-obvious failures). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Short human-readable reason used in execution logs. */
  get reason(): string {
    const base = this.baseReason();
    const showDetail = this.detail && ["client", "model_unavailable", "auth", "bad_response", "server"].includes(this.kind);
    return showDetail ? `${base}: ${this.detail}` : base;
  }

  private baseReason(): string {
    switch (this.kind) {
      case "rate_limit":
        return `HTTP ${this.status ?? 429} rate limit detected`;
      case "timeout":
        return "socket timeout";
      case "model_unavailable":
        return `HTTP ${this.status ?? 404} model unavailable`;
      case "overloaded":
        return `HTTP ${this.status ?? 503} model overloaded`;
      case "billing":
        return `HTTP ${this.status ?? 429} account has no credit (insufficient_quota)`;
      case "network":
        return "network error";
      case "auth":
        return `HTTP ${this.status} authentication rejected`;
      case "server":
        return `HTTP ${this.status} provider error`;
      case "bad_response":
        return "malformed provider response";
      default:
        return `HTTP ${this.status ?? "?"} request rejected`;
    }
  }
}

export interface ChatOptions {
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /**
   * If every model is overloaded (503 / "high demand"), wait and try them once
   * more before giving up. Callers enable this only for the LAST provider in a
   * waterfall: with another provider available, switching beats waiting.
   */
  retryOverloaded?: boolean;
  /** Called for every provider HTTP call (start and end) — for live progress and the debug view. */
  onTrace?: (t: CallTrace) => void;
  /** Run/step the calls belong to, copied into each trace. */
  traceMeta?: { runId?: string; step?: number };
}

const dailyLimitSkipMs = () => Number(process.env.BATON_DAILY_LIMIT_SKIP_MS ?? 3600_000);

/** Read at call time so it can be tuned (or zeroed in tests) without a restart. */
function overloadRetryDelayMs(): number {
  return Number(process.env.BATON_OVERLOAD_RETRY_MS ?? 2000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMIT_TEXT = /rate.?limit|quota|too many requests|resource.?exhausted/i;
/** Google answers a bad key with HTTP 400 "API key not valid", not 401. */
const BAD_KEY_TEXT = /api[ _-]?key not valid|invalid api[ _-]?key|incorrect api key|API_KEY_INVALID/i;
/** OpenAI answers 429 + insufficient_quota when the account has no credit: not temporary. */
const BILLING_TEXT = /insufficient_quota|check your plan and billing|billing details|credit balance is too low|insufficient credits/i;
/** Daily caps (e.g. OpenRouter "free-models-per-day") won't lift in minutes: skip the provider for longer. */
const DAILY_LIMIT_TEXT = /per[- _]?day|daily (?:limit|quota)|requests per day|RPD/i;
const OVERLOAD_TEXT = /high demand|overloaded|"UNAVAILABLE"|try again later/i;

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Models a provider has told us it no longer serves (404 / "no longer available"). */
const MODEL_UNAVAILABLE_TEXT =
  /no longer available|no longer supported|decommissioned|deprecated and (?:is|has been) removed|model_not_found|model_decommissioned|unknown model|invalid model|not a valid model|does not have access to model|(?:model|models\/)\S*\s+(?:is\s+)?not found|not found for api version|does not exist|is not supported for/i;

/** Pull a human-readable message out of the many error-body shapes providers use. */
function providerMessage(raw: string): string | undefined {
  let msg: unknown;
  try {
    const j = JSON.parse(raw);
    const o = Array.isArray(j) ? j[0] : j;
    msg = o?.error?.message ?? o?.detail ?? o?.message ?? (typeof o?.error === "string" ? o.error : undefined) ?? o?.title;
  } catch {
    msg = raw;
  }
  if (typeof msg !== "string") return undefined;
  const oneLine = msg.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  return oneLine ? (oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine) : undefined;
}

export interface SkippedModel {
  model: string;
  reason: string;
  /** The model tried next, if any. */
  next?: string;
  /** Delay before trying `next` (set when retrying overloaded models). */
  afterMs?: number;
  /** `next` came from the provider's live model list, not the configured list. */
  nextDiscovered?: boolean;
}

export interface ChatResult {
  content: string;
  /** The model that actually produced `content` (may be a fallback model). */
  model: string;
  /** Models tried first and skipped (retired, or overloaded at the time). */
  skippedModels: SkippedModel[];
  /** Tokens this successful call consumed (reported by the provider, or estimated). */
  usage: TokenUsage;
}

/** Rough 4-chars-per-token estimate, used only when a provider omits `usage`. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function readUsage(raw: unknown, messages: ChatMessage[], content: string): TokenUsage {
  const u = (raw as { usage?: Record<string, unknown> } | undefined)?.usage;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const prompt = num(u?.prompt_tokens);
  const completion = num(u?.completion_tokens);
  if (prompt !== undefined && completion !== undefined) {
    return { promptTokens: prompt, completionTokens: completion, totalTokens: num(u?.total_tokens) ?? prompt + completion };
  }
  const p = estimateTokens(messages.map((m) => m.content).join("\n"));
  const c = estimateTokens(content);
  return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true };
}

/**
 * Send a chat request, walking the target's model list: `target.model` first,
 * then each of `target.fallbackModels`.
 *  - Retired model (404 / "no longer available"): skip to the next model and
 *    remember it on the target so later calls in this run don't retry it.
 *  - Overloaded model (503 / "high demand"): skip to the next model, which
 *    usually has separate capacity. Not remembered: the spike is temporary.
 *    With `retryOverloaded`, overloaded models get one more pass after a pause.
 *  - Anything else (429, timeout, auth...): throw at once so the relay can fail
 *    over to a different provider.
 */
export async function chatCompletion(
  target: ProviderTarget,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const unavailable = (target.unavailableModels ??= new Set<string>());
  // Models retired in earlier runs are skipped straight away; a replacement
  // discovered in an earlier run is tried after any configured model still alive.
  for (const m of [target.model, ...(target.fallbackModels ?? [])]) if (isModelDead(target, m)) unavailable.add(m);
  const remembered = getDiscoveredModel(target);
  let candidates = [target.model, ...(target.fallbackModels ?? []), ...(remembered ? [remembered] : [])].filter(
    (m, i, all) => all.indexOf(m) === i && !unavailable.has(m),
  );
  const skippedModels: SkippedModel[] = [];
  let lastError: ProviderError | undefined;
  const maxPasses = opts.retryOverloaded ? 2 : 1;

  for (let pass = 1; pass <= maxPasses && candidates.length > 0; pass++) {
    const overloaded: string[] = [];
    for (const [i, model] of candidates.entries()) {
      try {
        const { content, usage } = await requestOnce(target, model, messages, opts);
        clearProviderBusy(target);
        return { content, model, skippedModels, usage };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.kind !== "model_unavailable" && err.kind !== "overloaded") {
          // e.g. the fallback model is rate limited: surface it, but keep the swap history.
          throw new ProviderError(err.message, err.kind, err.status, err.retryAfterMs, skippedModels, err.detail);
        }
        if (err.kind === "model_unavailable") {
          unavailable.add(model);
          markModelDead(target, model);
        } else overloaded.push(model);
        skippedModels.push({ model, reason: err.reason, next: candidates[i + 1] });
        lastError = err;
      }
    }

    if (overloaded.length === 0 || pass === maxPasses) break;
    const delay = overloadRetryDelayMs();
    Object.assign(skippedModels[skippedModels.length - 1], { next: overloaded[0], afterMs: delay });
    await sleep(delay);
    candidates = overloaded;
  }

  // Every configured model is retired: ask the provider what it serves today (once per run).
  if (lastError?.kind === "model_unavailable" && target.modelHints && !target.discoveryTried) {
    target.discoveryTried = true;
    const live = (await listModels(target)).filter((id) => !target.modelFilter || target.modelFilter.test(id));
    const found = rankModels(live, target.modelHints, unavailable);
    if (found.length && skippedModels.length) {
      Object.assign(skippedModels[skippedModels.length - 1], { next: found[0], nextDiscovered: true });
    }
    for (const [i, model] of found.entries()) {
      try {
        const { content, usage } = await requestOnce(target, model, messages, opts);
        target.fallbackModels = [...(target.fallbackModels ?? []), model]; // reuse it for the rest of the run
        rememberDiscoveredModel(target, model); // ...and in later runs
        clearProviderBusy(target);
        return { content, model, skippedModels, usage };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.kind !== "model_unavailable" && err.kind !== "overloaded") {
          throw new ProviderError(err.message, err.kind, err.status, err.retryAfterMs, skippedModels, err.detail);
        }
        if (err.kind === "model_unavailable") {
          unavailable.add(model);
          markModelDead(target, model);
        }
        skippedModels.push({ model, reason: err.reason, next: found[i + 1], nextDiscovered: Boolean(found[i + 1]) });
        lastError = err;
      }
    }
  }

  const tried = [target.model, ...(target.fallbackModels ?? [])].join(", ");
  const kind = lastError?.kind === "overloaded" ? "overloaded" : "model_unavailable";
  if (kind === "overloaded") markProviderBusy(target); // skip it for a few minutes in later steps and runs
  throw new ProviderError(
    kind === "overloaded"
      ? `${target.provider} models are overloaded (tried: ${tried}): ${lastError?.message}`
      : `${target.provider} has no available models (tried: ${tried})${lastError ? `: ${lastError.message}` : ""}`,
    kind,
    lastError?.status ?? (kind === "overloaded" ? 503 : 404),
    lastError?.retryAfterMs,
    skippedModels,
    lastError?.detail,
  );
}

/** One traced provider call: emits start/end events with status, latency and tokens. */
async function requestOnce(
  target: ProviderTarget,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ content: string; usage: TokenUsage }> {
  const base = {
    provider: target.provider,
    model,
    host: (() => {
      try {
        return new URL(target.baseUrl).host;
      } catch {
        return target.baseUrl;
      }
    })(),
    ...opts.traceMeta,
  };
  const t0 = Date.now();
  opts.onTrace?.({ phase: "start", at: new Date(t0).toISOString(), ...base });
  const finish = (extra: Partial<CallTrace>) => {
    const t: CallTrace = { phase: "end", at: new Date().toISOString(), latencyMs: Date.now() - t0, ...base, ...extra };
    rememberCall(t);
    opts.onTrace?.(t);
  };
  try {
    const result = await requestUntraced(target, model, messages, opts);
    finish({ status: 200, outcome: "ok", tokens: result.usage });
    return result;
  } catch (err) {
    const pe = err instanceof ProviderError ? err : undefined;
    finish({ status: pe?.status, outcome: pe?.kind ?? "error", detail: pe ? pe.reason : String((err as Error)?.message ?? err) });
    throw err;
  }
}

async function requestUntraced(
  target: ProviderTarget,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ content: string; usage: TokenUsage }> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (target.sendTemperature !== false) body.temperature = opts.temperature ?? 0.2;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode && target.supportsJsonMode !== false) body.response_format = { type: "json_object" };

  // The timer spans the whole exchange (headers AND body), so a provider that
  // stalls mid-stream still trips failover instead of hanging the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...target.extraHeaders,
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    raw = await res.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ProviderError(`${target.provider} timed out`, "timeout");
    }
    throw new ProviderError(`${target.provider} network failure: ${(err as Error).message}`, "network");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = raw.slice(0, 300);
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if ((res.status === 429 || res.status === 402) && BILLING_TEXT.test(detail)) {
      throw new ProviderError(`${target.provider} has no credit: ${detail}`, "billing", res.status);
    }
    if (res.status === 429 && DAILY_LIMIT_TEXT.test(detail)) {
      markProviderBusy(target, dailyLimitSkipMs());
      throw new ProviderError(`${target.provider} daily limit reached: ${detail}`, "rate_limit", res.status, retryAfterMs, [], providerMessage(raw));
    }
    if (res.status === 429 || RATE_LIMIT_TEXT.test(detail)) {
      throw new ProviderError(`${target.provider} rate limited: ${detail}`, "rate_limit", res.status, retryAfterMs);
    }
    const said = providerMessage(raw);
    if (
      res.status === 404 ||
      res.status === 410 ||
      ([400, 403, 422].includes(res.status) && MODEL_UNAVAILABLE_TEXT.test(detail))
    ) {
      throw new ProviderError(`${target.provider} model ${model} unavailable: ${detail}`, "model_unavailable", res.status, undefined, [], said);
    }
    if (res.status === 401 || res.status === 403 || (res.status === 400 && BAD_KEY_TEXT.test(detail))) {
      throw new ProviderError(`${target.provider} auth failed: ${detail}`, "auth", res.status, undefined, [], said);
    }
    if (res.status === 503 || (res.status >= 500 && OVERLOAD_TEXT.test(detail))) {
      throw new ProviderError(`${target.provider} model ${model} overloaded: ${detail}`, "overloaded", res.status, retryAfterMs);
    }
    if (res.status >= 500) {
      throw new ProviderError(`${target.provider} server error: ${detail}`, "server", res.status, retryAfterMs, [], said);
    }
    throw new ProviderError(`${target.provider} rejected request: ${detail}`, "client", res.status, undefined, [], said);
  }

  let content: unknown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    content = (parsed as any)?.choices?.[0]?.message?.content;
  } catch {
    throw new ProviderError(`${target.provider} returned non-JSON body`, "bad_response", res.status);
  }
  if (typeof content !== "string" || content.trim() === "") {
    throw new ProviderError(`${target.provider} returned empty completion`, "bad_response", res.status);
  }
  // Reasoning models (e.g. some NIM-hosted ones) prepend <think>…</think>; it's not part of the artifact.
  const cleaned = content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
  return { content: cleaned || content, usage: readUsage(parsed, messages, content) };
}
