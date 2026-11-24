// Stage 2: structured task planning (spec §3).
// Planning is isolated from generation (guardrail 4) so the blueprint survives
// even if a later generation call fails or runs out of tokens.

import { chatCompletion, ProviderError } from "../providers/client.js";
import type { BatonTask, BatonWorkspace, ChatMessage, ProviderTarget } from "../types.js";
import { safeArtifactPath } from "./paths.js";
import { log, logModelSwaps } from "./logging.js";

export const MIN_TASKS = 2;
export const MAX_TASKS = 4;

const TASK_TYPE_GUIDANCE: Record<BatonWorkspace["taskType"], string> = {
  code: 'Artifacts are source files with relative paths (e.g. "package.json", "src/auth.js"). Decide "primaryLanguage" and "framework".',
  document: 'Artifacts are Markdown chapters (e.g. "overview.md", "methodology.md"). Decide "tone" and "audience".',
  analysis:
    'Artifacts are analysis deliverables such as "data/sample.csv", "analysis.py", or "findings.md". Decide "primaryLanguage" and "methodology".',
};

export function buildPlannerMessages(ws: BatonWorkspace): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the Task Architect for Baton, a multi-model build relay.",
        `Decompose the user's objective into ${MIN_TASKS} to ${MAX_TASKS} atomic artifacts. Each task produces exactly ONE artifact.`,
        TASK_TYPE_GUIDANCE[ws.taskType],
        "Order tasks so that dependencies come before the artifacts that consume them.",
        "Respond with ONLY a JSON object, no prose, matching:",
        '{"decisions": {"<key>": "<string value>", ...}, "tasks": [{"title": "<what to build>", "targetArtifact": "<relative path>"}]}',
      ].join("\n"),
    },
    { role: "user", content: `Task type: ${ws.taskType}\nObjective: ${ws.userPrompt}` },
  ];
}

/** Pull the first JSON object out of a reply, tolerating fences or stray prose. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in planner reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface ParsedPlan {
  metadata: BatonWorkspace["metadata"];
  tasks: BatonTask[];
}

export function parsePlan(text: string): ParsedPlan {
  const data = extractJson(text) as { decisions?: unknown; tasks?: unknown };

  const metadata: BatonWorkspace["metadata"] = {};
  if (data.decisions && typeof data.decisions === "object") {
    for (const [k, v] of Object.entries(data.decisions as Record<string, unknown>)) {
      if (["string", "number", "boolean"].includes(typeof v)) metadata[k] = v as string | number | boolean;
    }
  }

  if (!Array.isArray(data.tasks)) throw new Error("planner reply has no tasks array");
  const seen = new Set<string>();
  const tasks: BatonTask[] = [];
  for (const raw of data.tasks) {
    const t = raw as { title?: unknown; targetArtifact?: unknown };
    if (typeof t?.title !== "string" || typeof t?.targetArtifact !== "string") continue;
    const path = safeArtifactPath(t.targetArtifact);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    tasks.push({ id: tasks.length + 1, title: t.title.trim(), targetArtifact: path, status: "pending" });
    if (tasks.length === MAX_TASKS) break;
  }
  if (tasks.length < MIN_TASKS) {
    throw new Error(`planner produced ${tasks.length} valid task(s); need at least ${MIN_TASKS}`);
  }
  return { metadata, tasks };
}

/**
 * Plan the workspace. `targets` is tried in order — Gemini is the designated
 * architect; any further targets are a safety net so a single rate limit
 * doesn't kill the whole request before it starts.
 */
export async function planWorkspace(ws: BatonWorkspace, targets: ProviderTarget[]): Promise<void> {
  const messages = buildPlannerMessages(ws);
  let lastError: unknown;

  for (const [i, target] of targets.entries()) {
    try {
      const result = await chatCompletion(target, messages, { jsonMode: true, temperature: 0.1 });
      logModelSwaps(ws, 0, target.provider, result.skippedModels);
      const plan = parsePlan(result.content);
      ws.metadata = { ...ws.metadata, ...plan.metadata };
      ws.tasks = plan.tasks;
      log(ws, 0, "plan", { ...target, model: result.model }, `Project decomposed into ${plan.tasks.length} milestones`);
      return;
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError) logModelSwaps(ws, 0, target.provider, err.skippedModels);
      const reason = err instanceof ProviderError ? err.reason : `invalid plan (${(err as Error).message})`;
      const next = targets[i + 1];
      log(
        ws,
        0,
        "failover",
        target,
        next ? `${reason}; passing planning to ${next.provider}` : `${reason}; no planners left`,
      );
    }
  }
  throw new PlanningError(lastError);
}

export class PlanningError extends Error {
  constructor(readonly cause: unknown) {
    super(`Planning failed: ${(cause as Error)?.message ?? cause}`);
    this.name = "PlanningError";
  }
}
