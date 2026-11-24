import type { SkippedModel } from "../providers/client.js";
import type { BatonWorkspace, ExecutionLog, LogEvent, ModelUsage, ProviderTarget, RunUsage, TokenUsage, UsageTotals } from "../types.js";

export function log(
  ws: BatonWorkspace,
  step: number,
  event: LogEvent,
  target: Pick<ProviderTarget, "provider" | "model">,
  message: string,
  tokens?: TokenUsage,
): void {
  ws.executionLogs.push({
    step,
    event,
    provider: target.provider,
    model: target.model,
    message,
    timestamp: new Date().toISOString(),
    ...(tokens ? { tokens } : {}),
  });
}

const zero = (): UsageTotals => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 });

/** Add `t` into `into`. `calls` defaults to 1 for a single call's TokenUsage. */
function add(into: UsageTotals, t: TokenUsage & { calls?: number }) {
  into.promptTokens += t.promptTokens;
  into.completionTokens += t.completionTokens;
  into.totalTokens += t.totalTokens;
  into.calls += t.calls ?? 1;
  if (t.estimated) into.estimated = true;
}

function finish(total: UsageTotals, byProvider: Record<string, UsageTotals>, byModel: Map<string, ModelUsage>): RunUsage {
  return { total, byProvider, byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens) };
}

/** Sum every billed call in a run's log: overall, per provider and per model. */
export function sumUsage(logs: ExecutionLog[]): RunUsage {
  const total = zero();
  const byProvider: Record<string, UsageTotals> = {};
  const byModel = new Map<string, ModelUsage>();
  for (const l of logs) {
    if (!l.tokens) continue;
    add(total, l.tokens);
    add((byProvider[l.provider] ??= zero()), l.tokens);
    const key = `${l.provider}\u0000${l.model}`;
    if (!byModel.has(key)) byModel.set(key, { provider: l.provider, model: l.model, ...zero() });
    add(byModel.get(key)!, l.tokens);
  }
  return finish(total, byProvider, byModel);
}

/** Combine several runs' usage (e.g. "today" or "all time" across history). */
export function mergeUsage(list: RunUsage[]): RunUsage {
  const total = zero();
  const byProvider: Record<string, UsageTotals> = {};
  const byModel = new Map<string, ModelUsage>();
  for (const u of list) {
    add(total, u.total);
    for (const [p, t] of Object.entries(u.byProvider)) add((byProvider[p] ??= zero()), t);
    for (const m of u.byModel ?? []) {
      const key = `${m.provider}\u0000${m.model}`;
      if (!byModel.has(key)) byModel.set(key, { provider: m.provider, model: m.model, ...zero() });
      add(byModel.get(key)!, m);
    }
  }
  return finish(total, byProvider, byModel);
}

/** Log each retired or overloaded model a provider stepped past before it answered or gave up. */
export function logModelSwaps(ws: BatonWorkspace, step: number, provider: string, skipped: SkippedModel[]): void {
  for (const s of skipped) {
    log(
      ws,
      step,
      "failover",
      { provider, model: s.model },
      s.next
        ? `${s.reason}; retrying with ${s.next}${s.afterMs ? ` in ${Math.round(s.afterMs / 100) / 10}s` : ""}${
            s.nextDiscovered ? ` (picked from ${provider}'s current model list)` : ""
          }`
        : `${s.reason}; no more ${provider} models to try`,
    );
  }
}
