// Fastify server: route registration and process entrypoint (spec §4).

import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { createArtifactZip } from "./services/bundler.js";
import { mergeUsage } from "./services/logging.js";
import { CLIENT_RUN_ID_RE, subscribeProgress } from "./services/progress.js";
import { providerOrder } from "./services/orchestrator.js";
import { DEFAULT_TIMEOUT_MS } from "./providers/client.js";
import { forgetProviderMemory, snapshotMemory } from "./providers/memory.js";
import { recentCalls } from "./providers/trace.js";
import { GROQ_BASE_URL, GROQ_MODELS } from "./providers/groq.js";
import { GEMINI_BASE_URL, GEMINI_MODELS } from "./providers/gemini.js";
import { NVIDIA_BASE_URL, NVIDIA_MODELS } from "./providers/nvidia.js";
import { OPENAI_BASE_URL, OPENAI_MODELS } from "./providers/openai.js";
import { OPENROUTER_BASE_URL, OPENROUTER_MODELS } from "./providers/openrouter.js";
import { WORKSPACE_TTL_SECONDS } from "./services/storage.js";
import { testKeys } from "./services/keytest.js";

const STARTED_AT = new Date().toISOString();
import { FileHistoryStore, HISTORY_ID_RE, type HistoryStore } from "./services/history.js";
import { FollowUpError, MissingKeysError, orchestrate, type OrchestrationErrorInfo } from "./services/orchestrator.js";
import { PlanningError } from "./services/planner.js";
import { InMemoryWorkspaceStore, type WorkspaceStore } from "./services/storage.js";
import type { OrchestrateRequest } from "./types.js";
import { UI_HTML } from "./ui.js";

const orchestrateSchema = {
  body: {
    type: "object",
    required: ["userPrompt"],
    additionalProperties: false,
    properties: {
      userPrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      continueFrom: { type: "string", pattern: "^(ws|run)_[A-Za-z0-9_]+$" },
      chatId: { type: "string", pattern: "^(ws|run)_[A-Za-z0-9_]+$" },
      clientRunId: { type: "string", pattern: "^[a-f0-9]{8,64}$" },
      taskType: { type: "string", enum: ["code", "document", "analysis"] },
      keys: {
        type: "object",
        additionalProperties: false,
        properties: {
          groqApiKey: { type: "string", maxLength: 512 },
          geminiApiKey: { type: "string", maxLength: 512 },
          openaiApiKey: { type: "string", maxLength: 512 },
          nvidiaApiKey: { type: "string", maxLength: 512 },
          openrouterApiKey: { type: "string", maxLength: 512 },
        },
      },
    },
  },
} as const;

export interface ServerOptions {
  store?: WorkspaceStore;
  history?: HistoryStore;
  logger?: boolean;
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const store = opts.store ?? new InMemoryWorkspaceStore();
  const history = opts.history ?? new FileHistoryStore(process.env.BATON_DATA_DIR ?? "data");
  // Requests carry user API keys: keep logging to method/url/status only.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(UI_HTML));
  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: OrchestrateRequest }>("/api/orchestrate", { schema: orchestrateSchema }, async (req, reply) => {
    try {
      return await orchestrate({ ...req.body, keys: req.body.keys ?? {} }, store, history);
    } catch (err) {
      const info = err as OrchestrationErrorInfo;
      const extra = { historyId: info.historyId, executionLogs: info.executionLogs ?? [] };
      if (err instanceof MissingKeysError) {
        return reply.code(400).send({ status: "error", error: "missing_keys", message: err.message, ...extra });
      }
      if (err instanceof FollowUpError) {
        return reply.code(404).send({ status: "error", error: "follow_up_not_found", message: err.message, ...extra });
      }
      if (err instanceof PlanningError) {
        return reply.code(502).send({ status: "error", error: "planning_failed", message: err.message, ...extra });
      }
      throw err;
    }
  });

  // ---- History: every prompt and its outcome, persisted on disk ----

  app.get<{ Querystring: { limit?: string } }>("/api/history", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    return { runs: await history.list(limit) };
  });

  // ---- Live progress (Server-Sent Events) ----
  app.get<{ Params: { id: string } }>("/api/progress/:id", (req, reply) => {
    if (!CLIENT_RUN_ID_RE.test(req.params.id)) return reply.code(400).send({ status: "error", error: "bad_id" });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    raw.write(": connected\n\n");
    const heartbeat = setInterval(() => raw.write(": ping\n\n"), 15_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    };
    const unsubscribe = subscribeProgress(req.params.id, (e) => {
      raw.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === "done") setImmediate(close);
    });
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- Test API keys with free requests (no tokens spent) ----
  app.post<{ Body: { keys: OrchestrateRequest["keys"] } }>(
    "/api/keys/test",
    { schema: { body: { type: "object", required: ["keys"], properties: { keys: orchestrateSchema.body.properties.keys } } } },
    async (req) => ({ results: await testKeys(req.body.keys) }),
  );

  // ---- Debug: server configuration and runtime state (never keys or prompts) ----
  app.get("/api/debug", async () => {
    const runs = await history.list(Number.MAX_SAFE_INTEGER);
    return {
      server: {
        startedAt: STARTED_AT,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        pid: process.pid,
        dataDir: process.env.BATON_DATA_DIR ?? "data",
        historyRuns: runs.length,
      },
      providerOrder: { planner: providerOrder("planner"), relay: providerOrder("relay") },
      models: {
        groq: GROQ_MODELS,
        google: GEMINI_MODELS,
        nvidia: NVIDIA_MODELS,
        openrouter: OPENROUTER_MODELS,
        openai: OPENAI_MODELS,
      },
      endpoints: { groq: GROQ_BASE_URL, google: GEMINI_BASE_URL, nvidia: NVIDIA_BASE_URL, openrouter: OPENROUTER_BASE_URL, openai: OPENAI_BASE_URL },
      settings: {
        providerTimeoutMs: DEFAULT_TIMEOUT_MS,
        overloadRetryMs: Number(process.env.BATON_OVERLOAD_RETRY_MS ?? 2000),
        busySkipMs: Number(process.env.BATON_BUSY_SKIP_MS ?? 300_000),
        dailyLimitSkipMs: Number(process.env.BATON_DAILY_LIMIT_SKIP_MS ?? 3_600_000),
        deadModelTtlMs: Number(process.env.BATON_DEAD_MODEL_TTL_MS ?? 86_400_000),
        workspaceTtlSec: WORKSPACE_TTL_SECONDS,
        historyMax: Number(process.env.BATON_HISTORY_MAX ?? 500),
      },
      memory: snapshotMemory(),
      recentCalls: recentCalls(100),
    };
  });

  app.delete("/api/debug/memory", async (_req, reply) => {
    forgetProviderMemory();
    return reply.code(204).send();
  });

  // Token usage across saved runs, per provider and per model. "Today" uses the server's local date.
  app.get("/api/usage", async () => {
    const runs = await history.list(Number.MAX_SAFE_INTEGER);
    const todayKey = new Date().toDateString();
    const isToday = (iso: string) => new Date(iso).toDateString() === todayKey;
    const pick = (rs: typeof runs) => mergeUsage(rs.flatMap((r) => (r.usage ? [r.usage] : [])));
    const todays = runs.filter((r) => isToday(r.createdAt));
    return {
      today: { runs: todays.length, ...pick(todays) },
      allTime: { runs: runs.length, since: runs.at(-1)?.createdAt, ...pick(runs) },
    };
  });

  app.get<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const rec = await history.get(req.params.id);
    if (!rec) return reply.code(404).send({ status: "error", error: "not_found", message: "No such run in history." });
    return { ...rec, downloadUrl: Object.keys(rec.artifacts).length ? `/api/download/${rec.id}` : undefined };
  });

  app.delete<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const existed = await history.delete(req.params.id);
    await store.delete(req.params.id);
    return reply.code(existed ? 204 : 404).send();
  });

  app.delete("/api/history", async (_req, reply) => {
    await history.clear();
    return reply.code(204).send();
  });

  app.get<{ Params: { workspaceId: string } }>("/api/download/:workspaceId", async (req, reply) => {
    const { workspaceId } = req.params;
    // Live workspace first, then history (so downloads survive restarts and the 1h workspace TTL).
    const artifacts = !HISTORY_ID_RE.test(workspaceId)
      ? undefined
      : ((await store.get(workspaceId))?.artifacts ?? (await history.get(workspaceId))?.artifacts);
    if (!artifacts || Object.keys(artifacts).length === 0) {
      return reply.code(404).send({ status: "error", error: "not_found", message: "Workspace not found or expired." });
    }
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${workspaceId}.zip"`);
    return reply.send(createArtifactZip(artifacts));
  });

  return app;
}

async function main() {
  const app = buildServer({ logger: true });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
