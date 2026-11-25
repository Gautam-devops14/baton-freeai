// Circuit breaker per provider account (provider + base URL + short key hash).
//
//   CLOSED    normal: every call goes through.
//   OPEN      3 errors in a row (429, 503, timeout): skipped instantly (0 ms) for 45s.
//   HALF_OPEN after the cool-down, exactly one trial call goes through.
//             Success -> CLOSED. Failure -> OPEN again, this time for 60s.
//
// This stops Baton from waiting 12s on a dead provider for every file.

import { createHash } from "node:crypto";
import type { ProviderTarget } from "../types.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface Circuit {
  state: CircuitState;
  failures: number;
  openUntil: number;
  probeInFlight: boolean;
}

const envNum = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(n) ? n : dflt;
};
/** Consecutive failures that trip the circuit (0 turns the breaker off). */
export const tripThreshold = () => envNum("BATON_CIRCUIT_FAILS", 3);
export const openMs = () => envNum("BATON_CIRCUIT_OPEN_MS", 45_000);
export const reopenMs = () => envNum("BATON_CIRCUIT_REOPEN_MS", 60_000);

const circuits = new Map<string, Circuit>();
let now = () => Date.now();

const keyOf = (t: Pick<ProviderTarget, "provider" | "baseUrl" | "apiKey">) =>
  `${t.provider}|${t.baseUrl}|${createHash("sha256").update(t.apiKey).digest("hex").slice(0, 12)}`;

const get = (t: ProviderTarget): Circuit => {
  const k = keyOf(t);
  let c = circuits.get(k);
  if (!c) circuits.set(k, (c = { state: "CLOSED", failures: 0, openUntil: 0, probeInFlight: false }));
  return c;
};

/** Current state, without claiming the half-open probe. */
export function circuitState(t: ProviderTarget): CircuitState {
  const c = circuits.get(keyOf(t));
  if (!c) return "CLOSED";
  if (c.state === "OPEN" && now() >= c.openUntil) return "HALF_OPEN";
  return c.state;
}

/**
 * May a call go to this provider now? Claims the single half-open probe when the cool-down is over.
 * Returns `{ ok: false, retryInMs }` while the circuit is open (or a probe is already running).
 */
export function circuitAllows(t: ProviderTarget): { ok: true; probe: boolean } | { ok: false; retryInMs: number; failures: number } {
  if (tripThreshold() <= 0) return { ok: true, probe: false };
  const c = get(t);
  if (c.state === "CLOSED") return { ok: true, probe: false };
  if (c.state === "OPEN" && now() < c.openUntil) return { ok: false, retryInMs: c.openUntil - now(), failures: c.failures };
  // Cool-down over: exactly one trial request.
  if (c.probeInFlight) return { ok: false, retryInMs: 1000, failures: c.failures };
  c.state = "HALF_OPEN";
  c.probeInFlight = true;
  return { ok: true, probe: true };
}

export function recordSuccess(t: ProviderTarget): void {
  const c = circuits.get(keyOf(t));
  if (c) circuits.set(keyOf(t), { state: "CLOSED", failures: 0, openUntil: 0, probeInFlight: false });
}

/** A counted failure (429, 503, timeout). Returns the new state. */
export function recordFailure(t: ProviderTarget): CircuitState {
  if (tripThreshold() <= 0) return "CLOSED";
  const c = get(t);
  c.failures++;
  if (c.state === "HALF_OPEN") {
    c.state = "OPEN";
    c.openUntil = now() + reopenMs();
  } else if (c.failures >= tripThreshold()) {
    c.state = "OPEN";
    c.openUntil = now() + openMs();
  }
  c.probeInFlight = false;
  return c.state;
}

/** The call ended without a verdict (Stop pressed, or a non-counted error): free the probe slot. */
export function releaseProbe(t: ProviderTarget): void {
  const c = circuits.get(keyOf(t));
  if (c?.probeInFlight) {
    c.probeInFlight = false;
    if (c.state === "HALF_OPEN") {
      c.state = "OPEN";
      c.openUntil = now(); // next call may probe again straight away
    }
  }
}

/** For the debug panel: providers whose circuit isn't CLOSED. */
export function snapshotCircuits() {
  return [...circuits.entries()]
    .filter(([, c]) => c.state !== "CLOSED" || c.failures > 0)
    .map(([k, c]) => ({ provider: k.split("|")[0], keyHash: k.split("|")[2], state: c.state === "OPEN" && now() >= c.openUntil ? "HALF_OPEN" : c.state, failures: c.failures, retryInMs: Math.max(0, c.openUntil - now()) }));
}

export function resetCircuits(clock?: () => number): void {
  circuits.clear();
  now = clock ?? (() => Date.now());
}
