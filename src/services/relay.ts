// Stage 3: the resilient relay loop (spec §3).
// Explicit and imperative by design (guardrail 5): every prompt is built here,
// from the shared workspace, so any model can pick up where another stopped.

import { chatCompletion, ProviderError } from "../providers/client.js";
import type { BatonTask, BatonWorkspace, ChatMessage, ProviderTarget } from "../types.js";
import { log, logModelSwaps } from "./logging.js";
import { extractArtifactBody } from "./sanitize.js";

const DEFAULT_COOLDOWN_MS = 60_000;

const ROLE_BY_TYPE: Record<BatonWorkspace["taskType"], string> = {
  code: "a senior software engineer. Write complete, runnable source code",
  document: "a meticulous technical writer. Write complete, well-structured Markdown prose",
  analysis: "a rigorous data analyst. Write complete, reproducible analysis artifacts",
};

export function buildTaskMessages(ws: BatonWorkspace, task: BatonTask): ChatMessage[] {
  const decisions = Object.entries(ws.metadata)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const manifest = ws.tasks
    .map((t) => `- [${t.status === "completed" ? "x" : t.id === task.id ? ">" : " "}] ${t.targetArtifact} — ${t.title}`)
    .join("\n");

  const completed = ws.tasks
    .filter((t) => t.status === "completed" && ws.artifacts[t.targetArtifact] !== undefined)
    .map((t) => `=== ${t.targetArtifact} ===\n${ws.artifacts[t.targetArtifact]}`)
    .join("\n");

  const sections = [
    `## Project goal\n${ws.userPrompt}`,
    decisions && `## Architectural decisions (binding)\n${decisions}`,
    `## Artifact manifest ([x] done, [>] current)\n${manifest}`,
    completed && `## Completed artifacts (stay consistent with these)\n${completed}`,
    `## Your assignment\nProduce the full contents of \`${task.targetArtifact}\`: ${task.title}`,
  ].filter(Boolean);

  return [
    {
      role: "system",
      content:
        `You are ${ROLE_BY_TYPE[ws.taskType]}. You are one stage in a relay: earlier artifacts were written by other ` +
        "models and are authoritative. Output ONLY the complete contents of the requested artifact inside a single " +
        "fenced code block. No explanations before or after it, no placeholders, no ellipses.",
    },
    { role: "user", content: sections.join("\n\n") },
  ];
}

export interface RelayOptions {
  /** Ordered waterfall: index 0 is the sprint tier, later entries are fallbacks. */
  targets: ProviderTarget[];
  /** Shared across one orchestration so a rate-limited tier isn't hammered on every task. */
  cooldowns?: Map<string, number>;
  now?: () => number;
}

/** Runs every pending task. Returns true when all tasks completed. */
export async function runRelay(ws: BatonWorkspace, opts: RelayOptions): Promise<boolean> {
  const cooldowns = opts.cooldowns ?? new Map<string, number>();
  const now = opts.now ?? Date.now;
  const keyOf = (t: ProviderTarget) => `${t.provider}:${t.model}`;

  for (const task of ws.tasks) {
    if (task.status === "completed") continue;
    task.status = "in_progress";
    const messages = buildTaskMessages(ws, task);

    // Respect cooldowns, but never leave a task with zero candidates: if every
    // tier is cooling down, try them all anyway in waterfall order.
    const ready = opts.targets.filter((t) => (cooldowns.get(keyOf(t)) ?? 0) <= now());
    const candidates = ready.length > 0 ? ready : opts.targets;

    for (const [i, target] of candidates.entries()) {
      try {
        const result = await chatCompletion(target, messages);
        logModelSwaps(ws, task.id, target.provider, result.skippedModels);
        ws.artifacts[task.targetArtifact] = extractArtifactBody(result.content, task.targetArtifact);
        task.status = "completed";
        task.assignedProvider = target.provider;
        task.assignedModel = result.model;
        log(ws, task.id, "execute", { ...target, model: result.model }, `Generated ${task.targetArtifact} successfully`);
        break;
      } catch (err) {
        const pe =
          err instanceof ProviderError ? err : new ProviderError((err as Error).message ?? String(err), "network");
        logModelSwaps(ws, task.id, target.provider, pe.skippedModels);
        if (pe.kind === "rate_limit" || pe.kind === "server") {
          cooldowns.set(keyOf(target), now() + (pe.retryAfterMs ?? DEFAULT_COOLDOWN_MS));
        }
        const next = candidates[i + 1];
        log(
          ws,
          task.id,
          "failover",
          target,
          next
            ? `${pe.reason}; passing baton to ${next.provider === "google" ? "Google AI Studio" : next.provider}`
            : `${pe.reason}; no providers left for ${task.targetArtifact}`,
        );
      }
    }

    if (task.status !== "completed") task.status = "failed";
  }

  return ws.tasks.every((t) => t.status === "completed");
}
