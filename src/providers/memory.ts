// Cross-run provider memory (lives as long as the server process).
//
// Real runs showed every request re-learning the same facts: the same retired
// models answering 404, the same /models discovery, the same overloaded Gemini.
// This remembers them between requests:
//  - retired models: skipped for BATON_DEAD_MODEL_TTL_MS (default 24h)
//  - discovered replacements: reused for the same 24h
//  - busy providers (every model answered 503): skipped for BATON_BUSY_SKIP_MS
//    (default 5 min), unless no other provider is left
//
// Model access can differ per account, so entries are keyed by provider, base
// URL and a short hash of the API key (never the key itself).

import { createHash } from "node:crypto";
import type { ProviderTarget } from "../types.js";

const deadTtlMs = () => Number(process.env.BATON_DEAD_MODEL_TTL_MS ?? 24 * 3600_000);
const busySkipMs = () => Number(process.env.BATON_BUSY_SKIP_MS ?? 5 * 60_000);

const deadModels = new Map<string, number>(); // `${account}|${model}` -> expiresAt
const discovered = new Map<string, { model: string; expiresAt: number }>(); // account -> model
const busyUntil = new Map<string, number>(); // account -> until

let now = () => Date.now();

function account(t: Pick<ProviderTarget, "provider" | "baseUrl" | "apiKey">): string {
  const keyHash = createHash("sha256").update(t.apiKey).digest("hex").slice(0, 12);
  return `${t.provider}|${t.baseUrl}|${keyHash}`;
}

export function isModelDead(t: ProviderTarget, model: string): boolean {
  const k = `${account(t)}|${model}`;
  const exp = deadModels.get(k);
  if (exp === undefined) return false;
  if (exp <= now()) {
    deadModels.delete(k);
    return false;
  }
  return true;
}

export function markModelDead(t: ProviderTarget, model: string): void {
  deadModels.set(`${account(t)}|${model}`, now() + deadTtlMs());
  const d = discovered.get(account(t));
  if (d?.model === model) discovered.delete(account(t));
}

export function getDiscoveredModel(t: ProviderTarget): string | undefined {
  const d = discovered.get(account(t));
  if (!d) return undefined;
  if (d.expiresAt <= now() || isModelDead(t, d.model)) {
    discovered.delete(account(t));
    return undefined;
  }
  return d.model;
}

export function rememberDiscoveredModel(t: ProviderTarget, model: string): void {
  discovered.set(account(t), { model, expiresAt: now() + deadTtlMs() });
}

/** When a provider stays skipped until, or undefined if it isn't marked busy. */
export function busyUntilFor(t: ProviderTarget): number | undefined {
  const until = busyUntil.get(account(t));
  if (until === undefined) return undefined;
  if (until <= now()) {
    busyUntil.delete(account(t));
    return undefined;
  }
  return until;
}

export function markProviderBusy(t: ProviderTarget): void {
  const ms = busySkipMs();
  if (ms > 0) busyUntil.set(account(t), now() + ms);
}

export function clearProviderBusy(t: ProviderTarget): void {
  busyUntil.delete(account(t));
}

/**
 * Split a waterfall into providers to try now and ones to skip because they
 * were busy moments ago. Never returns an empty `ready` list: if every
 * provider is marked busy, all of them are tried anyway.
 */
export function splitBusy(targets: ProviderTarget[]): {
  ready: ProviderTarget[];
  skipped: Array<{ target: ProviderTarget; until: number }>;
} {
  const skipped: Array<{ target: ProviderTarget; until: number }> = [];
  const ready = targets.filter((t) => {
    const until = busyUntilFor(t);
    if (until !== undefined) skipped.push({ target: t, until });
    return until === undefined;
  });
  return ready.length ? { ready, skipped } : { ready: targets, skipped: [] };
}

/** What Baton currently remembers, for the debug panel. Accounts show provider + a short key hash only. */
export function snapshotMemory() {
  const t = now();
  const split = (k: string) => {
    const [provider, baseUrl, keyHash, ...rest] = k.split("|");
    return { provider, host: (() => { try { return new URL(baseUrl).host; } catch { return baseUrl; } })(), keyHash, rest: rest.join("|") };
  };
  return {
    retiredModels: [...deadModels].filter(([, exp]) => exp > t).map(([k, exp]) => {
      const a = split(k);
      return { provider: a.provider, host: a.host, keyHash: a.keyHash, model: a.rest, until: new Date(exp).toISOString() };
    }),
    discoveredModels: [...discovered].filter(([, d]) => d.expiresAt > t).map(([k, d]) => {
      const a = split(k);
      return { provider: a.provider, host: a.host, keyHash: a.keyHash, model: d.model, until: new Date(d.expiresAt).toISOString() };
    }),
    busyProviders: [...busyUntil].filter(([, u]) => u > t).map(([k, u]) => {
      const a = split(k);
      return { provider: a.provider, host: a.host, keyHash: a.keyHash, until: new Date(u).toISOString() };
    }),
  };
}

/** Debug panel: forget everything Baton learned about providers. */
export function forgetProviderMemory(): void {
  deadModels.clear();
  discovered.clear();
  busyUntil.clear();
}

/** Tests only: forget everything, optionally with a fake clock. */
export function resetProviderMemory(clock?: () => number): void {
  deadModels.clear();
  discovered.clear();
  busyUntil.clear();
  now = clock ?? (() => Date.now());
}
