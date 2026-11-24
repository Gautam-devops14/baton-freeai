// Unified OpenAI-compatible chat client (spec §5, guardrails 1 & 3).
// One fetch helper for every provider; no vendor SDKs.

import type { ChatMessage, ProviderTarget } from "../types.js";

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
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Short human-readable reason used in execution logs. */
  get reason(): string {
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
const BILLING_TEXT = /insufficient_quota|check your plan and billing|billing details|credit balance is too low/i;
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
  /no longer available|(?:model|models\/)\S*\s+(?:is\s+)?not found|not found for api version|does not exist|is not supported for/i;

export interface SkippedModel {
  model: string;
  reason: string;
  /** The model tried next, if any. */
  next?: string;
  /** Delay before trying `next` (set when retrying overloaded models). */
  afterMs?: number;
}

export interface ChatResult {
  content: string;
  /** The model that actually produced `content` (may be a fallback model). */
  model: string;
  /** Models tried first and skipped (retired, or overloaded at the time). */
  skippedModels: SkippedModel[];
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
  let candidates = [target.model, ...(target.fallbackModels ?? [])].filter(
    (m, i, all) => all.indexOf(m) === i && !unavailable.has(m),
  );
  const skippedModels: SkippedModel[] = [];
  let lastError: ProviderError | undefined;
  const maxPasses = opts.retryOverloaded ? 2 : 1;

  for (let pass = 1; pass <= maxPasses && candidates.length > 0; pass++) {
    const overloaded: string[] = [];
    for (const [i, model] of candidates.entries()) {
      try {
        const content = await requestOnce(target, model, messages, opts);
        return { content, model, skippedModels };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.kind !== "model_unavailable" && err.kind !== "overloaded") {
          // e.g. the fallback model is rate limited: surface it, but keep the swap history.
          throw new ProviderError(err.message, err.kind, err.status, err.retryAfterMs, skippedModels);
        }
        if (err.kind === "model_unavailable") unavailable.add(model);
        else overloaded.push(model);
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

  const tried = [target.model, ...(target.fallbackModels ?? [])].join(", ");
  const kind = lastError?.kind === "overloaded" ? "overloaded" : "model_unavailable";
  throw new ProviderError(
    kind === "overloaded"
      ? `${target.provider} models are overloaded (tried: ${tried}): ${lastError?.message}`
      : `${target.provider} has no available models (tried: ${tried})${lastError ? `: ${lastError.message}` : ""}`,
    kind,
    lastError?.status ?? (kind === "overloaded" ? 503 : 404),
    lastError?.retryAfterMs,
    skippedModels,
  );
}

async function requestOnce(
  target: ProviderTarget,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (target.sendTemperature !== false) body.temperature = opts.temperature ?? 0.2;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) body.response_format = { type: "json_object" };

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
    if (res.status === 429 || RATE_LIMIT_TEXT.test(detail)) {
      throw new ProviderError(`${target.provider} rate limited: ${detail}`, "rate_limit", res.status, retryAfterMs);
    }
    if (res.status === 404 || ((res.status === 400 || res.status === 410) && MODEL_UNAVAILABLE_TEXT.test(detail))) {
      throw new ProviderError(`${target.provider} model ${model} unavailable: ${detail}`, "model_unavailable", res.status);
    }
    if (res.status === 401 || res.status === 403 || (res.status === 400 && BAD_KEY_TEXT.test(detail))) {
      throw new ProviderError(`${target.provider} auth failed: ${detail}`, "auth", res.status);
    }
    if (res.status === 503 || (res.status >= 500 && OVERLOAD_TEXT.test(detail))) {
      throw new ProviderError(`${target.provider} model ${model} overloaded: ${detail}`, "overloaded", res.status, retryAfterMs);
    }
    if (res.status >= 500) {
      throw new ProviderError(`${target.provider} server error: ${detail}`, "server", res.status, retryAfterMs);
    }
    throw new ProviderError(`${target.provider} rejected request: ${detail}`, "client", res.status);
  }

  let content: unknown;
  try {
    content = JSON.parse(raw)?.choices?.[0]?.message?.content;
  } catch {
    throw new ProviderError(`${target.provider} returned non-JSON body`, "bad_response", res.status);
  }
  if (typeof content !== "string" || content.trim() === "") {
    throw new ProviderError(`${target.provider} returned empty completion`, "bad_response", res.status);
  }
  return content;
}
