// Shared-context bookkeeping: who wrote each file, and exactly what each step
// was given. This is what makes the relay's hand-offs visible in the UI.

import { estimateTokens } from "../providers/client.js";
import type { BatonWorkspace, ChatMessage, ContextFile, StepContext } from "../types.js";

/** Cap on stored prompt text per step, so history files stay small. */
const MAX_STORED_PROMPT_CHARS = 200_000;

export function originLabel(ws: BatonWorkspace, path: string): string | undefined {
  const o = ws.artifactOrigins?.[path];
  return o ? `${o.provider}/${o.model}` : undefined;
}

export function contextFile(ws: BatonWorkspace, path: string): ContextFile {
  const o = ws.artifactOrigins?.[path];
  return {
    path,
    source: o && o.runId === ws.workspaceId ? "this-run" : "previous",
    by: o ? `${o.provider}/${o.model}` : undefined,
    tokens: estimateTokens(ws.artifacts[path] ?? ""),
  };
}

function storable(messages: ChatMessage[]): ChatMessage[] {
  let budget = MAX_STORED_PROMPT_CHARS;
  return messages.map((m) => {
    const content = m.content.length > budget ? `${m.content.slice(0, budget)}\n\n[... truncated for storage ...]` : m.content;
    budget = Math.max(0, budget - content.length);
    return { role: m.role, content };
  });
}

export function recordContext(
  ws: BatonWorkspace,
  ctx: Omit<StepContext, "goal" | "conversation" | "decisions" | "promptTokens" | "messages">,
  messages: ChatMessage[],
): void {
  const decisions: StepContext["decisions"] = {};
  for (const [k, v] of Object.entries(ws.metadata)) if (v !== undefined && v !== "") decisions[k] = v;
  (ws.contexts ??= []).push({
    ...ctx,
    goal: ws.userPrompt,
    conversation: ws.conversation ?? [],
    decisions,
    promptTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
    messages: storable(messages),
  });
}

/**
 * Older history records have no origins: recover them from "Generated <path>
 * successfully" log lines, which name the provider and model that wrote each file.
 */
export function originsFromLogs(
  runId: string,
  logs: Array<{ step: number; event: string; provider: string; model: string; message: string }>,
): BatonWorkspace["artifactOrigins"] {
  const out: NonNullable<BatonWorkspace["artifactOrigins"]> = {};
  for (const l of logs) {
    const m = l.event === "execute" ? /^Generated (.+) successfully$/.exec(l.message) : null;
    if (m) out[m[1]] = { provider: l.provider, model: l.model, runId, step: l.step };
  }
  return out;
}
