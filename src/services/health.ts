// Provider health: how each provider/model has been doing, from the calls
// recorded on saved runs, plus whatever Baton is currently skipping.

import type { CallTrace } from "../types.js";

export interface ModelHealth {
  provider: string;
  model: string;
  calls: number;
  ok: number;
  successRate: number;
  /** Average time of successful calls. */
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  tokens: number;
  /** Failures by kind, e.g. { rate_limit: 3, timeout: 1 }. */
  failures: Record<string, number>;
  lastOkAt?: string;
  lastError?: { at: string; outcome: string; detail?: string; status?: number };
}

export function computeHealth(calls: CallTrace[]): ModelHealth[] {
  const by = new Map<string, CallTrace[]>();
  for (const c of calls) {
    if (c.phase !== "end") continue;
    const k = `${c.provider}\u0000${c.model}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(c);
  }
  const rows: ModelHealth[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const ok = list.filter((c) => c.outcome === "ok");
    const lat = ok.map((c) => c.latencyMs ?? 0).sort((a, b) => a - b);
    const failures: Record<string, number> = {};
    for (const c of list) if (c.outcome !== "ok") failures[c.outcome ?? "error"] = (failures[c.outcome ?? "error"] ?? 0) + 1;
    const lastErr = [...list].reverse().find((c) => c.outcome !== "ok");
    rows.push({
      provider: list[0].provider,
      model: list[0].model,
      calls: list.length,
      ok: ok.length,
      successRate: list.length ? ok.length / list.length : 0,
      ...(lat.length ? { avgLatencyMs: Math.round(lat.reduce((s, n) => s + n, 0) / lat.length), p95LatencyMs: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] } : {}),
      tokens: ok.reduce((s, c) => s + (c.tokens?.totalTokens ?? 0), 0),
      failures,
      ...(ok.length ? { lastOkAt: ok[ok.length - 1].at } : {}),
      ...(lastErr ? { lastError: { at: lastErr.at, outcome: lastErr.outcome ?? "error", detail: lastErr.detail, status: lastErr.status } } : {}),
    });
  }
  return rows.sort((a, b) => a.provider.localeCompare(b.provider) || b.calls - a.calls);
}
