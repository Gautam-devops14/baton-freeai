// Fastify server: route registration and process entrypoint (spec §4).

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { pathToFileURL } from "node:url";
import { contentTypeFor, PREVIEW_CSP, previewEntry, withPreviewShim } from "./services/preview.js";
import { createArtifactZip } from "./services/bundler.js";
import { mergeBreakdowns, mergeUsage } from "./services/logging.js";
import { cancelRun, CLIENT_RUN_ID_RE, registerRun, subscribeProgress } from "./services/progress.js";
import { providerOrder } from "./services/orchestrator.js";
import { DEFAULT_TIMEOUT_MS } from "./providers/client.js";
import { forgetProviderMemory, snapshotMemory } from "./providers/memory.js";
import { snapshotCircuits } from "./providers/circuitBreaker.js";
import { recentCalls } from "./providers/trace.js";
import { GROQ_BASE_URL, GROQ_MODELS } from "./providers/groq.js";
import { GEMINI_BASE_URL, GEMINI_MODELS } from "./providers/gemini.js";
import { NVIDIA_BASE_URL, NVIDIA_MODELS } from "./providers/nvidia.js";
import { OPENAI_BASE_URL, OPENAI_MODELS } from "./providers/openai.js";
import { OPENROUTER_BASE_URL, OPENROUTER_MODELS } from "./providers/openrouter.js";
import { WORKSPACE_TTL_SECONDS } from "./services/storage.js";
import { testKeys } from "./services/keytest.js";
import { allExportFiles, chatExportFiles, groupChats } from "./services/export.js";
import { cleanProjectName, defaultProjectName, slugify } from "./services/project.js";
import { diffFile } from "./services/diff.js";
import { computeHealth } from "./services/health.js";
import { buildTargets as targetsFor } from "./services/orchestrator.js";
import { chatCompletion, ProviderError } from "./providers/client.js";
import type { CallTrace } from "./types.js";

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
      resumeFrom: { type: "string", pattern: "^(ws|run)_[A-Za-z0-9_]+$" },
      chatId: { type: "string", pattern: "^(ws|run)_[A-Za-z0-9_]+$" },
      clientRunId: { type: "string", pattern: "^[a-f0-9]{8,64}$" },
      providerOrder: {
        type: "array",
        maxItems: 5,
        uniqueItems: true,
        items: { type: "string", enum: ["nvidia", "groq", "google", "gemini", "openrouter", "openai"] },
      },
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
    // Stop: the browser aborts its request (closing the connection) and/or calls POST /api/cancel/:clientRunId.
    // Either way every upstream provider request is cancelled at once; finished files are kept.
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", onClose);
    const unregister = req.body.clientRunId ? registerRun(req.body.clientRunId, controller) : () => {};
    try {
      return await orchestrate({ ...req.body, keys: req.body.keys ?? {} }, store, history, { signal: controller.signal });
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
    } finally {
      unregister();
      reply.raw.off("close", onClose);
    }
  });

  // ---- Stop a running request (the Stop button) ----
  app.post<{ Params: { id: string } }>("/api/cancel/:id", async (req, reply) => {
    if (!CLIENT_RUN_ID_RE.test(req.params.id)) return reply.code(400).send({ status: "error", error: "bad_id" });
    return { cancelled: cancelRun(req.params.id) };
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
  const debugInfo = async () => {
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
      circuits: snapshotCircuits(),
      recentCalls: recentCalls(100),
    };
  };
  app.get("/api/debug", debugInfo);

  // ---- Export: transcript + complete data + latest files, as a zip (never keys) ----
  const sendZip = (reply: FastifyReply, name: string, files: Record<string, string>) =>
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(createArtifactZip(files));
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  app.get<{ Params: { chatId: string } }>("/api/export/chat/:chatId", async (req, reply) => {
    const files = HISTORY_ID_RE.test(req.params.chatId) ? await chatExportFiles(history, req.params.chatId) : undefined;
    if (!files) return reply.code(404).send({ status: "error", error: "not_found", message: "No such chat in history." });
    const meta = await history.getChatMeta(req.params.chatId);
    const first = groupChats(await history.list(Number.MAX_SAFE_INTEGER)).get(req.params.chatId)?.[0];
    const name = slugify(meta?.projectName ?? defaultProjectName(first?.userPrompt ?? "chat"));
    return sendZip(reply, `${name}-chat-export-${stamp()}.zip`, files);
  });

  app.get("/api/export/all", async (_req, reply) => sendZip(reply, `baton-all-chats-${stamp()}.zip`, await allExportFiles(history, await debugInfo())));

  app.delete("/api/debug/memory", async (_req, reply) => {
    forgetProviderMemory();
    return reply.code(204).send();
  });

  // Token usage across saved runs, per provider and per model. "Today" uses the server's local date.
  app.get("/api/usage", async () => {
    const runs = await history.list(Number.MAX_SAFE_INTEGER);
    const todayKey = new Date().toDateString();
    const isToday = (iso: string) => new Date(iso).toDateString() === todayKey;
    const pick = (rs: typeof runs) => ({
      ...mergeUsage(rs.flatMap((r) => (r.usage ? [r.usage] : []))),
      breakdown: mergeBreakdowns(rs.map((r) => r.breakdown)),
    });
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

  // ---- Project names (per chat): used for downloads and exports ----
  /** The chat a run belongs to, its project name (set by the user or derived from the first prompt). */
  const projectFor = async (runId: string): Promise<{ chatId: string; name: string; custom: boolean } | undefined> => {
    const rec = await history.get(runId);
    if (!rec) return undefined;
    const runs = await history.list(Number.MAX_SAFE_INTEGER);
    const chats = groupChats(runs);
    const chatId = [...chats].find(([, list]) => list.some((r) => r.id === runId))?.[0] ?? rec.chatId ?? rec.id;
    const meta = await history.getChatMeta(chatId);
    if (meta?.projectName) return { chatId, name: meta.projectName, custom: true };
    const first = chats.get(chatId)?.[0];
    return { chatId, name: defaultProjectName(first?.userPrompt ?? rec.userPrompt), custom: false };
  };

  app.get("/api/chats", async () => {
    const runs = await history.list(Number.MAX_SAFE_INTEGER);
    const metas = new Map((await history.listChatMeta()).map((m) => [m.chatId, m]));
    return {
      chats: [...groupChats(runs)].map(([chatId, list]) => ({
        chatId,
        projectName: metas.get(chatId)?.projectName ?? defaultProjectName(list[0].userPrompt),
        custom: Boolean(metas.get(chatId)?.projectName),
        slug: slugify(metas.get(chatId)?.projectName ?? defaultProjectName(list[0].userPrompt)),
      })),
    };
  });

  app.put<{ Params: { chatId: string }; Body: { projectName?: string } }>(
    "/api/chats/:chatId",
    { schema: { body: { type: "object", properties: { projectName: { type: "string", maxLength: 200 } } } } },
    async (req, reply) => {
      if (!HISTORY_ID_RE.test(req.params.chatId)) return reply.code(400).send({ status: "error", error: "bad_id" });
      const name = req.body.projectName === "" ? "" : cleanProjectName(req.body.projectName);
      if (name === undefined) return reply.code(400).send({ status: "error", error: "bad_name", message: "Project name must be 1-80 characters." });
      const meta = { chatId: req.params.chatId, projectName: name || undefined, updatedAt: new Date().toISOString() };
      await history.setChatMeta(meta);
      return { ...meta, slug: name ? slugify(name) : undefined };
    },
  );

  // ---- Diff: what a run changed in each file, versus the run it continued ----
  app.get<{ Params: { id: string } }>("/api/history/:id/diff", async (req, reply) => {
    const rec = await history.get(req.params.id);
    if (!rec) return reply.code(404).send({ status: "error", error: "not_found" });
    const parent = rec.parentId ? await history.get(rec.parentId) : undefined;
    const before = parent?.artifacts ?? {};
    const changed = rec.changes ? [...rec.changes.modified, ...rec.changes.added] : Object.keys(rec.artifacts);
    return {
      runId: rec.id,
      parentId: parent?.id,
      files: changed.map((p) => diffFile(p, before[p], rec.artifacts[p])),
    };
  });

  // ---- Provider health: success rate, speed and errors per provider/model ----
  app.get<{ Querystring: { days?: string } }>("/api/health", async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const runs = (await history.list(Number.MAX_SAFE_INTEGER)).filter((r) => r.createdAt >= since);
    const calls: CallTrace[] = [];
    for (const r of runs) calls.push(...((await history.get(r.id))?.calls ?? []));
    const rows = computeHealth(calls);
    // Providers Baton is skipping right now (busy, key rejected, no credit...), with the reason.
    return { since, runs: runs.length, models: rows, skipping: snapshotMemory().busyProviders };
  });

  // ---- Replay: send one step's exact recorded prompt to a chosen provider/model ----
  app.post<{ Body: { historyId: string; step: number; provider: string; model?: string; keys: OrchestrateRequest["keys"] } }>(
    "/api/replay",
    {
      schema: {
        body: {
          type: "object",
          required: ["historyId", "step", "provider", "keys"],
          properties: {
            historyId: { type: "string", pattern: "^(ws|run)_[A-Za-z0-9_]+$" },
            step: { type: "integer", minimum: 0, maximum: 100 },
            provider: { type: "string", enum: ["nvidia", "groq", "google", "openrouter", "openai"] },
            model: { type: "string", maxLength: 200 },
            keys: orchestrateSchema.body.properties.keys,
          },
        },
      },
    },
    async (req, reply) => {
      const rec = await history.get(req.body.historyId);
      const ctx = rec?.contexts?.find((c) => c.step === req.body.step);
      if (!rec || !ctx) return reply.code(404).send({ status: "error", error: "not_found", message: "No recorded prompt for that run and step." });
      const keys = Object.fromEntries(Object.entries(req.body.keys ?? {}).map(([k, v]) => [k, typeof v === "string" ? v.trim() || undefined : undefined]));
      const base = targetsFor(keys, rec.taskType, [req.body.provider]).relay[0];
      if (!base) return reply.code(400).send({ status: "error", error: "missing_keys", message: `Add a key for ${req.body.provider} to replay with it.` });
      const model = req.body.model?.trim();
      // A specific model: exactly that one (no fallbacks). Otherwise the provider's normal model list.
      const target = model ? { ...base, model, fallbackModels: [], modelHints: undefined } : base;
      const started = Date.now();
      try {
        const r = await chatCompletion(target, ctx.messages, ctx.kind === "plan" ? { jsonMode: true, temperature: 0.1 } : {});
        return { ok: true, provider: target.provider, model: r.model, latencyMs: Date.now() - started, usage: r.usage, reply: r.content, skippedModels: r.skippedModels };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : undefined;
        return { ok: false, provider: target.provider, model: pe?.model ?? target.model, latencyMs: Date.now() - started, error: pe ? pe.reason : String((err as Error)?.message ?? err), kind: pe?.kind };
      }
    },
  );

  // ---- Live preview (sandboxed) ----
  const previewFiles = async (id: string) =>
    HISTORY_ID_RE.test(id) ? ((await store.get(id))?.artifacts ?? (await history.get(id))?.artifacts) : undefined;
  app.get<{ Params: { id: string } }>("/api/preview/:id", async (req, reply) => {
    const files = await previewFiles(req.params.id);
    const entry = files && previewEntry(files);
    if (!entry) return reply.code(404).send({ status: "error", error: "no_preview", message: "This project has no HTML page to preview." });
    return reply.redirect(`/api/preview/${req.params.id}/${entry.split("/").map(encodeURIComponent).join("/")}`);
  });
  app.get<{ Params: { id: string; "*": string } }>("/api/preview/:id/*", async (req, reply) => {
    const files = await previewFiles(req.params.id);
    const path = decodeURIComponent(req.params["*"] || "").replace(/^\/+/, "");
    const target = files && (files[path] !== undefined ? path : path === "" ? previewEntry(files) : undefined);
    reply.header("Content-Security-Policy", PREVIEW_CSP).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store");
    if (!files || !target) return reply.code(404).type("text/plain; charset=utf-8").send(`Not in this project: ${path}`);
    const body = /\.html?$/i.test(target) ? withPreviewShim(files[target]) : files[target];
    return reply.type(contentTypeFor(target)).send(body);
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
    // Named after the project: student-portal.zip with a student-portal/ folder inside.
    const project = await projectFor(workspaceId).catch(() => undefined);
    const slug = project ? slugify(project.name) : workspaceId;
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${slug}.zip"`);
    return reply.send(createArtifactZip(artifacts, project ? slug : undefined));
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
