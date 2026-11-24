import type { SkippedModel } from "../providers/client.js";
import type { BatonWorkspace, CallTrace, ExecutionLog, LogEvent, ModelUsage, ProviderTarget, RunUsage, TokenBreakdown, TokenUsage, UsageTotals } from "../types.js";

export function log(
  ws: BatonWorkspace,
  step: number,
  event: LogEvent,
  target: Pick<ProviderTarget, "provider" | "model">,
  message: string,
  tokens?: TokenUsage,
): void {
  const entry = {
    step,
    event,
    provider: target.provider,
    model: target.model,
    message,
    timestamp: new Date().toISOString(),
    ...(tokens ? { tokens } : {}),
  };
  ws.executionLogs.push(entry);
  ws.emit?.({ type: "log", entry });
}

/** Trace options for provider calls made on behalf of one step: stored on the run and streamed live. */
export function traceFor(ws: BatonWorkspace, step: number) {
  return {
    traceMeta: { runId: ws.workspaceId, step },
    onWait: (_ms: number, message: string, provider: string, model: string) => log(ws, step, "failover", { provider, model }, message),
    onTrace: (call: CallTrace) => {
      if (call.phase === "end") (ws.calls ??= []).push(call);
      const { reply: _reply, ...light } = call; // the full reply is stored, not streamed
      ws.emit?.({ type: "call", call: light });
    },
  };
}

export const zeroBreakdown = (): TokenBreakdown => ({
  understanding: 0, instructions: 0, request: 0, context: 0, code: 0, otherText: 0, thinking: 0, wasted: 0,
});

/** Attach a breakdown to the most recent successful call for this step and model. */
export function attachBreakdown(ws: BatonWorkspace, step: number, model: string, breakdown: Partial<TokenBreakdown>): void {
  const call = [...(ws.calls ?? [])].reverse().find((c) => c.step === step && c.model === model && c.outcome === "ok" && !c.breakdown);
  if (call) call.breakdown = { ...zeroBreakdown(), ...breakdown };
}

/** Add up several runs' breakdowns (e.g. today / all time). */
export function mergeBreakdowns(list: Array<TokenBreakdown | undefined>): TokenBreakdown {
  const total = zeroBreakdown();
  for (const b of list) if (b) for (const k of Object.keys(total) as Array<keyof TokenBreakdown>) total[k] += b[k] ?? 0;
  return total;
}

/** Sum the per-call breakdowns of a run. */
export function sumBreakdown(calls: CallTrace[] | undefined): TokenBreakdown | undefined {
  const withB = (calls ?? []).filter((c) => c.breakdown);
  if (!withB.length) return undefined;
  const total = zeroBreakdown();
  for (const c of withB) for (const k of Object.keys(total) as Array<keyof TokenBreakdown>) total[k] += c.breakdown![k] ?? 0;
  return total;
}

/**
 * Split one build call's tokens by purpose.
 *  input:  the reported input total, shared out by each prompt section's share of the text
 *  output: thinking (reported or estimated) + the file's share of the visible reply + the rest
 */
export function buildCallBreakdown(
  usage: TokenUsage,
  sections: { instructions: number; request: number; context: number },
  fileChars: number,
  replyChars: number,
): Partial<TokenBreakdown> {
  const totalChars = sections.instructions + sections.request + sections.context || 1;
  const share = (n: number) => Math.round((usage.promptTokens * n) / totalChars);
  const instructions = share(sections.instructions);
  const request = share(sections.request);
  const context = Math.max(0, usage.promptTokens - instructions - request);
  const thinking = Math.min(usage.reasoningTokens ?? 0, usage.completionTokens);
  const visible = Math.max(0, usage.completionTokens - thinking);
  const code = Math.round(visible * Math.min(1, fileChars / Math.max(1, replyChars)));
  return { instructions, request, context, code, otherText: visible - code, thinking };
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

/** Log that a provider is being skipped because it was busy (503) moments ago. */
export function logBusySkips(
  ws: BatonWorkspace,
  step: number,
  skipped: Array<{ target: Pick<ProviderTarget, "provider" | "model">; until: number; reason?: string }>,
): void {
  for (const { target, until, reason } of skipped) {
    const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    log(ws, step, "failover", target, `skipped: ${target.provider}: ${reason ?? "busy"}; will try it again after ${at}`);
  }
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
