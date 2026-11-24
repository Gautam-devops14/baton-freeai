// Wires the four pipeline stages together (spec §3).

import { randomBytes } from "node:crypto";
import { geminiTarget } from "../providers/gemini.js";
import { groqTarget } from "../providers/groq.js";
import { nvidiaTarget } from "../providers/nvidia.js";
import { openaiTarget } from "../providers/openai.js";
import type {
  BatonWorkspace,
  GatedResponse,
  OrchestrateRequest,
  OrchestrateResponse,
  ProviderTarget,
  TaskType,
} from "../types.js";
import { gate } from "./gate.js";
import { log, sumUsage } from "./logging.js";
import { planWorkspace } from "./planner.js";
import { runRelay } from "./relay.js";
import type { HistoryRecord, HistoryStore } from "./history.js";
import type { WorkspaceStore } from "./storage.js";

export class MissingKeysError extends Error {
  constructor() {
    super("Provide at least one API key: keys.groqApiKey, keys.geminiApiKey, keys.nvidiaApiKey or keys.openaiApiKey (BYOK).");
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
  const present = (t: (ProviderTarget | undefined)[]) => t.filter((x): x is ProviderTarget => Boolean(x));
  return {
    // Free tiers first; OpenAI is paid, so it is always the last resort.
    planner: present([gemini, groq, nvidia, openai]), // Gemini is the architect
    relay: present([groq, gemini, nvidia, openai]), // Groq is the sprint tier
  };
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
  };
  const providers = [
    keys.groqApiKey && "groq",
    keys.geminiApiKey && "google",
    keys.nvidiaApiKey && "nvidia",
    keys.openaiApiKey && "openai",
  ].filter((p): p is string => Boolean(p));

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
    return { ...gated, historyId };
  }

  if (providers.length === 0) {
    const err = new MissingKeysError();
    Object.assign(err, { historyId: await record({ id: runId(), status: "error", message: err.message }) });
    throw err;
  }

  const ws: BatonWorkspace = {
    workspaceId: newWorkspaceId(),
    userPrompt: req.userPrompt.trim(),
    taskType,
    metadata: {},
    tasks: [],
    artifacts: {},
    executionLogs: [],
  };

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
    const historyId = await record({
      id: ws.workspaceId,
      status,
      summary,
      usage,
      executionLogs: ws.executionLogs,
      artifacts: ws.artifacts,
    });

    return {
      status,
      workspaceId: ws.workspaceId,
      historyId,
      taskType,
      summary,
      artifacts: ws.artifacts,
      executionLogs: ws.executionLogs,
      usage,
      downloadUrl: `/api/download/${ws.workspaceId}`,
    };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    const historyId = await record({
      id: ws.workspaceId,
      status: "error",
      message,
      usage: sumUsage(ws.executionLogs), // a failed run can still have spent tokens (e.g. an unusable plan)
      executionLogs: ws.executionLogs,
      artifacts: ws.artifacts,
    });
    if (err && typeof err === "object") {
      Object.assign(err, { historyId, executionLogs: ws.executionLogs } satisfies OrchestrationErrorInfo);
    }
    throw err;
  }
}
