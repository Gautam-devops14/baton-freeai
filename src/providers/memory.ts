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
/** Providers to skip for a while, with the reason shown in logs. */
const busyUntil = new Map<string, { until: number; reason: string }>(); // account -> skip info

/** Why a provider is being skipped; each has its own default duration. */
export const SKIP_REASONS = {
  busy: "every model was busy (503) in the last few minutes",
  dailyLimit: "its free daily limit is used up",
  keyRejected: "its API key was rejected (401/403); check it in Settings",
  noCredit: "the account has no credit",
  noModels: "none of its models are available any more",
} as const;

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
function skipInfo(t: ProviderTarget): { until: number; reason: string } | undefined {
  const info = busyUntil.get(account(t));
  if (!info) return undefined;
  if (info.until <= now()) {
    busyUntil.delete(account(t));
    return undefined;
  }
  return info;
}

export function busyUntilFor(t: ProviderTarget): number | undefined {
  return skipInfo(t)?.until;
}

/** Skip this provider (for this API key) for a while. Defaults: 5 min, reason "busy". */
export function markProviderBusy(t: ProviderTarget, forMs?: number, reason: string = SKIP_REASONS.busy): void {
  const ms = forMs ?? busySkipMs();
  if (ms > 0) busyUntil.set(account(t), { until: now() + ms, reason });
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
  skipped: Array<{ target: ProviderTarget; until: number; reason: string }>;
} {
  const skipped: Array<{ target: ProviderTarget; until: number; reason: string }> = [];
  const ready = targets.filter((t) => {
    const info = skipInfo(t);
    if (info) skipped.push({ target: t, until: info.until, reason: info.reason });
    return !info;
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
    busyProviders: [...busyUntil].filter(([, b]) => b.until > t).map(([k, b]) => {
      const a = split(k);
      return { provider: a.provider, host: a.host, keyHash: a.keyHash, until: new Date(b.until).toISOString(), reason: b.reason };
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
