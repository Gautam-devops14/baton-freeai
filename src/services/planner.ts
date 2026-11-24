// Stage 2: structured task planning (spec §3).
// Planning is isolated from generation (guardrail 4) so the blueprint survives
// even if a later generation call fails or runs out of tokens.

import { chatCompletion, ProviderError } from "../providers/client.js";
import type { BatonTask, BatonWorkspace, ChatMessage, ProviderTarget } from "../types.js";
import { safeArtifactPath } from "./paths.js";
import { splitBusy } from "../providers/memory.js";
import { contextFile, recordContext } from "./context.js";
import { log, logBusySkips, logModelSwaps, traceFor } from "./logging.js";

/** We ask for 2-4 tasks (spec), but accept a 1-task plan rather than failing a small request. */
export const MIN_TASKS = 2;
export const MAX_TASKS = 4;
export const MIN_ACCEPTED_TASKS = 1;

const PATH_KEYS = ["targetArtifact", "target_artifact", "artifact", "file", "filename", "fileName", "filePath", "file_path", "path", "target"];
const TITLE_KEYS = ["title", "name", "task", "description", "summary", "goal"];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic)$/i;
const OTHER_BINARY_EXT = /\.(pdf|zip|gz|tgz|rar|7z|tar|exe|dll|so|dylib|bin|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|mov|avi|webm|psd|ai|sketch|docx?|xlsx?|pptx?|jar|class|wasm|sqlite|db)$/i;

/** Binary files can't come out of a text model: images become .svg, anything else is dropped. */
export function textOnlyPath(path: string): string | null {
  if (IMAGE_EXT.test(path)) return path.replace(IMAGE_EXT, ".svg");
  if (OTHER_BINARY_EXT.test(path)) return null;
  return path;
}

const firstString = (o: Record<string, unknown>, keys: string[]) =>
  keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");

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
        "Every artifact must be a plain-text file (source code, HTML, CSS, JSON, Markdown, CSV, SVG...). " +
          "Never plan binary files such as .png, .jpg, .gif, .ico, .pdf, .zip or fonts: a text model cannot produce them. " +
          "Draw logos, icons and illustrations as SVG (a .svg file or inline <svg> in HTML).",
        "Order tasks so that dependencies come before the artifacts that consume them.",
        "Respond with ONLY a JSON object, no prose, matching:",
        '{"decisions": {"<key>": "<string value>", ...}, "tasks": [{"title": "<what to build>", "targetArtifact": "<relative path>"}]}',
      ].join("\n"),
    },
    { role: "user", content: plannerUserMessage(ws) },
  ];
}

/** Planner input: the request, plus (for follow-ups) the earlier requests and the existing files. */
export const MAX_PLANNER_FILE_CHARS = 40_000;

function existingFilesForPlanner(ws: BatonWorkspace): { included: string[]; listed: string[] } {
  let budget = MAX_PLANNER_FILE_CHARS;
  const included: string[] = [];
  const listed: string[] = [];
  for (const [path, content] of Object.entries(ws.artifacts)) {
    if (content.length <= budget) {
      included.push(path);
      budget -= content.length;
    } else listed.push(path);
  }
  return { included, listed };
}

function plannerUserMessage(ws: BatonWorkspace): string {
  const files = Object.keys(ws.artifacts);
  if (!ws.conversation?.length && files.length === 0) {
    return `Task type: ${ws.taskType}\nObjective: ${ws.userPrompt}`;
  }
  const { included, listed } = existingFilesForPlanner(ws);
  return [
    `Task type: ${ws.taskType}`,
    "This is a FOLLOW-UP to an existing project. Change the existing files to satisfy the new request.",
    `## Earlier requests (oldest first)\n${(ws.conversation ?? []).map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
    `## New request\n${ws.userPrompt}`,
    `## Existing project files\n${files.map((f) => `- ${f}`).join("\n")}`,
    included.length ? `## Current contents\n${included.map((f) => `=== ${f} ===\n${ws.artifacts[f]}`).join("\n")}` : "",
    listed.length ? `(Contents of ${listed.join(", ")} omitted for length.)` : "",
    "## Rules for follow-ups\n" +
      "- Plan ONLY the files that must change or be added for the new request (1 to 4).\n" +
      "- To change an existing file, use its exact existing path; it will be rewritten in full.\n" +
      "- Keep the project's existing language, framework and structure.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Pull the first JSON object (or array) out of a reply, tolerating fences or stray prose. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const obj = candidate.indexOf("{");
  const arr = candidate.indexOf("[");
  const [open, close] = arr !== -1 && (obj === -1 || arr < obj) ? ["[", "]"] : ["{", "}"];
  const start = candidate.indexOf(open);
  const end = candidate.lastIndexOf(close);
  if (start === -1 || end <= start) throw new Error("no JSON object in planner reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface ParsedPlan {
  metadata: BatonWorkspace["metadata"];
  tasks: BatonTask[];
}

export function parsePlan(text: string): ParsedPlan {
  const parsed = extractJson(text) as Record<string, unknown> | unknown[];
  // Models don't always follow the schema exactly: accept a bare array, or tasks under a near-miss key.
  const data = (Array.isArray(parsed) ? { tasks: parsed } : parsed) as Record<string, unknown>;
  const rawTasks = ["tasks", "milestones", "steps", "artifacts", "files", "plan"].map((k) => data[k]).find(Array.isArray);
  const decisions = data.decisions ?? data.architecture ?? data.metadata;

  const metadata: BatonWorkspace["metadata"] = {};
  if (decisions && typeof decisions === "object") {
    for (const [k, v] of Object.entries(decisions as Record<string, unknown>)) {
      if (["string", "number", "boolean"].includes(typeof v)) metadata[k] = v as string | number | boolean;
    }
  }

  if (!rawTasks) throw new Error("planner reply has no tasks array");
  const seen = new Set<string>();
  const tasks: BatonTask[] = [];
  for (const raw of rawTasks) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const rawPath = firstString(t, PATH_KEYS);
    if (!rawPath) continue;
    const safe = safeArtifactPath(rawPath);
    const path = safe ? textOnlyPath(safe) : null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const title = firstString(t, TITLE_KEYS)?.trim() ?? `Write ${path}`;
    tasks.push({ id: tasks.length + 1, title, targetArtifact: path, status: "pending" });
    if (tasks.length === MAX_TASKS) break;
  }
  if (tasks.length < MIN_ACCEPTED_TASKS) {
    throw new Error("planner produced no usable tasks (each needs a file path)");
  }
  return { metadata, tasks };
}

/**
 * Plan the workspace. `targets` is tried in order — Gemini is the designated
 * architect; any further targets are a safety net so a single rate limit
 * doesn't kill the whole request before it starts.
 */
export async function planWorkspace(ws: BatonWorkspace, allTargets: ProviderTarget[]): Promise<void> {
  const messages = buildPlannerMessages(ws);
  const { included, listed } = existingFilesForPlanner(ws);
  recordContext(
    ws,
    { step: 0, kind: "plan", manifest: [...included, ...listed], files: included.map((p) => contextFile(ws, p)) },
    messages,
  );
  const { ready: targets, skipped } = splitBusy(allTargets);
  logBusySkips(ws, 0, skipped);
  let lastError: unknown;
  const attempts: PlanAttempt[] = [];

  for (const [i, target] of targets.entries()) {
    // Kept outside `try` so tokens are still counted when the reply is an unusable plan.
    let result: Awaited<ReturnType<typeof chatCompletion>> | undefined;
    try {
      result = await chatCompletion(target, messages, {
        jsonMode: true,
        temperature: 0.1,
        retryOverloaded: i === targets.length - 1, // nobody left to hand off to: worth a short wait
        ...traceFor(ws, 0),
      });
      logModelSwaps(ws, 0, target.provider, result.skippedModels);
      const plan = parsePlan(result.content);
      ws.metadata = { ...ws.metadata, ...plan.metadata };
      ws.tasks = plan.tasks;
      ws.emit?.({ type: "plan", tasks: plan.tasks.map((t) => ({ id: t.id, targetArtifact: t.targetArtifact, title: t.title })) });
      log(ws, 0, "plan", { ...target, model: result.model }, `Project decomposed into ${plan.tasks.length} milestone${plan.tasks.length === 1 ? "" : "s"}`, result.usage);
      return;
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError) logModelSwaps(ws, 0, target.provider, err.skippedModels);
      const reason = err instanceof ProviderError ? err.reason : `invalid plan (${(err as Error).message})`;
      attempts.push({ provider: target.provider, kind: err instanceof ProviderError ? err.kind : "invalid_plan", reason });
      const next = targets[i + 1];
      log(
        ws,
        0,
        "failover",
        {
          ...target,
          model: result?.model ?? (err instanceof ProviderError ? err.skippedModels.at(-1)?.model : undefined) ?? target.model,
        },
        next ? `${reason}; passing planning to ${next.provider}` : `${reason}; no planners left`,
        result?.usage,
      );
    }
  }
  throw new PlanningError(lastError, attempts, targets.length);
}

export interface PlanAttempt {
  provider: string;
  kind: string;
  reason: string;
}

const PROVIDER_LABEL: Record<string, string> = { google: "Gemini", groq: "Groq", openai: "OpenAI", nvidia: "NVIDIA NIM", openrouter: "OpenRouter" };

const HINTS: Record<string, (provider: string) => string> = {
  overloaded: (p) => `${p}'s servers are busy right now; this is usually temporary, so try again in a minute`,
  rate_limit: (p) => `your ${p} free-tier quota is used up for now; wait for it to reset`,
  billing: (p) =>
    p === "OpenAI"
      ? "your OpenAI account has no credit; add a payment method at platform.openai.com/settings/organization/billing"
      : `your ${p} account has no credit`,
  auth: (p) => `check that the ${p} API key is correct`,
  model_unavailable: (p) => `${p} no longer offers the configured models; update the model list in your environment`,
  invalid_plan: (p) => `${p} answered, but its plan wasn't usable; try again or rephrase the request`,
  timeout: (p) => `${p} took too long to answer; try again`,
};

export class PlanningError extends Error {
  constructor(
    readonly cause: unknown,
    readonly attempts: PlanAttempt[] = [],
    readonly providerCount = attempts.length,
  ) {
    const label = (p: string) => PROVIDER_LABEL[p] ?? p;
    const summary = attempts.map((a) => `${a.provider}: ${a.reason}`).join("; ") || String((cause as Error)?.message ?? cause);
    const hints = attempts
      .map((a) => HINTS[a.kind]?.(label(a.provider)))
      .filter((h, i, all): h is string => Boolean(h) && all.indexOf(h) === i);
    const parts = [`Planning failed (${summary}).`];
    if (hints.length) parts.push(`What to do: ${hints.join("; ")}.`);
    if (providerCount < 5) {
      const used = new Set(attempts.map((a) => a.provider));
      const missing = ["groq", "google", "nvidia", "openrouter", "openai"].filter((p) => !used.has(p)).map(label);
      const names = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]}` : missing[0];
      if (missing.length) parts.push(`Tip: adding a ${names} key gives Baton more providers to fall back on.`);
    }
    super(parts.join(" "));
    this.name = "PlanningError";
  }
}
