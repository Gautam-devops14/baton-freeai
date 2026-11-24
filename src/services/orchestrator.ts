// Wires the four pipeline stages together (spec §3).

import { randomBytes } from "node:crypto";
import { geminiTarget } from "../providers/gemini.js";
import { groqTarget } from "../providers/groq.js";
import { nvidiaTarget } from "../providers/nvidia.js";
import { openaiTarget } from "../providers/openai.js";
import { openrouterTarget } from "../providers/openrouter.js";
import type {
  BatonWorkspace,
  GatedResponse,
  OrchestrateRequest,
  OrchestrateResponse,
  ProviderTarget,
  TaskType,
} from "../types.js";
import { gate, stripGreeting } from "./gate.js";
import { isCancelled } from "../providers/client.js";
import { originsFromLogs } from "./context.js";
import { CLIENT_RUN_ID_RE, progressEmitter } from "./progress.js";
import { log, sumBreakdown, sumUsage } from "./logging.js";
import { planWorkspace } from "./planner.js";
import { runRelay } from "./relay.js";
import type { HistoryRecord, HistoryStore } from "./history.js";
import type { WorkspaceStore } from "./storage.js";

/** continueFrom names a run that doesn't exist or has no files to build on. */
export class FollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowUpError";
  }
}

export class MissingKeysError extends Error {
  constructor(message?: string) {
    super(message ?? "Provide at least one API key: keys.groqApiKey, keys.geminiApiKey, keys.nvidiaApiKey, keys.openrouterApiKey or keys.openaiApiKey (BYOK).");
    this.name = "MissingKeysError";
  }
}

/** The id doubles as the download token, so it must not be guessable. */
export function newWorkspaceId(now = Date.now()): string {
  return `ws_${now}_${randomBytes(8).toString("hex")}`;
}

/**
 * Build each provider target ONCE per request and share it between planner and
 * relay, so a model Google reports as retired during planning is skipped
 * straight away for every artifact instead of costing an extra 404 each time.
 */
export function buildTargets(
  keys: OrchestrateRequest["keys"],
  taskType: TaskType,
  /** Per-request order from the UI. Providers not listed are not used. Overrides BATON_*_ORDER. */
  order?: string[],
): { planner: ProviderTarget[]; relay: ProviderTarget[] } {
  const gemini = keys.geminiApiKey ? geminiTarget(keys.geminiApiKey) : undefined;
  const groq = keys.groqApiKey ? groqTarget(keys.groqApiKey, taskType) : undefined;
  const nvidia = keys.nvidiaApiKey ? nvidiaTarget(keys.nvidiaApiKey, taskType) : undefined;
  const openai = keys.openaiApiKey ? openaiTarget(keys.openaiApiKey) : undefined;
  const openrouter = keys.openrouterApiKey ? openrouterTarget(keys.openrouterApiKey, taskType) : undefined;
  const byName: Record<string, ProviderTarget | undefined> = { nvidia, groq, google: gemini, openrouter, openai };
  const ordered = (order: string[]) =>
    order.map((name) => byName[name]).filter((x): x is ProviderTarget => Boolean(x));
  if (order) {
    const chosen = normalizeOrder(order);
    return { planner: ordered(chosen), relay: ordered(chosen) };
  }
  return { planner: ordered(providerOrder("planner")), relay: ordered(providerOrder("relay")) };
}

/** Lowercase, accept "gemini" for "google", drop unknown names and duplicates. */
export function normalizeOrder(order: string[]): string[] {
  return [...new Set(order.map((s) => String(s).trim().toLowerCase().replace(/^gemini$/, "google")).filter((s) => KNOWN_PROVIDERS.includes(s)))];
}

const KNOWN_PROVIDERS = ["nvidia", "groq", "google", "openrouter", "openai"];
/** Default waterfall: NVIDIA, Groq, Gemini (often overloaded), OpenRouter (free, ~50 requests/day), then paid OpenAI last. */
export const DEFAULT_PROVIDER_ORDER = ["nvidia", "groq", "google", "openrouter", "openai"];

/**
 * Provider order from BATON_PROVIDER_ORDER (both stages) or BATON_PLANNER_ORDER /
 * BATON_RELAY_ORDER, e.g. "groq,nvidia,google,openai". "gemini" is accepted for
 * "google". Providers left out are appended in default order so a key is never ignored.
 */
export function providerOrder(stage: "planner" | "relay"): string[] {
  const raw = (stage === "planner" ? process.env.BATON_PLANNER_ORDER : process.env.BATON_RELAY_ORDER) ?? process.env.BATON_PROVIDER_ORDER;
  const named = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^gemini$/, "google"))
    .filter((s) => KNOWN_PROVIDERS.includes(s));
  return [...new Set([...named, ...DEFAULT_PROVIDER_ORDER])];
}

/** Errors raised by orchestrate carry the history record id and any relay log so far. */
export interface OrchestrationErrorInfo {
  historyId?: string;
  executionLogs?: BatonWorkspace["executionLogs"];
}

export interface OrchestrateOptions {
  /** Aborted when the user presses Stop or the browser disconnects. */
  signal?: AbortSignal;
}

export async function orchestrate(
  req: OrchestrateRequest,
  store: WorkspaceStore,
  history?: HistoryStore,
  options: OrchestrateOptions = {},
): Promise<OrchestrateResponse | GatedResponse> {
  const startedAt = Date.now();
  const taskType = req.taskType ?? "code";
  const keys = {
    groqApiKey: req.keys?.groqApiKey?.trim() || undefined,
    geminiApiKey: req.keys?.geminiApiKey?.trim() || undefined,
    openaiApiKey: req.keys?.openaiApiKey?.trim() || undefined,
    nvidiaApiKey: req.keys?.nvidiaApiKey?.trim() || undefined,
    openrouterApiKey: req.keys?.openrouterApiKey?.trim() || undefined,
  };
  const keyed = [
    keys.groqApiKey && "groq",
    keys.geminiApiKey && "google",
    keys.nvidiaApiKey && "nvidia",
    keys.openrouterApiKey && "openrouter",
    keys.openaiApiKey && "openai",
  ].filter((p): p is string => Boolean(p));
  // A provider order from the UI also switches providers off: only listed ones are used.
  const order = req.providerOrder ? normalizeOrder(req.providerOrder) : undefined;
  const providers = order ? order.filter((p) => keyed.includes(p)) : keyed;
  const effectiveOrder = (order ?? providerOrder("relay")).filter((p) => keyed.includes(p));

  // Live progress for the browser (optional), and the chat thread this run belongs to.
  const emit = req.clientRunId && CLIENT_RUN_ID_RE.test(req.clientRunId) ? progressEmitter(req.clientRunId) : undefined;
  let chatId: string | undefined = req.chatId;

  /** Persist this prompt and its outcome. History must never break a run, so failures are swallowed. */
  const record = async (
    r: Pick<HistoryRecord, "id" | "status"> & Partial<HistoryRecord>,
  ): Promise<string | undefined> => {
    if (!history) return undefined;
    try {
      await history.add({
        createdAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        userPrompt: req.userPrompt.trim(),
        taskType,
        providers,
        executionLogs: [],
        artifacts: {},
        providerOrder: effectiveOrder,
        ...r,
        chatId: r.chatId ?? chatId ?? r.id,
      });
      return r.id;
    } catch {
      return undefined;
    }
  };
  const runId = () => `run_${Date.now()}_${randomBytes(6).toString("hex")}`;

  // Stage 1 — zero-token gate, before any state or network.
  const gated = req.resumeFrom ? null : gate(req.userPrompt);
  if (gated) {
    const historyId = await record({ id: runId(), status: "gated", message: gated.response });
    emit?.({ type: "done", status: "gated", historyId, message: gated.response });
    return { ...gated, historyId };
  }

  if (providers.length === 0) {
    const err = new MissingKeysError(
      keyed.length ? "Every provider that has a key is switched off in the provider order. Turn at least one on." : undefined,
    );
    const historyId = await record({ id: runId(), status: "error", message: err.message });
    Object.assign(err, { historyId });
    emit?.({ type: "done", status: "error", historyId, message: err.message });
    throw err;
  }

  // Follow-up: start from the earlier run's files, decisions and request chain.
  // Resume: same, but also reuse its plan and build only the files it didn't finish.
  let parent: HistoryRecord | undefined;
  const fromId = req.resumeFrom ?? req.continueFrom;
  if (fromId) {
    parent = history ? await history.get(fromId) : undefined;
    const unfinished = parent?.plan?.tasks?.filter((t) => t.status !== "completed") ?? [];
    const problem = !parent
      ? `The run you are ${req.resumeFrom ? "resuming" : "continuing"} was not found in history (it may have been deleted).`
      : req.resumeFrom
        ? !parent.plan?.tasks?.length
          ? "That run has no plan to resume (it stopped before planning). Send the request again instead."
          : !unfinished.length
            ? "Every file of that run is already built: nothing to resume."
            : undefined
        : Object.keys(parent.artifacts).length === 0
          ? "The run you are continuing has no files to build on. Start a new project instead."
          : undefined;
    if (problem) {
      const err = new FollowUpError(problem);
      const historyId = await record({ id: runId(), status: "error", message: problem, parentId: fromId });
      Object.assign(err, { historyId });
      emit?.({ type: "done", status: "error", historyId, message: problem });
      throw err;
    }
    chatId = parent!.chatId ?? parent!.id; // a follow-up always lives in its parent's chat
  }

  const resuming = Boolean(req.resumeFrom && parent);
  const ws: BatonWorkspace = {
    workspaceId: newWorkspaceId(),
    // Models get the request without a leading greeting; a resume keeps the original request.
    userPrompt: resuming ? (parent!.goal ?? parent!.userPrompt) : stripGreeting(req.userPrompt.trim()),
    taskType: parent && (!req.taskType || resuming) ? parent.taskType : taskType,
    metadata: { ...(parent?.plan?.metadata ?? {}) },
    tasks: resuming
      ? parent!.plan!.tasks.map((t) => (t.status === "completed" ? { ...t } : { ...t, status: "pending" as const, assignedProvider: undefined, assignedModel: undefined }))
      : [],
    artifacts: { ...(parent?.artifacts ?? {}) },
    executionLogs: [],
    ...(parent && resuming
      ? {
          parentId: parent.id,
          conversation: parent.conversation,
          artifactOrigins: { ...(parent.artifactOrigins ?? originsFromLogs(parent.id, parent.executionLogs)) },
        }
      : parent
      ? {
          parentId: parent.id,
          conversation: [...(parent.conversation ?? []), parent.goal ?? parent.userPrompt],
          artifactOrigins: { ...(parent.artifactOrigins ?? originsFromLogs(parent.id, parent.executionLogs)) },
        }
      : {}),
  };
  chatId ??= ws.workspaceId;
  ws.chatId = chatId;
  ws.emit = emit;
  ws.signal = options.signal;
  emit?.({ type: "start", runId: ws.workspaceId, chatId, followUpOf: parent?.id });
  if (ws.userPrompt !== req.userPrompt.trim() && !resuming) {
    log(ws, 0, "plan", { provider: "baton", model: "gate" }, `greeting removed before planning: "${ws.userPrompt.slice(0, 80)}"`);
  }
  const before = new Set(Object.keys(ws.artifacts));
  // Files finished in an earlier (stopped) run count as that run's work, not this one's.
  const doneBefore = new Set(ws.tasks.filter((t) => t.status === "completed").map((t) => t.id));
  /** Fields every record of this run shares. */
  const runFields = () => ({
    parentId: ws.parentId,
    conversation: ws.conversation,
    contexts: ws.contexts,
    artifactOrigins: ws.artifactOrigins,
    plan: { metadata: ws.metadata, tasks: ws.tasks },
    calls: ws.calls,
    chatId: ws.chatId,
    goal: ws.userPrompt,
    breakdown: sumBreakdown(ws.calls),
  });

  try {
    const targets = buildTargets(keys, taskType, order);

    // Stage 2 — planning (skipped when resuming: the earlier plan is reused).
    if (resuming) {
      const left = ws.tasks.filter((t) => t.status !== "completed");
      log(ws, 0, "plan", { provider: "baton", model: "resume" },
        `Resuming from step ${left[0].id}: reusing the earlier plan, ${ws.tasks.length - left.length}/${ws.tasks.length} files already built (no planning call)`);
      ws.emit?.({ type: "plan", tasks: ws.tasks.map((t) => ({ id: t.id, targetArtifact: t.targetArtifact, title: t.title })) });
    } else {
      await planWorkspace(ws, targets.planner);
    }

    // A question: the planner already answered it. Nothing to build.
    if (ws.answer !== undefined) {
      const usage = sumUsage(ws.executionLogs);
      const summary = { totalTasks: 0, completedTasks: 0, artifactsGenerated: [] as string[] };
      const historyId = await record({
        id: ws.workspaceId,
        status: "answered",
        message: ws.answer,
        summary,
        usage,
        ...runFields(),
        executionLogs: ws.executionLogs,
        artifacts: {}, // an answer changes no files; the project stays as it was
      });
      emit?.({ type: "done", status: "answered", historyId, message: ws.answer });
      return {
        status: "answered",
        answer: ws.answer,
        workspaceId: ws.workspaceId,
        historyId,
        taskType: ws.taskType,
        summary,
        artifacts: {},
        executionLogs: ws.executionLogs,
        usage,
        parentId: ws.parentId,
        chatId: ws.chatId,
        calls: ws.calls,
        contexts: ws.contexts,
        breakdown: sumBreakdown(ws.calls),
        downloadUrl: "",
      };
    }

    // Stage 3 — relay execution with failover.
    const allDone = await runRelay(ws, { targets: targets.relay });
    const completed = ws.tasks.filter((t) => t.status === "completed");
    return await finishBuild(allDone ? "success" : completed.length > 0 ? "partial" : "failed");
  } catch (err) {
    // Stop pressed: keep every file finished so far, like a partial run, so it can be downloaded or resumed.
    if (isCancelled(err)) {
      for (const t of ws.tasks) if (t.status === "in_progress") t.status = "pending";
      log(ws, ws.tasks.length + 1, "failover", { provider: "baton", model: "relay" }, "stopped by the user; finished files are kept");
      return await finishBuild("stopped", "Stopped by you.");
    }
    const message = (err as Error)?.message ?? String(err);
    const historyId = await record({
      id: ws.workspaceId,
      status: "error",
      message,
      usage: sumUsage(ws.executionLogs), // a failed run can still have spent tokens (e.g. an unusable plan)
      ...runFields(),
      executionLogs: ws.executionLogs,
      // A follow-up that failed before changing anything shouldn't look like it produced the old files.
      artifacts: ws.tasks.some((t) => t.status === "completed") ? ws.artifacts : parent ? {} : ws.artifacts,
    });
    if (err && typeof err === "object") {
      Object.assign(err, { historyId, executionLogs: ws.executionLogs } satisfies OrchestrationErrorInfo);
    }
    emit?.({ type: "done", status: "error", historyId, message });
    throw err;
  }

  async function finishBuild(status: OrchestrateResponse["status"], message?: string): Promise<OrchestrateResponse> {
    const completed = ws.tasks.filter((t) => t.status === "completed");
    log(
      ws,
      ws.tasks.length + 1,
      "complete",
      { provider: "baton", model: "relay" },
      `${completed.length}/${ws.tasks.length} milestones completed`,
    );

    // Stage 4 — persist so the archive can be streamed on demand.
    await store.set(ws);

    const summary = {
      totalTasks: ws.tasks.length,
      completedTasks: completed.length,
      artifactsGenerated: completed.map((t) => t.targetArtifact),
    };
    const usage = sumUsage(ws.executionLogs);
    const builtNow = completed.filter((t) => !doneBefore.has(t.id)).map((t) => t.targetArtifact);
    const changes = {
      modified: builtNow.filter((p) => before.has(p)),
      added: builtNow.filter((p) => !before.has(p)),
    };
    const historyId = await record({
      id: ws.workspaceId,
      status,
      message,
      summary,
      usage,
      changes,
      ...runFields(),
      executionLogs: ws.executionLogs,
      artifacts: ws.artifacts,
    });

    emit?.({ type: "done", status, historyId, message });
    return {
      status,
      ...(message ? { message } : {}),
      workspaceId: ws.workspaceId,
      historyId,
      taskType,
      summary,
      artifacts: ws.artifacts,
      executionLogs: ws.executionLogs,
      usage,
      parentId: ws.parentId,
      changes,
      contexts: ws.contexts,
      artifactOrigins: ws.artifactOrigins,
      chatId: ws.chatId,
      calls: ws.calls,
      breakdown: sumBreakdown(ws.calls),
      downloadUrl: `/api/download/${ws.workspaceId}`,
    };
  }
}
