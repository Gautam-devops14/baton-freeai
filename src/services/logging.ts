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
