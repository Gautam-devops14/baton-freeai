import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/index.js";
import { chatCompletion } from "../src/providers/client.js";
import { buildTargets } from "../src/services/orchestrator.js";
import { calls, installFetch } from "./helpers.js";

const isGemini = (url: string) => url.includes("generativelanguage");
const isNvidia = (url: string) => url.includes("integrate.api.nvidia.com");
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const PLAN = JSON.stringify({ tasks: [
  { title: "Manifest", targetArtifact: "package.json" },
  { title: "Server", targetArtifact: "server.js" },
] });

function reply(content: string, usage?: object, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), { status });
}
const usage = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

// ---- NVIDIA NIM ----

test("NVIDIA NIM: free tier sits after Groq/Gemini and before paid OpenAI", () => {
  const t = buildTargets({ groqApiKey: "g", geminiApiKey: "m", nvidiaApiKey: "n", openaiApiKey: "o" }, "code");
  assert.deepEqual(t.planner.map((x) => x.provider), ["google", "groq", "nvidia", "openai"]);
  assert.deepEqual(t.relay.map((x) => x.provider), ["groq", "google", "nvidia", "openai"]);
  const nv = t.relay[2];
  assert.equal(nv.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(nv.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.deepEqual(nv.fallbackModels, ["nvidia/nemotron-3.5-lightning-30b-a3b", "deepseek-ai/deepseek-v4.1-flash"]);
  const doc = buildTargets({ nvidiaApiKey: "n" }, "document").relay[0];
  assert.equal(doc.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
});

test("NVIDIA: never sends response_format (not all NIM models accept it)", async () => {
  let sent: any;
  installFetch(({ body }) => ((sent = body), reply("{}", usage(1, 1))));
  await chatCompletion(buildTargets({ nvidiaApiKey: "n" }, "code").planner[0], [], { jsonMode: true });
  assert.equal("response_format" in sent, false);
});

test("NVIDIA rescues the user's case: Gemini overloaded + OpenAI out of credit", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
  installFetch(({ url, body }) => {
    if (isGemini(url)) return new Response('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}', { status: 503 });
    if (isNvidia(url)) return isPlanner(body) ? reply(PLAN, usage(300, 60)) : reply("ok", usage(500, 100));
    return new Response('{"error":{"code":"insufficient_quota","message":"check your plan and billing details"}}', { status: 429 });
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate",
    payload: { userPrompt: "Build a server", keys: { geminiApiKey: "m", nvidiaApiKey: "nvapi-x", openaiApiKey: "o" } },
  })).json();
  assert.equal(out.status, "success");
  assert.equal(out.executionLogs.find((l: any) => l.event === "plan").provider, "nvidia");
  assert.ok(!calls.some((c) => c.url.includes("openai.com")), "paid OpenAI never reached");
});

test("NVIDIA: <think> reasoning preamble is stripped from replies", async () => {
  installFetch(() => reply("<think>let me plan this…</think>\nconst x = 1;", usage(5, 5)));
  const r = await chatCompletion(buildTargets({ nvidiaApiKey: "n" }, "code").relay[0], []);
  assert.equal(r.content, "const x = 1;");
});

// ---- Token counting ----

test("usage reported by the provider is returned as-is", async () => {
  installFetch(() => reply("hi", usage(120, 30)));
  const r = await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], [{ role: "user", content: "x" }]);
  assert.deepEqual(r.usage, { promptTokens: 120, completionTokens: 30, totalTokens: 150 });
});

test("missing usage falls back to a ~4 chars/token estimate, flagged as estimated", async () => {
  installFetch(() => reply("x".repeat(40)));
  const r = await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], [{ role: "user", content: "y".repeat(80) }]);
  assert.deepEqual(r.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30, estimated: true });
});

test("run totals: per log entry, per provider, overall, and saved to history", async () => {
  let groqCalls = 0;
  installFetch(({ url, body }) => {
    if (isGemini(url)) return isPlanner(body) ? reply(PLAN, usage(200, 50)) : reply("from gemini", usage(400, 80));
    groqCalls++;
    return groqCalls === 1 ? reply("from groq", usage(300, 100)) : new Response("{}", { status: 429 });
  });
  const app = buildServer();
  const out = (await app.inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build a server", keys: { groqApiKey: "g", geminiApiKey: "m" } },
  })).json();

  assert.deepEqual(out.executionLogs.filter((l: any) => l.tokens).map((l: any) => `${l.event}:${l.provider}:${l.tokens.totalTokens}`), [
    "plan:google:250", "execute:groq:400", "execute:google:480",
  ]);
  assert.equal(out.executionLogs.find((l: any) => l.event === "failover").tokens, undefined, "failed calls cost nothing");
  assert.deepEqual(out.usage, {
    total: { promptTokens: 900, completionTokens: 230, totalTokens: 1130, calls: 3 },
    byProvider: {
      google: { promptTokens: 600, completionTokens: 130, totalTokens: 730, calls: 2 },
      groq: { promptTokens: 300, completionTokens: 100, totalTokens: 400, calls: 1 },
    },
    byModel: [
      { provider: "google", model: "gemini-3.8-flash", promptTokens: 600, completionTokens: 130, totalTokens: 730, calls: 2 },
      { provider: "groq", model: "openai/gpt-oss-120b", promptTokens: 300, completionTokens: 100, totalTokens: 400, calls: 1 },
    ],
  });
  const summary = (await app.inject({ method: "GET", url: "/api/history" })).json().runs.find((r: any) => r.id === out.historyId);
  assert.equal(summary.usage.total.totalTokens, 1130);
});

test("tokens spent on an unusable plan are still counted on a failed run", async () => {
  installFetch(() => reply('{"tasks":[{"title":"no path"}]}', usage(100, 20)));
  const res = await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build a server", keys: { geminiApiKey: "m" } },
  });
  assert.equal(res.statusCode, 502);
  const body = res.json();
  assert.equal(body.executionLogs[0].tokens.totalTokens, 120);
  const rec = (await buildServer().inject({ method: "GET", url: `/api/history/${body.historyId}` })).json();
  assert.equal(rec.usage.total.totalTokens, 120);
});
