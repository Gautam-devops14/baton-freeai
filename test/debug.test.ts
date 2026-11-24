import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const PLAN = '{"tasks":[{"title":"Page","targetArtifact":"index.html"},{"title":"Logic","targetArtifact":"app.js"}]}';
const server = () => buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-dbg-"))), store: new InMemoryWorkspaceStore() });
const post = (app: any, payload: object) => app.inject({ method: "POST", url: "/api/orchestrate", payload });

test("chat threads: a new project starts a chat; follow-ups and messages sent with chatId join it", async () => {
  installFetch(({ body }) => (isPlanner(body) ? reply(PLAN) : reply("x")));
  const app = server();
  const keys = { groqApiKey: "g" };
  const first = (await post(app, { userPrompt: "Build an app", keys })).json();
  assert.equal(first.chatId, first.historyId);
  const follow = (await post(app, { userPrompt: "add a button", keys, continueFrom: first.historyId })).json();
  assert.equal(follow.chatId, first.chatId);
  const thanks = (await post(app, { userPrompt: "thanks", chatId: first.chatId })).json();
  const runs = (await app.inject({ method: "GET", url: "/api/history" })).json().runs;
  assert.deepEqual(runs.map((r: any) => r.chatId), [first.chatId, first.chatId, first.chatId]);
  assert.ok(runs.some((r: any) => r.id === thanks.historyId));
});

test("every provider call is traced on the run (status, latency, tokens) and in /api/debug", async () => {
  let n = 0;
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply(PLAN);
    return ++n === 1 ? new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }) : reply("x");
  });
  const app = server();
  const out = (await post(app, { userPrompt: "Build an app", keys: { groqApiKey: "g", geminiApiKey: "m" } })).json();
  const calls = out.calls.map((c: any) => `${c.step}:${c.provider}:${c.status}:${c.outcome}`);
  assert.deepEqual(calls, ["0:google:200:ok", "1:groq:429:rate_limit", "1:google:200:ok", "2:google:200:ok"]);
  assert.ok(out.calls.every((c: any) => typeof c.latencyMs === "number" && c.host && c.runId === out.historyId));
  assert.equal(out.calls[0].tokens.totalTokens, 20);

  const rec = (await app.inject({ method: "GET", url: `/api/history/${out.historyId}` })).json();
  assert.equal(rec.calls.length, 4);

  const dbg = (await app.inject({ method: "GET", url: "/api/debug" })).json();
  assert.deepEqual(dbg.providerOrder.relay, ["groq", "google", "nvidia", "openai"]);
  assert.equal(dbg.models.groq.code[0], "openai/gpt-oss-120b");
  assert.ok(dbg.settings.providerTimeoutMs > 0);
  assert.ok(dbg.recentCalls.some((c: any) => c.runId === out.historyId && c.status === 429));
  assert.equal(dbg.server.historyRuns, 1);
  assert.doesNotMatch(JSON.stringify(dbg), /"g"|"m"|Bearer/, "no API keys in debug output");
});

test("/api/debug shows remembered retired models and busy providers; DELETE clears them", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
  installFetch(({ url, model, body }) => {
    if (url.includes("generativelanguage")) return new Response('{"error":{"message":"high demand","status":"UNAVAILABLE"}}', { status: 503 });
    if (model === "openai/gpt-oss-120b") return new Response(JSON.stringify({ error: { message: "The model does not exist" } }), { status: 404 });
    return isPlanner(body) ? reply(PLAN) : reply("x");
  });
  const app = server();
  await post(app, { userPrompt: "Build an app", keys: { groqApiKey: "g", geminiApiKey: "m" } });
  const mem = (await app.inject({ method: "GET", url: "/api/debug" })).json().memory;
  assert.deepEqual(mem.retiredModels.map((m: any) => `${m.provider}:${m.model}`), ["groq:openai/gpt-oss-120b"]);
  assert.deepEqual(mem.busyProviders.map((b: any) => b.provider), ["google"]);
  assert.match(mem.busyProviders[0].keyHash, /^[0-9a-f]{12}$/);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/debug/memory" })).statusCode, 204);
  const after = (await app.inject({ method: "GET", url: "/api/debug" })).json().memory;
  assert.equal(after.retiredModels.length + after.busyProviders.length + after.discoveredModels.length, 0);
});

test("live progress over Server-Sent Events: start, plan, calls, logs, done", async () => {
  installFetch(({ body }) => (isPlanner(body) ? reply(PLAN) : reply("x")));
  const app = server();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  try {
    const id = "abcdef0123456789";
    // Subscribe first (like the browser), using Node's real HTTP stack.
    const http = await import("node:http");
    const events: any[] = [];
    const sse = new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/progress/${id}`, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream");
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          for (const block of buf.split("\n\n").slice(0, -1)) {
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
          buf = buf.split("\n\n").at(-1)!;
        });
        res.on("end", () => resolve());
      }).on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    const out = (await post(app, { userPrompt: "Build an app", keys: { groqApiKey: "g" }, clientRunId: id })).json();
    await sse;
    const types = events.map((e) => e.type);
    assert.equal(types[0], "start");
    assert.equal(types.at(-1), "done");
    assert.ok(types.includes("plan"));
    assert.ok(events.some((e) => e.type === "call" && e.call.phase === "start"), "call starts are streamed live");
    assert.ok(events.some((e) => e.type === "log" && e.entry.event === "execute"));
    assert.equal(events.at(-1).historyId, out.historyId);
    assert.equal(events.at(-1).status, "success");
  } finally {
    await app.close();
  }
});

test("progress ids are validated", async () => {
  const app = server();
  assert.equal((await app.inject({ method: "GET", url: "/api/progress/NOT-HEX" })).statusCode, 400);
  const bad = await post(app, { userPrompt: "hi", clientRunId: "../../x" });
  assert.equal(bad.statusCode, 400);
});
