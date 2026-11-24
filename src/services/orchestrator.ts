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
import { gate } from "./gate.js";
import { originsFromLogs } from "./context.js";
import { CLIENT_RUN_ID_RE, progressEmitter } from "./progress.js";
import { log, sumUsage } from "./logging.js";
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
  constructor() {
    super("Provide at least one API key: keys.groqApiKey, keys.geminiApiKey, keys.nvidiaApiKey, keys.openrouterApiKey or keys.openaiApiKey (BYOK).");
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
): { planner: ProviderTarget[]; relay: ProviderTarget[] } {
  const gemini = keys.geminiApiKey ? geminiTarget(keys.geminiApiKey) : undefined;
  const groq = keys.groqApiKey ? groqTarget(keys.groqApiKey, taskType) : undefined;
  const nvidia = keys.nvidiaApiKey ? nvidiaTarget(keys.nvidiaApiKey, taskType) : undefined;
  const openai = keys.openaiApiKey ? openaiTarget(keys.openaiApiKey) : undefined;
  const openrouter = keys.openrouterApiKey ? openrouterTarget(keys.openrouterApiKey, taskType) : undefined;
  const byName: Record<string, ProviderTarget | undefined> = { nvidia, groq, google: gemini, openrouter, openai };
  const ordered = (order: string[]) =>
    order.map((name) => byName[name]).filter((x): x is ProviderTarget => Boolean(x));
  return { planner: ordered(providerOrder("planner")), relay: ordered(providerOrder("relay")) };
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

export async function orchestrate(
  req: OrchestrateRequest,
  store: WorkspaceStore,
  history?: HistoryStore,
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
  const providers = [
    keys.groqApiKey && "groq",
    keys.geminiApiKey && "google",
    keys.nvidiaApiKey && "nvidia",
    keys.openrouterApiKey && "openrouter",
    keys.openaiApiKey && "openai",
  ].filter((p): p is string => Boolean(p));

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
  const gated = gate(req.userPrompt);
  if (gated) {
    const historyId = await record({ id: runId(), status: "gated", message: gated.response });
    emit?.({ type: "done", status: "gated", historyId, message: gated.response });
    return { ...gated, historyId };
  }

  if (providers.length === 0) {
    const err = new MissingKeysError();
    const historyId = await record({ id: runId(), status: "error", message: err.message });
    Object.assign(err, { historyId });
    emit?.({ type: "done", status: "error", historyId, message: err.message });
    throw err;
  }

  // Follow-up: start from the earlier run's files, decisions and request chain.
  let parent: HistoryRecord | undefined;
  if (req.continueFrom) {
    parent = history ? await history.get(req.continueFrom) : undefined;
    const problem = !parent
      ? "The run you are continuing was not found in history (it may have been deleted)."
      : Object.keys(parent.artifacts).length === 0
        ? "The run you are continuing has no files to build on. Start a new project instead."
        : undefined;
    if (problem) {
      const err = new FollowUpError(problem);
      const historyId = await record({ id: runId(), status: "error", message: problem, parentId: req.continueFrom });
      Object.assign(err, { historyId });
      emit?.({ type: "done", status: "error", historyId, message: problem });
      throw err;
    }
    chatId = parent!.chatId ?? parent!.id; // a follow-up always lives in its parent's chat
  }

  const ws: BatonWorkspace = {
    workspaceId: newWorkspaceId(),
    userPrompt: req.userPrompt.trim(),
    taskType: parent && !req.taskType ? parent.taskType : taskType,
    metadata: { ...(parent?.plan?.metadata ?? {}) },
    tasks: [],
    artifacts: { ...(parent?.artifacts ?? {}) },
    executionLogs: [],
    ...(parent
      ? {
          parentId: parent.id,
          conversation: [...(parent.conversation ?? []), parent.userPrompt],
          artifactOrigins: { ...(parent.artifactOrigins ?? originsFromLogs(parent.id, parent.executionLogs)) },
        }
      : {}),
  };
  chatId ??= ws.workspaceId;
  ws.chatId = chatId;
  ws.emit = emit;
  emit?.({ type: "start", runId: ws.workspaceId, chatId, followUpOf: parent?.id });
  const before = new Set(Object.keys(ws.artifacts));
  /** Fields every record of this run shares. */
  const runFields = () => ({
    parentId: ws.parentId,
    conversation: ws.conversation,
    contexts: ws.contexts,
    artifactOrigins: ws.artifactOrigins,
    plan: { metadata: ws.metadata, tasks: ws.tasks },
    calls: ws.calls,
    chatId: ws.chatId,
  });

  try {
    const targets = buildTargets(keys, taskType);

    // Stage 2 — planning (Gemini as architect, Groq as safety net).
    await planWorkspace(ws, targets.planner);

    // Stage 3 — relay execution with failover.
    const allDone = await runRelay(ws, { targets: targets.relay });

    const completed = ws.tasks.filter((t) => t.status === "completed");
    const status: OrchestrateResponse["status"] = allDone ? "success" : completed.length > 0 ? "partial" : "failed";
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
    const changes = {
      modified: completed.map((t) => t.targetArtifact).filter((p) => before.has(p)),
      added: completed.map((t) => t.targetArtifact).filter((p) => !before.has(p)),
    };
    const historyId = await record({
      id: ws.workspaceId,
      status,
      summary,
      usage,
      changes,
      ...runFields(),
      executionLogs: ws.executionLogs,
      artifacts: ws.artifacts,
    });

    emit?.({ type: "done", status, historyId });
    return {
      status,
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
      downloadUrl: `/api/download/${ws.workspaceId}`,
    };
  } catch (err) {
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
}
