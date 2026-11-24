import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { buildTargets } from "../src/services/orchestrator.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const ALL = { groqApiKey: "g", geminiApiKey: "m", nvidiaApiKey: "n", openrouterApiKey: "r", openaiApiKey: "o" };
const server = () => buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-ord-"))), store: new InMemoryWorkspaceStore() });
const host = (u: string) => new URL(u).hostname;

test("buildTargets: a per-request order is used for planning and building; unlisted providers are left out", () => {
  const t = buildTargets(ALL, "code", ["groq", "gemini", "openrouter"]);
  assert.deepEqual(t.planner.map((x) => x.provider), ["groq", "google", "openrouter"]);
  assert.deepEqual(t.relay.map((x) => x.provider), ["groq", "google", "openrouter"]);
});

test("the UI's order decides which AI is called first, and switched-off providers are never called", async () => {
  installFetch(({ body }) => (isPlanner(body) ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}') : reply("<h1>hi</h1>")));
  const app = server();
  const out = (await app.inject({
    method: "POST", url: "/api/orchestrate",
    payload: { userPrompt: "page", keys: ALL, providerOrder: ["groq", "openrouter"] }, // NVIDIA, Gemini, OpenAI switched off
  })).json();
  assert.equal(out.status, "success");
  assert.ok(calls.every((c) => host(c.url).includes("groq")), "only Groq was needed");
  const rec = (await app.inject({ method: "GET", url: `/api/history/${out.historyId}` })).json();
  assert.deepEqual(rec.providerOrder, ["groq", "openrouter"]);
  assert.deepEqual(rec.providers, ["groq", "openrouter"], "keys used = enabled providers that have keys");
});

test("order is followed on failover too", async () => {
  installFetch(({ url, body }) => {
    if (host(url).includes("groq")) return new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 });
    return isPlanner(body) ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}') : reply("ok");
  });
  const out = (await server().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: ALL, providerOrder: ["groq", "openrouter", "google"] },
  })).json();
  assert.equal(out.executionLogs.find((l: any) => l.event === "plan").provider, "openrouter", "second in the chosen order");
  assert.ok(!calls.some((c) => host(c.url).includes("nvidia") || host(c.url).includes("openai.com")));
});

test("without an order, the server default applies (and records it)", async () => {
  installFetch(({ body }) => (isPlanner(body) ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}') : reply("ok")));
  const app = server();
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: { groqApiKey: "g", geminiApiKey: "m" } } })).json();
  const rec = (await app.inject({ method: "GET", url: `/api/history/${out.historyId}` })).json();
  assert.deepEqual(rec.providerOrder, ["groq", "google"]); // test env relay order: groq,google,...
});

test("every keyed provider switched off -> clear 400; unknown provider names -> 400", async () => {
  installFetch(() => reply("x"));
  const app = server();
  const off = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: { groqApiKey: "g" }, providerOrder: ["nvidia"] } });
  assert.equal(off.statusCode, 400);
  assert.match(off.json().message, /switched off in the provider order/);
  const bad = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: { groqApiKey: "g" }, providerOrder: ["mystery-ai"] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.length, 0);
});
