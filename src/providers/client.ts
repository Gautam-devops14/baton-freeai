// Unified OpenAI-compatible chat client (spec §5, guardrails 1 & 3).
// One fetch helper for every provider; no vendor SDKs.

import type { ChatMessage, ProviderTarget } from "../types.js";

export const DEFAULT_TIMEOUT_MS = Number(process.env.BATON_PROVIDER_TIMEOUT_MS ?? 30_000);

export type ProviderErrorKind =
  | "model_unavailable"
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
}

const RATE_LIMIT_TEXT = /rate.?limit|quota|too many requests|resource.?exhausted/i;

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
}

export interface ChatResult {
  content: string;
  /** The model that actually produced `content` (may be a fallback model). */
  model: string;
  /** Models tried first and skipped because the provider no longer serves them. */
  skippedModels: SkippedModel[];
}

/**
 * Send a chat request, walking the target's model list: `target.model` first,
 * then each of `target.fallbackModels`. A model the provider reports as gone
 * (HTTP 404 or a "no longer available" message) is skipped in favour of the next
 * one and remembered on the target, so later calls in the same run go straight
 * to a working model. Any other error (429, timeout, auth...) is thrown
 * immediately so the relay can fail over to a different provider.
 */
export async function chatCompletion(
  target: ProviderTarget,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const unavailable = (target.unavailableModels ??= new Set<string>());
  const models = [target.model, ...(target.fallbackModels ?? [])].filter(
    (m, i, all) => all.indexOf(m) === i && !unavailable.has(m),
  );
  const skippedModels: SkippedModel[] = [];
  let lastError: ProviderError | undefined;

  for (const [i, model] of models.entries()) {
    try {
      const content = await requestOnce(target, model, messages, opts);
      return { content, model, skippedModels };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind !== "model_unavailable") {
        // e.g. the fallback model is rate limited: surface it, but keep the swap history.
        throw new ProviderError(err.message, err.kind, err.status, err.retryAfterMs, skippedModels);
      }
      unavailable.add(model);
      skippedModels.push({ model, reason: err.reason, next: models[i + 1] });
      lastError = err;
    }
  }

  const tried = [target.model, ...(target.fallbackModels ?? [])].join(", ");
  throw new ProviderError(
    `${target.provider} has no available models (tried: ${tried})${lastError ? `: ${lastError.message}` : ""}`,
    "model_unavailable",
    lastError?.status ?? 404,
    undefined,
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
    temperature: opts.temperature ?? 0.2,
  };
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
    if (res.status === 429 || RATE_LIMIT_TEXT.test(detail)) {
      throw new ProviderError(`${target.provider} rate limited: ${detail}`, "rate_limit", res.status, retryAfterMs);
    }
    if (res.status === 404 || ((res.status === 400 || res.status === 410) && MODEL_UNAVAILABLE_TEXT.test(detail))) {
      throw new ProviderError(`${target.provider} model ${model} unavailable: ${detail}`, "model_unavailable", res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(`${target.provider} auth failed: ${detail}`, "auth", res.status);
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
