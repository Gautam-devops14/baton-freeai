import type { SkippedModel } from "../providers/client.js";
import type { BatonWorkspace, ExecutionLog, LogEvent, ProviderTarget, RunUsage, TokenUsage } from "../types.js";

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

const zero = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

function add(into: TokenUsage, t: TokenUsage) {
  into.promptTokens += t.promptTokens;
  into.completionTokens += t.completionTokens;
  into.totalTokens += t.totalTokens;
  if (t.estimated) into.estimated = true;
}

/** Sum every billed call in a run's log: overall and per provider. */
export function sumUsage(logs: ExecutionLog[]): RunUsage {
  const usage: RunUsage = { total: zero(), byProvider: {} };
  for (const l of logs) {
    if (!l.tokens) continue;
    add(usage.total, l.tokens);
    add((usage.byProvider[l.provider] ??= zero()), l.tokens);
  }
  return usage;
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
        ? `${s.reason}; retrying with ${s.next}${s.afterMs ? ` in ${Math.round(s.afterMs / 100) / 10}s` : ""}`
        : `${s.reason}; no more ${provider} models to try`,
    );
  }
}
