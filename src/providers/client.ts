// Unified OpenAI-compatible chat client (spec §5, guardrails 1 & 3).
// One fetch helper for every provider; no vendor SDKs.

import { circuitAllows, recordFailure, recordSuccess, releaseProbe } from "./circuitBreaker.js";
import type { CallTrace, ChatMessage, ProviderTarget, TokenUsage } from "../types.js";
import { listModels, rankModels } from "./discovery.js";
import { rememberCall } from "./trace.js";
import { outputReserve, pacerMaxWaitMs, pacerWait, recordTokens, tpmLimit } from "./pacer.js";
import {
  clearProviderBusy,
  getDiscoveredModel,
  isModelDead,
  markModelDead,
  markProviderBusy,
  rememberDiscoveredModel,
  SKIP_REASONS,
} from "./memory.js";

export const DEFAULT_TIMEOUT_MS = Number(process.env.BATON_PROVIDER_TIMEOUT_MS ?? 12_000);

/** Hard limit per milestone (plan or file) across every provider, model, retry and wait. */
export const stepDeadlineMs = () => Number(process.env.BATON_STEP_DEADLINE_MS ?? 45_000);

/** The user pressed Stop (or closed the page). Not a provider problem: never retried or failed over. */
export class CancelledError extends Error {
  constructor() {
    super("stopped by the user");
    this.name = "CancelledError";
  }
}

export const isCancelled = (err: unknown): err is CancelledError => err instanceof CancelledError;

/** Throw if the run was stopped. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/** Sleep that ends early (throwing CancelledError) when the run is stopped. */
export function sleepUnlessCancelled(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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

  /** The model whose call raised this error (set by the client). */
  model?: string;
  /** The problem affects the whole account (e.g. a daily cap), so other models won't help. */
  accountLevel?: boolean;
  /** Set when the provider was skipped instantly because its circuit breaker is open (no request sent). */
  circuitOpen?: string;

  /** Short human-readable reason used in execution logs. */
  get reason(): string {
    if (this.circuitOpen) return this.circuitOpen;
    const base = this.baseReason();
    const showDetail = this.detail && ["client", "model_unavailable", "auth", "bad_response", "server", "timeout"].includes(this.kind);
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
  /** Max gap between streamed chunks before giving up (default BATON_STREAM_IDLE_TIMEOUT_MS). */
  idleTimeoutMs?: number;
  /** Internal: called while a reply streams in, with characters received so far. */
  onStreamProgress?: (chars: number) => void;
  /** Called when Baton deliberately waits before a call (e.g. pacing under a tokens/minute cap). */
  onWait?: (ms: number, message: string, provider: string, model: string) => void;
  /** Stops every call and wait at once when the user presses Stop. */
  signal?: AbortSignal;
  /** Epoch ms: no new model attempt starts after this, and first-chunk waits are cut to fit. */
  deadlineAt?: number;
}

/** First-chunk timeout for models picked by discovery: unknown models get less patience. */
const discoveredTimeoutMs = () => Number(process.env.BATON_DISCOVERED_TIMEOUT_MS ?? 15_000);

const dailyLimitSkipMs = () => Number(process.env.BATON_DAILY_LIMIT_SKIP_MS ?? 3600_000);
const noCreditSkipMs = () => Number(process.env.BATON_NO_CREDIT_SKIP_MS ?? 3600_000);
const keyRejectedSkipMs = () => Number(process.env.BATON_KEY_REJECTED_SKIP_MS ?? 600_000);
const noModelsSkipMs = () => Number(process.env.BATON_NO_MODELS_SKIP_MS ?? 3600_000);
/** Re-throw a call's error with the model swap history attached. */
function withHistory(err: ProviderError, skipped: SkippedModel[]): ProviderError {
  const e = new ProviderError(err.message, err.kind, err.status, err.retryAfterMs, skipped, err.detail);
  e.model = err.model;
  e.accountLevel = err.accountLevel;
  return e;
}

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

/** Retry hint from the Retry-After header, or from text like Groq's "Please try again in 7.66s" / "in 1m2.5s". */
function retryHint(header: string | null, body: string): number | undefined {
  const fromHeader = parseRetryAfter(header);
  if (fromHeader !== undefined) return fromHeader;
  const m = /try again in (?:(\d+)m)?\s*([\d.]+)\s*s/i.exec(body);
  return m ? Math.round((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000) : undefined;
}

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
  /** Characters of hidden reasoning the model streamed or wrapped in <think> (for the token breakdown). */
  reasoningChars?: number;
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
  const details = (u?.completion_tokens_details ?? u?.output_tokens_details) as Record<string, unknown> | undefined;
  const reasoning = num(details?.reasoning_tokens) ?? num(u?.reasoning_tokens);
  if (prompt !== undefined && completion !== undefined) {
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: num(u?.total_tokens) ?? prompt + completion,
      ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    };
  }
  const p = estimateTokens(messages.map((m) => m.content).join("\n"));
  const c = estimateTokens(content);
  return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true };
}

/** Problems with the whole account or provider: no other model of this provider will help. */
export function isAccountLevel(err: ProviderError): boolean {
  return err.kind === "auth" || err.kind === "billing" || err.kind === "network" || err.accountLevel === true;
}

/** Problems that usually clear within a minute on free tiers: worth a cool-down and another round. */
export function isTransient(err: ProviderError): boolean {
  if (err.accountLevel && err.kind !== "network") return false;
  return ["rate_limit", "overloaded", "timeout", "server", "network"].includes(err.kind);
}


/** When every model failed, report the most actionable reason (a rate limit can be waited out; a retirement can't). */
const KIND_PRIORITY: ProviderErrorKind[] = ["rate_limit", "overloaded", "timeout", "server", "bad_response", "client", "model_unavailable"];

/**
 * Send a chat request, trying EVERY model this provider has before giving up on it:
 * the configured list (`target.model`, then `target.fallbackModels`), then models
 * discovered from the provider's live list (once per run).
 *  - Model-level problems (rate limit, overloaded, timeout, retired/not found,
 *    bad or empty reply, 4xx/5xx) -> try the provider's next model. Limits are
 *    usually per model, so another model often still works.
 *  - Account-level problems (key rejected, no credit, daily cap, host unreachable)
 *    -> throw at once: no other model of this provider would help.
 *  - Retired models are remembered (this run and later runs). With
 *    `retryOverloaded`, overloaded models get one more pass after a pause.
 */
/** Errors that count toward tripping a provider's circuit: 429, 503/overload, timeouts (not our own step deadline). */
const countsForCircuit = (e: ProviderError) =>
  !e.circuitOpen && e.detail !== "step time limit reached" &&
  (e.kind === "rate_limit" || e.kind === "overloaded" || e.kind === "timeout" || (e.kind === "server" && e.status === 503));

/**
 * One provider call (trying its models in order), behind a circuit breaker: a provider that failed
 * 3 times in a row is skipped instantly for 45s instead of costing another 12s timeout.
 */
export async function chatCompletion(
  target: ProviderTarget,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const gate = circuitAllows(target);
  if (!gate.ok) {
    const secs = Math.max(1, Math.ceil(gate.retryInMs / 1000));
    const e = new ProviderError(`${target.provider}: circuit open`, "overloaded", 503, gate.retryInMs);
    e.circuitOpen = `circuit open (${gate.failures} failures in a row); skipped instantly, next trial in ${secs}s`;
    throw e;
  }
  try {
    const result = await chatCompletionInner(target, messages, opts);
    recordSuccess(target);
    return result;
  } catch (err) {
    if (err instanceof ProviderError && countsForCircuit(err)) recordFailure(target);
    else releaseProbe(target);
    throw err;
  }
}

async function chatCompletionInner(
  target: ProviderTarget,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const unavailable = (target.unavailableModels ??= new Set<string>());
  // Models retired in earlier runs are skipped straight away; a replacement
  // discovered in an earlier run is tried after any configured model still alive.
  for (const m of [target.model, ...(target.fallbackModels ?? [])]) if (isModelDead(target, m)) unavailable.add(m);
  const remembered = getDiscoveredModel(target);
  const configured = [target.model, ...(target.fallbackModels ?? []), ...(remembered ? [remembered] : [])].filter(
    (m, i, all) => all.indexOf(m) === i && !unavailable.has(m),
  );
  const skippedModels: SkippedModel[] = [];
  const failures: Array<{ model: string; err: ProviderError }> = [];
  const tried = new Set<string>();

  /** Try each model in order; returns the first success, or undefined if all failed at model level. */
  const tryModels = async (models: string[], callOpts: ChatOptions, discovered: boolean): Promise<ChatResult | undefined> => {
    for (const [i, model] of models.entries()) {
      throwIfCancelled(callOpts.signal);
      if (callOpts.deadlineAt !== undefined && Date.now() >= callOpts.deadlineAt) {
        failures.push({ model, err: new ProviderError(`${target.provider}: step deadline reached`, "timeout", undefined, undefined, [], "step time limit reached") });
        return undefined;
      }
      tried.add(model);
      try {
        const { content, usage, reasoningChars } = await requestOnce(target, model, messages, callOpts);
        if (discovered) {
          target.fallbackModels = [...(target.fallbackModels ?? []), model]; // reuse it for the rest of the run
          rememberDiscoveredModel(target, model); // ...and in later runs
        }
        clearProviderBusy(target);
        return { content, model, skippedModels, usage, reasoningChars };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (isAccountLevel(err)) throw withHistory(err, skippedModels);
        if (err.kind === "model_unavailable") {
          unavailable.add(model);
          markModelDead(target, model);
        }
        failures.push({ model, err });
        skippedModels.push({ model, reason: err.reason, next: models[i + 1], nextDiscovered: discovered && Boolean(models[i + 1]) });
      }
    }
    return undefined;
  };

  // 1. Every configured model.
  let result = await tryModels(configured, opts, false);
  if (result) return result;

  // 2. Overloaded models get one more pass after a pause (last provider in the waterfall only).
  const overloaded = failures.filter((f) => f.err.kind === "overloaded").map((f) => f.model);
  const fitsDeadline = (ms: number) => opts.deadlineAt === undefined || Date.now() + ms < opts.deadlineAt;
  if (opts.retryOverloaded && overloaded.length && skippedModels.length && fitsDeadline(overloadRetryDelayMs())) {
    const delay = overloadRetryDelayMs();
    Object.assign(skippedModels[skippedModels.length - 1], { next: overloaded[0], afterMs: delay, nextDiscovered: false });
    await sleepUnlessCancelled(delay, opts.signal);
    result = await tryModels(overloaded, opts, false);
    if (result) return result;
  }

  // 3. Models discovered from the provider's live list (once per run), for any model-level failure.
  if (target.modelHints && !target.discoveryTried && !(opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt)) {
    target.discoveryTried = true;
    const live = (await listModels(target)).filter((id) => !target.modelFilter || target.modelFilter.test(id));
    const found = rankModels(live, target.modelHints, new Set([...unavailable, ...tried]), 5);
    if (found.length && skippedModels.length) {
      Object.assign(skippedModels[skippedModels.length - 1], { next: found[0], nextDiscovered: true });
    }
    const discoveredOpts = { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, discoveredTimeoutMs()) };
    result = await tryModels(found, discoveredOpts, true);
    if (result) return result;
  }

  // Every model failed. Report the most actionable failure.
  const pick =
    KIND_PRIORITY.map((k) => failures.filter((f) => f.err.kind === k)).find((list) => list.length) ?? [];
  const chosen = pick[pick.length - 1]; // the last model tried with that problem (what the log names)
  const kind: ProviderErrorKind = chosen?.err.kind ?? "model_unavailable";
  const retryAfters = pick.map((f) => f.err.retryAfterMs).filter((v): v is number => v !== undefined);
  const allOf = (k: ProviderErrorKind) => failures.length > 0 && failures.every((f) => f.err.kind === k);
  if (allOf("overloaded")) markProviderBusy(target); // skip it for a few minutes in later steps and runs
  else if ((allOf("model_unavailable") || failures.length === 0) && (target.discoveryTried || !target.modelHints)) {
    markProviderBusy(target, noModelsSkipMs(), SKIP_REASONS.noModels); // no configured or discoverable model works
  }
  const summary = failures.map((f) => `${f.model}: ${f.err.reason}`).join("; ") || "no models left to try";
  const e = new ProviderError(
    `${target.provider}: every model failed (${summary})`,
    kind,
    chosen?.err.status ?? 404,
    retryAfters.length ? Math.min(...retryAfters) : undefined,
    skippedModels,
    chosen?.err.detail,
  );
  e.model = chosen?.model;
  return Promise.reject(e);
}

/** One traced provider call: emits start/end events with status, latency and tokens. */
async function requestOnce(
  target: ProviderTarget,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ content: string; usage: TokenUsage; reasoningChars?: number }> {
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
  // Pace under the provider's tokens-per-minute cap instead of running into a 429.
  const limit = tpmLimit(target.provider, model);
  if (limit) {
    const needed = estimateTokens(messages.map((m) => m.content).join("\n")) + outputReserve();
    const wait = pacerWait(target, model, needed);
    if (wait > 0 && wait <= pacerMaxWaitMs()) {
      opts.onWait?.(wait, `pacing: waiting ${(wait / 1000).toFixed(1)}s to stay under ${target.provider}'s ${limit.toLocaleString("en-US")} tokens/min for ${model}`, target.provider, model);
      await sleepUnlessCancelled(wait, opts.signal);
    }
  }
  throwIfCancelled(opts.signal);
  const t0 = Date.now();
  opts.onTrace?.({ phase: "start", at: new Date(t0).toISOString(), ...base });
  const finish = (extra: Partial<CallTrace>) => {
    const t: CallTrace = { phase: "end", at: new Date().toISOString(), latencyMs: Date.now() - t0, ...base, ...extra };
    rememberCall(t);
    opts.onTrace?.(t);
  };
  try {
    const result = await requestUntraced(target, model, messages, {
      ...opts,
      onStreamProgress: opts.onTrace ? (chars) => opts.onTrace!({ phase: "progress", at: new Date().toISOString(), ...base, chars }) : undefined,
    });
    recordTokens(target, model, result.usage.totalTokens);
    // Keep exactly what the model said (before cleanup), so a run can be reviewed later.
    finish({ status: 200, outcome: "ok", tokens: result.usage, reply: clip(result.raw ?? result.content) });
    return { content: result.content, usage: result.usage, reasoningChars: result.reasoningChars };
  } catch (err) {
    const pe = err instanceof ProviderError ? err : undefined;
    if (pe) pe.model ??= model;
    if (isCancelled(err)) {
      finish({ outcome: "cancelled", detail: "stopped by the user" });
      throw err;
    }
    finish({ status: pe?.status, outcome: pe?.kind ?? "error", detail: pe ? pe.reason : String((err as Error)?.message ?? err) });
    throw err;
  }
}

/** Turn an HTTP error (or an error object sent mid-stream) into a classified ProviderError. */
function classifyError(target: ProviderTarget, model: string, status: number, raw: string, retryAfterHeader: string | null): ProviderError {
  const detail = raw.slice(0, 300);
  const retryAfterMs = retryHint(retryAfterHeader, raw);
  const said = providerMessage(raw);
  if ((status === 429 || status === 402) && BILLING_TEXT.test(detail)) {
    markProviderBusy(target, noCreditSkipMs(), SKIP_REASONS.noCredit); // won't fix itself soon: skip in later runs too
    return new ProviderError(`${target.provider} has no credit: ${detail}`, "billing", status);
  }
  if (status === 429 && DAILY_LIMIT_TEXT.test(detail)) {
    markProviderBusy(target, dailyLimitSkipMs(), SKIP_REASONS.dailyLimit);
    const e = new ProviderError(`${target.provider} daily limit reached: ${detail}`, "rate_limit", status, retryAfterMs, [], said);
    e.accountLevel = true;
    return e;
  }
  if (status === 429 || RATE_LIMIT_TEXT.test(detail)) {
    return new ProviderError(`${target.provider} rate limited: ${detail}`, "rate_limit", status, retryAfterMs);
  }
  if (status === 404 || status === 410 || ([400, 403, 422].includes(status) && MODEL_UNAVAILABLE_TEXT.test(detail))) {
    return new ProviderError(`${target.provider} model ${model} unavailable: ${detail}`, "model_unavailable", status, undefined, [], said);
  }
  if (status === 401 || status === 403 || (status === 400 && BAD_KEY_TEXT.test(detail))) {
    markProviderBusy(target, keyRejectedSkipMs(), SKIP_REASONS.keyRejected);
    return new ProviderError(`${target.provider} auth failed: ${detail}`, "auth", status, undefined, [], said);
  }
  if (status === 503 || status === 502 || (status >= 500 && OVERLOAD_TEXT.test(detail))) {
    return new ProviderError(`${target.provider} model ${model} overloaded: ${detail}`, "overloaded", status, retryAfterMs);
  }
  if (status >= 500) return new ProviderError(`${target.provider} server error: ${detail}`, "server", status, retryAfterMs, [], said);
  return new ProviderError(`${target.provider} rejected request: ${detail}`, "client", status, undefined, [], said);
}

/** Some OpenAI-compatible servers reject stream_options; retry without it once. */
const STREAM_OPTIONS_REJECTED = /stream_options|include_usage|extra inputs are not permitted|unrecognized request argument/i;

const streamIdleMs = () => Number(process.env.BATON_STREAM_IDLE_TIMEOUT_MS ?? 20_000);
const maxCallMs = () => Number(process.env.BATON_MAX_CALL_MS ?? 180_000);

/**
 * One HTTP call. Streams the reply (stream: true) so timeouts can tell "slow but
 * working" from "stuck":
 *  - no first chunk within timeoutMs (default 12s, cut to the step deadline) -> timeout
 *  - a gap longer than BATON_STREAM_IDLE_TIMEOUT_MS (20s) mid-reply          -> timeout
 *  - longer than BATON_MAX_CALL_MS overall (180s)                             -> timeout
 * A model still writing a long file is never cut off at 12s. Providers that
 * answer with plain JSON instead of a stream are handled too.
 */
async function requestUntraced(
  target: ProviderTarget,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  allowStreamOptions = true,
): Promise<{ content: string; usage: TokenUsage; raw?: string; reasoningChars?: number }> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (allowStreamOptions && target.streamUsage !== false) body.stream_options = { include_usage: true };
  if (target.sendTemperature !== false) body.temperature = opts.temperature ?? 0.2;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode && target.supportsJsonMode !== false) body.response_format = { type: "json_object" };

  // First-chunk wait: normally 12s, but never past the milestone's deadline (minimum 3s, so a call gets a fair try).
  const baseFirst = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const firstMs = opts.deadlineAt !== undefined ? Math.max(Math.min(baseFirst, 3000), Math.min(baseFirst, opts.deadlineAt - Date.now())) : baseFirst;
  const idleMs = opts.idleTimeoutMs ?? streamIdleMs();
  const totalMs = maxCallMs();
  const controller = new AbortController();
  const started = Date.now();
  const state: { lastChunk: number; why: string; cancel?: () => void } = { lastChunk: 0, why: "" };
  const watchdog = setInterval(() => {
    const t = Date.now();
    if (!state.lastChunk && t - started > firstMs) state.why = `no response within ${Math.round(firstMs / 1000)}s`;
    else if (state.lastChunk && t - state.lastChunk > idleMs) state.why = `reply stalled for ${Math.round(idleMs / 1000)}s`;
    else if (t - started > totalMs) state.why = `call exceeded ${Math.round(totalMs / 1000)}s`;
    if (state.why) {
      controller.abort();
      state.cancel?.(); // also stop a body read that ignores the abort signal
    }
  }, Math.max(10, Math.min(250, firstMs / 2)));
  // Stop pressed: abort the HTTP request to the provider immediately.
  const onCancel = () => {
    state.why = "cancelled";
    controller.abort();
    state.cancel?.();
  };
  if (opts.signal?.aborted) onCancel();
  else opts.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...target.extraHeaders,
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const raw = await res.text();
      if (allowStreamOptions && body.stream_options && res.status === 400 && STREAM_OPTIONS_REJECTED.test(raw)) {
        clearInterval(watchdog);
        return requestUntraced(target, model, messages, opts, false);
      }
      throw classifyError(target, model, res.status, raw, res.headers.get("retry-after"));
    }

    // Plain JSON reply (provider ignored stream: true).
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const raw = await res.text();
      state.lastChunk = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ProviderError(`${target.provider} returned non-JSON body`, "bad_response", res.status);
      }
      const msg = (parsed as any)?.choices?.[0]?.message;
      const reasoning = msg?.reasoning ?? msg?.reasoning_content;
      return finishContent(target, res.status, messages, typeof msg?.content === "string" ? msg.content : "", parsed, typeof reasoning === "string" ? reasoning.length : 0);
    }

    // Server-Sent Events stream.
    const reader = res.body!.getReader();
    state.cancel = () => void reader.cancel().catch(() => {});
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoningChars = 0;
    let usage: unknown;
    let lastProgress = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.lastChunk = Date.now();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // comments (": keep-alive") and blank lines
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) {
          const code = Number(j.error.code ?? j.error.status);
          throw classifyError(target, model, Number.isFinite(code) && code >= 400 ? code : 500, JSON.stringify(j), null);
        }
        const delta = j.choices?.[0]?.delta;
        if (typeof delta?.content === "string") content += delta.content;
        // Hidden reasoning streamed separately (OpenRouter "reasoning", DeepSeek/NIM "reasoning_content").
        const r = delta?.reasoning ?? delta?.reasoning_content;
        if (typeof r === "string") reasoningChars += r.length;
        if (j.usage) usage = j.usage;
      }
      if (opts.onStreamProgress && state.lastChunk - lastProgress > 500) {
        lastProgress = state.lastChunk;
        opts.onStreamProgress(content.length);
      }
    }
    if (controller.signal.aborted) throw new ProviderError("aborted", "timeout"); // reader was cancelled by the watchdog
    return finishContent(target, res.status, messages, content, usage ? { usage } : undefined, reasoningChars);
  } catch (err) {
    if (opts.signal?.aborted) throw new CancelledError();
    if (err instanceof ProviderError && !(err.kind === "timeout" && err.message === "aborted")) throw err;
    if (controller.signal.aborted) {
      throw new ProviderError(`${target.provider} timed out (${state.why || "aborted"})`, "timeout", undefined, undefined, [], state.why || undefined);
    }
    throw new ProviderError(`${target.provider} network failure: ${(err as Error).message}`, "network");
  } finally {
    clearInterval(watchdog);
    opts.signal?.removeEventListener("abort", onCancel);
  }
}

function finishContent(
  target: ProviderTarget,
  status: number,
  messages: ChatMessage[],
  content: string,
  usageSource: unknown,
  streamedReasoningChars = 0,
) {
  if (content.trim() === "") throw new ProviderError(`${target.provider} returned empty completion`, "bad_response", status);
  // Reasoning models (e.g. some NIM-hosted ones) prepend <think>…</think>; it's not part of the artifact.
  const cleaned = content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
  const reasoningChars = streamedReasoningChars + (cleaned ? content.length - cleaned.length : 0);
  const usage = readUsage(usageSource, messages, content);
  // No reported reasoning count, but we saw reasoning text: estimate it.
  if (usage.reasoningTokens === undefined && reasoningChars > 0) {
    usage.reasoningTokens = estimateTokens("x".repeat(reasoningChars));
    usage.reasoningEstimated = true;
  }
  return { content: cleaned || content, usage, raw: content, reasoningChars };
}

/** Longest raw reply kept per call for the run record / export. */
const maxReplyChars = () => Number(process.env.BATON_TRACE_REPLY_CHARS ?? 60_000);
const clip = (s: string) => (s.length > maxReplyChars() ? `${s.slice(0, maxReplyChars())}\n[... ${s.length - maxReplyChars()} more characters not stored ...]` : s);
