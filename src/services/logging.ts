import type { SkippedModel } from "../providers/client.js";
import type { BatonWorkspace, LogEvent, ProviderTarget } from "../types.js";

export function log(
  ws: BatonWorkspace,
  step: number,
  event: LogEvent,
  target: Pick<ProviderTarget, "provider" | "model">,
  message: string,
): void {
  ws.executionLogs.push({
    step,
    event,
    provider: target.provider,
    model: target.model,
    message,
    timestamp: new Date().toISOString(),
  });
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
