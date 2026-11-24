// Token pacer: keeps calls under a provider's tokens-per-minute cap (e.g. Groq's
// free tier, ~8,000 TPM per model) by waiting before a call would exceed it,
// instead of hitting 429s and falling over to slower providers.
//
// Limits come from BATON_TPM_LIMITS, e.g. "groq=8000,groq:llama-3.1-8b-instant=6000".
// Usage is tracked per API key (hashed) and model over a sliding window.

import { createHash } from "node:crypto";
import type { ProviderTarget } from "../types.js";

const windowMs = () => Number(process.env.BATON_PACER_WINDOW_MS ?? 60_000);
/** Output tokens to reserve for the reply (the window counts input + output). */
export const outputReserve = () => Number(process.env.BATON_TPM_OUTPUT_RESERVE ?? 1500);
/** Longest the pacer will wait; beyond this it lets the call go and failover handles a 429. */
export const pacerMaxWaitMs = () => Number(process.env.BATON_PACER_MAX_WAIT_MS ?? 45_000);

const usage = new Map<string, Array<{ at: number; tokens: number }>>();
let now = () => Date.now();

function key(t: ProviderTarget, model: string) {
  return `${t.provider}|${t.baseUrl}|${createHash("sha256").update(t.apiKey).digest("hex").slice(0, 12)}|${model}`;
}

/** Tokens-per-minute cap for this provider/model, if configured. */
export function tpmLimit(provider: string, model: string): number | undefined {
  const raw = process.env.BATON_TPM_LIMITS ?? "groq=8000";
  let general: number | undefined;
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, value] = part.split("=");
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (name === `${provider}:${model}`) return n;
    if (name === provider) general = n;
  }
  return general;
}

function recent(k: string): Array<{ at: number; tokens: number }> {
  const t = now();
  const list = (usage.get(k) ?? []).filter((e) => t - e.at < windowMs());
  usage.set(k, list);
  return list;
}

/** Milliseconds to wait so that `needed` more tokens fit under the cap (0 = go now). */
export function pacerWait(t: ProviderTarget, model: string, needed: number): number {
  const limit = tpmLimit(t.provider, model);
  if (!limit || needed > limit) return 0; // no cap, or waiting can't help
  const list = recent(key(t, model)).sort((a, b) => a.at - b.at);
  let used = list.reduce((s, e) => s + e.tokens, 0);
  if (used + needed <= limit) return 0;
  for (const e of list) {
    used -= e.tokens;
    if (used + needed <= limit) return Math.max(0, e.at + windowMs() - now()) + 100;
  }
  return 0;
}

/** Record tokens a call actually used. */
export function recordTokens(t: ProviderTarget, model: string, tokens: number): void {
  if (!tpmLimit(t.provider, model) || tokens <= 0) return;
  recent(key(t, model)).push({ at: now(), tokens });
}

/** Tests only. */
export function resetPacer(clock?: () => number): void {
  usage.clear();
  now = clock ?? (() => Date.now());
}
