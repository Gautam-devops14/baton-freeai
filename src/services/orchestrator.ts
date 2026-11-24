// Wires the four pipeline stages together (spec §3).

import { randomBytes } from "node:crypto";
import { geminiTarget } from "../providers/gemini.js";
import { groqTarget } from "../providers/groq.js";
import type {
  BatonWorkspace,
  GatedResponse,
  OrchestrateRequest,
  OrchestrateResponse,
  ProviderTarget,
  TaskType,
} from "../types.js";
import { gate } from "./gate.js";
import { log } from "./logging.js";
import { planWorkspace } from "./planner.js";
import { runRelay } from "./relay.js";
import type { WorkspaceStore } from "./storage.js";

export class MissingKeysError extends Error {
  constructor() {
    super("Provide at least one of keys.groqApiKey or keys.geminiApiKey (BYOK).");
    this.name = "MissingKeysError";
  }
}

/** The id doubles as the download token, so it must not be guessable. */
export function newWorkspaceId(now = Date.now()): string {
  return `ws_${now}_${randomBytes(8).toString("hex")}`;
}

export function plannerTargets(keys: OrchestrateRequest["keys"], taskType: TaskType): ProviderTarget[] {
  const t: ProviderTarget[] = [];
  if (keys.geminiApiKey) t.push(geminiTarget(keys.geminiApiKey));
  if (keys.groqApiKey) t.push(groqTarget(keys.groqApiKey, taskType));
  return t;
}

export function relayTargets(keys: OrchestrateRequest["keys"], taskType: TaskType): ProviderTarget[] {
  const t: ProviderTarget[] = [];
  if (keys.groqApiKey) t.push(groqTarget(keys.groqApiKey, taskType)); // sprint tier
  if (keys.geminiApiKey) t.push(geminiTarget(keys.geminiApiKey)); // fallback tier
  return t;
}

export async function orchestrate(
  req: OrchestrateRequest,
  store: WorkspaceStore,
): Promise<OrchestrateResponse | GatedResponse> {
  // Stage 1 — zero-token gate, before any state or network.
  const gated = gate(req.userPrompt);
  if (gated) return gated;

  const taskType = req.taskType ?? "code";
  const keys = {
    groqApiKey: req.keys?.groqApiKey?.trim() || undefined,
    geminiApiKey: req.keys?.geminiApiKey?.trim() || undefined,
  };
  if (!keys.groqApiKey && !keys.geminiApiKey) throw new MissingKeysError();

  const ws: BatonWorkspace = {
    workspaceId: newWorkspaceId(),
    userPrompt: req.userPrompt.trim(),
    taskType,
    metadata: {},
    tasks: [],
    artifacts: {},
    executionLogs: [],
  };

  // Stage 2 — planning (Gemini as architect, Groq as safety net).
  await planWorkspace(ws, plannerTargets(keys, taskType));

  // Stage 3 — relay execution with failover.
  const allDone = await runRelay(ws, { targets: relayTargets(keys, taskType) });

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

  return {
    status,
    workspaceId: ws.workspaceId,
    taskType,
    summary: {
      totalTasks: ws.tasks.length,
      completedTasks: completed.length,
      artifactsGenerated: completed.map((t) => t.targetArtifact),
    },
    artifacts: ws.artifacts,
    executionLogs: ws.executionLogs,
    downloadUrl: `/api/download/${ws.workspaceId}`,
  };
}
