// Stage 2: structured task planning (spec §3).
// Planning is isolated from generation (guardrail 4) so the blueprint survives
// even if a later generation call fails or runs out of tokens.

import { chatCompletion, isCancelled, isTransient, ProviderError, stepDeadlineMs } from "../providers/client.js";
import type { BatonTask, BatonWorkspace, ChatMessage, ProviderTarget } from "../types.js";
import { safeArtifactPath } from "./paths.js";
import { backoffRounds, countdownSleep, fullJitterDelay } from "./retry.js";
import { isAccountSkipped, splitBusy } from "../providers/memory.js";
import { contextFile, recordContext } from "./context.js";
import { outlineFile } from "./outline.js";
import { estimateTokens } from "../providers/client.js";
import { attachBreakdown, log, logBusySkips, logModelSwaps, traceFor } from "./logging.js";

/** We ask for 2-4 tasks (spec), but accept a 1-task plan rather than failing a small request. */
export const MIN_TASKS = 2;
/**
 * No real file limit: a plan builds every file it needs. This is only a safety guard against a broken
 * reply listing hundreds of files (which would burn the free quota). Override with BATON_MAX_FILES.
 */
export const maxTasks = (): number => {
  const n = Number(process.env.BATON_MAX_FILES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 25;
};
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
  code:
    'Artifacts are source files with relative paths (e.g. "package.json", "src/auth.js"). Decide "primaryLanguage" and "framework". ' +
    "Build something that actually runs (e.g. HTML/CSS/JS that opens in a browser, or a server that starts), not requirements, " +
    "architecture or API documents, unless the user explicitly asks for documents.",
  document: 'Artifacts are Markdown chapters (e.g. "overview.md", "methodology.md"). Decide "tone" and "audience".',
  analysis:
    'Artifacts are analysis deliverables such as "data/sample.csv", "analysis.py", or "findings.md". Decide "primaryLanguage" and "methodology".',
};

/** Universal Runnable Harness Contract: every code project must start/open with no missing glue files. */
export const HARNESS_CONTRACT = [
  "UNIVERSAL RUNNABLE HARNESS CONTRACT. Before planning files, determine the project's ARCHETYPE (put it in decisions as \"archetype\") " +
    "and include its mandatory harness files in the plan:",
  "1. CLIENT_WEB (HTML, CSS, vanilla JS, Canvas): an index.html that mounts every CSS file (<link>) and every JS file (<script src>) " +
    "with the exact planned paths, so it opens directly in a browser.",
  "2. NODE_BACKEND (Express, Fastify, REST APIs): package.json with \"scripts\": {\"start\": \"node server.js\"} and every dependency; " +
    "an entry bootstrap file (server.js or app.js) that calls app.listen(PORT); .env.example if database URIs or JWT secrets are used.",
  "3. PYTHON_BACKEND_OR_SCRIPT (FastAPI, Flask, CLI, automation): requirements.txt listing every external package; a root entry point " +
    "(main.py or app.py) with a runnable if __name__ == \"__main__\": block.",
  "4. DATABASE_DATA (SQL, schemas, migrations): schema.sql (table definitions and constraints); seed.sql (sample mock data so queries " +
    "can be tested immediately); a quick verification script (test_queries.sql or a lightweight JS/Python connection runner).",
  "RULE: even if the user asks only for specific internal files (e.g. \"build me user and order models\"), plan the archetype's harness " +
    "files too, so the generated codebase is a complete, runnable unit. Harness files count toward the plan; never skip them to save files.",
].join("\n");

export function buildPlannerMessages(ws: BatonWorkspace): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the Task Architect for Baton, a multi-model build relay.",
        "FIRST decide what the user wants:",
        '- If the message is a question, asks for information or an opinion, or asks "can you...?" without asking you to actually ' +
          'do it now, do NOT plan any files. Reply with ONLY {"answer": "<your reply>"}. Follow any requested format exactly ' +
          '(e.g. "yes or no only" -> {"answer": "Yes."}). Match the length to the question: short for simple questions, ' +
          'a full, clear explanation (Markdown allowed) when asked to explain code or concepts. ' +
          'For follow-ups you can see the project files, so you can explain them.',
        "- Only if the user asks you to create, build, write, fix or change something, plan files as described below.",
        "When planning, use the FEWEST files that do the job well, but EVERY file the product needs to actually work " +
          "(a simple page can be a single index.html with inline CSS and JS; a full app with a backend also needs its frontend pages). " +
          "Never leave out a part the user asked for. Each task produces exactly ONE artifact. Fewer files means fewer calls and less cost.",
        'For each task, list in "uses" the earlier files it must match (e.g. app.js uses index.html for element ids). ' +
          "Only those are sent to it in full, so keep the list short but complete.",
        TASK_TYPE_GUIDANCE[ws.taskType],
        ...(ws.taskType === "code" ? [HARNESS_CONTRACT] : []),
        "Every artifact must be a plain-text file (source code, HTML, CSS, JSON, Markdown, CSV, SVG...). " +
          "Never plan binary files such as .png, .jpg, .gif, .ico, .pdf, .zip or fonts: a text model cannot produce them. " +
          "Draw logos, icons and illustrations as SVG (a .svg file or inline <svg> in HTML).",
        "Order tasks so that dependencies come before the artifacts that consume them.",
        "Respond with ONLY a JSON object, no prose: either {\"answer\": \"...\"} or",
        '{"decisions": {"<key>": "<string value>", ...}, "tasks": [{"title": "<what to build>", "targetArtifact": "<relative path>", "uses": ["<earlier path>"]}]}',
      ].join("\n"),
    },
    { role: "user", content: plannerUserMessage(ws) },
  ];
}

/** Planner input: the request, plus (for follow-ups) the earlier requests and the existing files. */
export const MAX_PLANNER_FILE_CHARS = 16_000;

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
    "This is a FOLLOW-UP to an existing project. If the new request asks for changes, change the existing files to satisfy it. " +
      'If it is only a question (about the project or anything else), answer it with {"answer": "..."} and plan no files.',
    `## Earlier requests (oldest first)\n${(ws.conversation ?? []).map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
    `## New request\n${ws.userPrompt}`,
    `## Existing project files\n${files.map((f) => `- ${f}`).join("\n")}`,
    included.length ? `## Current contents\n${included.map((f) => `=== ${f} ===\n${ws.artifacts[f]}`).join("\n")}` : "",
    listed.length ? `## Outlines of the other files (full text omitted to save tokens)\n${listed.map((f) => `=== ${f} ===\n${outlineFile(f, ws.artifacts[f])}`).join("\n")}` : "",
    "## Rules for follow-ups\n" +
      "- Plan ONLY the files that must change or be added for the new request (as few as possible, but all that are needed).\n" +
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
  /** Set when the message was a question: the reply, and no tasks. */
  answer?: string;
  /** Files the planner listed beyond the safety guard (not built). */
  dropped?: string[];
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

  // A question gets an answer, not a build.
  const answer = typeof data.answer === "string" ? data.answer.trim() : "";
  if (answer && !(rawTasks && rawTasks.length)) return { metadata: {}, tasks: [], answer };
  if (!rawTasks) throw new Error("planner reply has no tasks array");
  const seen = new Set<string>();
  const tasks: BatonTask[] = [];
  const dropped: string[] = [];
  const limit = maxTasks();
  for (const raw of rawTasks) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const rawPath = firstString(t, PATH_KEYS);
    if (!rawPath) continue;
    const safe = safeArtifactPath(rawPath);
    const path = safe ? textOnlyPath(safe) : null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (tasks.length >= limit) {
      dropped.push(path);
      continue;
    }
    const title = firstString(t, TITLE_KEYS)?.trim() ?? `Write ${path}`;
    const usesRaw = [t.uses, t.dependsOn, t.depends_on, t.dependencies].find(Array.isArray) as unknown[] | undefined;
    const uses = usesRaw
      ?.filter((u): u is string => typeof u === "string")
      .map((u) => safeArtifactPath(u))
      .filter((u): u is string => Boolean(u) && u !== path);
    tasks.push({ id: tasks.length + 1, title, targetArtifact: path, status: "pending", ...(uses?.length ? { uses } : {}) });
  }
  if (tasks.length < MIN_ACCEPTED_TASKS) {
    throw new Error("planner produced no usable tasks (each needs a file path)");
  }
  return { metadata, tasks, ...(dropped.length ? { dropped } : {}) };
}

const ext = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? "").toLowerCase();
const FRONT_DIR = /^(public|static|client|frontend|www|web)\//i;
const PY_LIBS = /\b(flask|fastapi|django|streamlit|pandas|numpy|requests|sqlalchemy|matplotlib|uvicorn|scikit|sklearn|selenium|beautifulsoup|bs4|pydantic|openai)\b/i;
const SECRET_HINT = /\b(jwt|mongo(db)?|postgres(ql)?|mysql|database url|db uri|redis|secret|api key|oauth|supabase|firebase)\b/i;
const NODE_HINT = /\b(express|fastify|koa|hapi|node\.?js|nest\.?js|socket\.io|sqlite3|mongoose|prisma)\b/i;

/**
 * Enforce the harness contract in code too (models forget): add the glue file a project can't run without.
 * Only adds files that are missing from both the plan and the existing project. Returns what was added.
 */
export function ensureHarness(ws: Pick<BatonWorkspace, "tasks" | "artifacts" | "metadata">): string[] {
  const have = new Set([...ws.tasks.map((t) => t.targetArtifact), ...Object.keys(ws.artifacts ?? {})]);
  const all = [...have];
  const decisions = Object.values(ws.metadata ?? {}).join(" ");
  const added: string[] = [];
  const insert = (task: { title: string; targetArtifact: string; uses?: string[] }, at: number) => {
    const t: BatonTask = { id: 0, title: task.title, targetArtifact: task.targetArtifact, status: "pending", ...(task.uses?.length ? { uses: task.uses } : {}) };
    ws.tasks.splice(Math.max(0, Math.min(at, ws.tasks.length)), 0, t);
    have.add(task.targetArtifact);
    added.push(task.targetArtifact);
  };


  const jsFiles = all.filter((p) => ["js", "mjs", "cjs", "ts"].includes(ext(p)) && !FRONT_DIR.test(p));
  const pyFiles = all.filter((p) => ext(p) === "py");
  const sqlFiles = all.filter((p) => ext(p) === "sql");

  // NODE_BACKEND: package.json (start script) + an entry that listens + .env.example for secrets.
  const nodeBackend = jsFiles.length > 0 && (NODE_HINT.test(decisions) || jsFiles.some((p) => /(^|\/)server\./i.test(p)));
  if (nodeBackend) {
    if (!have.has("package.json")) insert({ title: 'package.json with every dependency and "scripts": {"start": "node server.js"}', targetArtifact: "package.json" }, 0);
    const entry = jsFiles.find((p) => /^(src\/)?(server|app|index|main)\.(m?js|cjs|ts)$/i.test(p));
    if (!entry) {
      const deps = jsFiles.filter((p) => have.has(p) && !/\.(test|spec)\./.test(p));
      insert({ title: "server.js: entry bootstrap that wires everything and calls app.listen(PORT)", targetArtifact: "server.js", uses: deps.slice(0, 6) }, ws.tasks.length);
    }
    if (SECRET_HINT.test(decisions) && !have.has(".env.example") && !have.has(".env")) {
      insert({ title: ".env.example with every environment variable (database URI, JWT secret, PORT)", targetArtifact: ".env.example" }, ws.tasks.length);
    }
  }

  // PYTHON_BACKEND_OR_SCRIPT: requirements.txt + a root entry with a __main__ block.
  if (pyFiles.length) {
    if (PY_LIBS.test(decisions) && !have.has("requirements.txt") && !have.has("pyproject.toml")) {
      insert({ title: "requirements.txt listing every external package", targetArtifact: "requirements.txt" }, 0);
    }
    if (!pyFiles.some((p) => /^(main|app|manage)\.py$/i.test(p))) {
      insert({ title: 'main.py: root entry point with an if __name__ == "__main__": block that runs the project', targetArtifact: "main.py", uses: pyFiles.slice(0, 6) }, ws.tasks.length);
    }
  }

  // DATABASE_DATA: schema, seed data and a quick verification script.
  if (sqlFiles.length || /\bDATABASE_DATA\b/.test(decisions)) {
    if (!have.has("schema.sql")) insert({ title: "schema.sql: table definitions and constraints", targetArtifact: "schema.sql" }, 0);
    if (!have.has("seed.sql")) insert({ title: "seed.sql: sample mock data so queries can be tested immediately", targetArtifact: "seed.sql", uses: ["schema.sql"] }, ws.tasks.findIndex((t) => t.targetArtifact === "schema.sql") + 1);
    const verify = [...have].some((p) => /test_queries\.sql$|(^|\/)(verify|check|test)[-_]?(db|queries)?\.(js|py)$/i.test(p));
    if (!verify) insert({ title: "test_queries.sql: quick queries that verify the schema and seed data", targetArtifact: "test_queries.sql", uses: ["schema.sql", "seed.sql"] }, ws.tasks.length);
  }

  // CLIENT_WEB: styles or browser scripts but no page to open.
  const front = all.filter((p) => ext(p) === "css" || (FRONT_DIR.test(p) && ["js", "mjs", "ts"].includes(ext(p))));
  if (front.length && !all.some((p) => ["html", "htm"].includes(ext(p)))) {
    const dir = FRONT_DIR.exec(front[0])?.[0] ?? "";
    const page = `${dir}index.html`;
    const css = front.filter((p) => ext(p) === "css");
    const firstScript = ws.tasks.findIndex((t) => front.includes(t.targetArtifact) && ext(t.targetArtifact) !== "css");
    insert({ title: `${page}: the page that links ${front.join(", ")}`, targetArtifact: page, uses: css }, firstScript < 0 ? ws.tasks.length : firstScript);
    for (const t of ws.tasks) if (front.includes(t.targetArtifact) && ext(t.targetArtifact) !== "css") t.uses = [...new Set([...(t.uses ?? []), page])];
  }

  ws.tasks.forEach((t, i) => (t.id = i + 1));
  return added;
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
    {
      step: 0,
      kind: "plan",
      manifest: [...included, ...listed],
      files: [
        ...included.map((p) => contextFile(ws, p)),
        ...listed.map((p) => ({ ...contextFile(ws, p), mode: "outline" as const, tokens: estimateTokens(outlineFile(p, ws.artifacts[p])) })),
      ],
    },
    messages,
  );
  const { ready: targets, skipped } = splitBusy(allTargets);
  logBusySkips(ws, 0, skipped);
  // Same hard time limit as a build step, across every planner, retry and wait (0 = no limit).
  const limitMs = stepDeadlineMs();
  const deadlineAt = limitMs > 0 ? Date.now() + limitMs : undefined;
  const fits = (ms: number) => deadlineAt === undefined || Date.now() + ms < deadlineAt;
  let lastError: unknown;
  const attempts: PlanAttempt[] = [];
  const transient = new Set<ProviderTarget>(); // failed with a problem that usually clears within a minute

  /** One pass over the planners in order. True once a plan (or an answer) is in. */
  const round = async (list: ProviderTarget[]): Promise<boolean> => {
    for (const [i, target] of list.entries()) {
      if (!fits(0)) {
        log(ws, 0, "failover", { provider: "baton", model: "planner" }, `planning time limit (${Math.round(limitMs / 1000)}s) reached`);
        attempts.push({ provider: target.provider, kind: "timeout", reason: "planning time limit reached" });
        return false;
      }
      // Kept outside `try` so tokens are still counted when the reply is an unusable plan.
      let result: Awaited<ReturnType<typeof chatCompletion>> | undefined;
      try {
        result = await chatCompletion(target, messages, {
          jsonMode: true,
          temperature: 0.1,
          retryOverloaded: i === list.length - 1, // nobody left to hand off to: worth a short wait
          ...traceFor(ws, 0),
          deadlineAt,
        });
        logModelSwaps(ws, 0, target.provider, result.skippedModels);
        const plan = parsePlan(result.content);
        attachBreakdown(ws, 0, result.model, { understanding: result.usage.totalTokens });
        if (plan.answer !== undefined) {
          ws.answer = plan.answer;
          log(ws, 0, "plan", { ...target, model: result.model }, "Answered the question directly (no files needed)", result.usage);
          return true;
        }
        ws.metadata = { ...ws.metadata, ...plan.metadata };
        ws.tasks = plan.tasks;
        const harness = ws.taskType === "code" ? ensureHarness(ws) : [];
        ws.emit?.({ type: "plan", tasks: plan.tasks.map((t) => ({ id: t.id, targetArtifact: t.targetArtifact, title: t.title })) });
        log(ws, 0, "plan", { ...target, model: result.model }, `Project decomposed into ${plan.tasks.length} milestone${plan.tasks.length === 1 ? "" : "s"}`, result.usage);
        if (harness.length) {
          log(ws, 0, "plan", { provider: "baton", model: "harness" }, `added missing harness file${harness.length === 1 ? "" : "s"} so the project runs: ${harness.join(", ")}`);
        }
        if (plan.dropped?.length) {
          log(ws, 0, "plan", { provider: "baton", model: "guard" }, `plan listed ${plan.tasks.length + plan.dropped.length} files; safety guard (BATON_MAX_FILES=${maxTasks()}) skipped: ${plan.dropped.join(", ")}. Ask for them in a follow-up.`);
        }
        return true;
      } catch (err) {
        if (isCancelled(err)) throw err; // Stop pressed
        lastError = err;
        if (err instanceof ProviderError) logModelSwaps(ws, 0, target.provider, err.skippedModels);
        // The model answered but its plan was unusable: those tokens were wasted.
        if (result && !(err instanceof ProviderError)) attachBreakdown(ws, 0, result.model, { wasted: result.usage.totalTokens });
        if (err instanceof ProviderError && isTransient(err)) transient.add(target);
        else transient.delete(target);
        const reason = err instanceof ProviderError ? err.reason : `invalid plan (${(err as Error).message})`;
        attempts.push({ provider: target.provider, kind: err instanceof ProviderError ? err.kind : "invalid_plan", reason });
        const next = list[i + 1];
        log(
          ws,
          0,
          "failover",
          {
            ...target,
            model: result?.model ?? (err instanceof ProviderError ? err.model ?? err.skippedModels.at(-1)?.model : undefined) ?? target.model,
          },
          next ? `${reason}; passing planning to ${next.provider}` : `${reason}; no planners left`,
          result?.usage,
        );
      }
    }
    return false;
  };

  if (await round(targets)) return;

  // Cool-down rounds: the planners failed with problems that usually clear within a minute.
  const rounds = backoffRounds();
  for (let n = 0; n < rounds; n++) {
    const ms = fullJitterDelay(n); // random, so users don't all retry at the same moment
    const retryable = allTargets.filter((t) => (transient.has(t) || !targets.includes(t)) && !isAccountSkipped(t));
    if (!transient.size || !retryable.length || !fits(ms + 1000)) break;
    const order = retryable.map((t) => t.provider).join(" → ");
    log(ws, 0, "failover", { provider: "baton", model: "planner" },
      `all planners are busy or rate limited; backing off ${(ms / 1000).toFixed(1)}s (random, round ${n + 1}/${rounds}), then retrying ${order}`);
    await countdownSleep(ms, ws.signal, (secondsLeft) => ws.emit?.({ type: "wait", step: 0, secondsLeft, label: `retrying ${order}` }));
    if (await round(retryable)) return;
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
