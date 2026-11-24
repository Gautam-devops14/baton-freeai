// Fastify server: route registration and process entrypoint (spec §4).

import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { createArtifactZip } from "./services/bundler.js";
import { MissingKeysError, orchestrate } from "./services/orchestrator.js";
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
      taskType: { type: "string", enum: ["code", "document", "analysis"] },
      keys: {
        type: "object",
        additionalProperties: false,
        properties: {
          groqApiKey: { type: "string", maxLength: 512 },
          geminiApiKey: { type: "string", maxLength: 512 },
        },
      },
    },
  },
} as const;

export interface ServerOptions {
  store?: WorkspaceStore;
  logger?: boolean;
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const store = opts.store ?? new InMemoryWorkspaceStore();
  // Requests carry user API keys: keep logging to method/url/status only.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(UI_HTML));
  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: OrchestrateRequest }>("/api/orchestrate", { schema: orchestrateSchema }, async (req, reply) => {
    try {
      return await orchestrate({ ...req.body, keys: req.body.keys ?? {} }, store);
    } catch (err) {
      if (err instanceof MissingKeysError) {
        return reply.code(400).send({ status: "error", error: "missing_keys", message: err.message });
      }
      if (err instanceof PlanningError) {
        return reply.code(502).send({ status: "error", error: "planning_failed", message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { workspaceId: string } }>("/api/download/:workspaceId", async (req, reply) => {
    const { workspaceId } = req.params;
    const ws = /^ws_[\w]+$/.test(workspaceId) ? await store.get(workspaceId) : undefined;
    if (!ws) {
      return reply.code(404).send({ status: "error", error: "not_found", message: "Workspace not found or expired." });
    }
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${workspaceId}.zip"`);
    return reply.send(createArtifactZip(ws.artifacts));
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
