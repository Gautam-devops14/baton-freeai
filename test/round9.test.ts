import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { chatCompletion } from "../src/providers/client.js";
import { rankModels } from "../src/providers/discovery.js";
import { busyUntilFor, snapshotMemory } from "../src/providers/memory.js";
import { FileHistoryStore } from "../src/services/history.js";
import { buildTargets } from "../src/services/orchestrator.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const server = () => buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-r9-"))), store: new InMemoryWorkspaceStore() });
const post = (app: any, payload: object) => app.inject({ method: "POST", url: "/api/orchestrate", payload });
const PLAN3 = '{"tasks":[{"title":"Logic","targetArtifact":"script.js"},{"title":"Page","targetArtifact":"index.html"},{"title":"Cart","targetArtifact":"cart.html"}]}';
const eol = (m: string) => new Response(JSON.stringify({ status: 410, title: "Gone", detail: `The model '${m}' has reached its end of life on 2026-06-11T00:00:00Z and is no longer available` }), { status: 410 });

test("NVIDIA discovery skips code-completion models like starcoder2 and tries several chat models", () => {
  const t = buildTargets({ nvidiaApiKey: "n" }, "code").relay[0];
  const live = ["bigcode/starcoder2-15b", "google/codegemma-7b", "deepseek-ai/deepseek-v3.2", "moonshotai/kimi-k2.5-instruct",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5", "meta/llama-3.1-8b-instruct", "nvidia/nv-embedqa-e5-v5", "qwen/qwen3-coder-next-instruct"]
    .filter((id) => !t.modelFilter || t.modelFilter.test(id));
  const picked = rankModels(live, t.modelHints!, new Set(), 5);
  assert.ok(!picked.some((m) => /starcoder|codegemma|embed/.test(m)), picked.join());
  assert.equal(picked[0], "qwen/qwen3-coder-next-instruct");
  assert.ok(picked.length >= 4);
});

test("the user's run: NVIDIA retired, Groq briefly rate limited, others down -> waits for Groq and finishes", async () => {
  process.env.BATON_MAX_RATE_WAIT_MS = "5000";
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
  let groqBuilds = 0;
  installFetch(({ url, model, body }) => {
    const host = new URL(url).hostname;
    if (host.includes("nvidia")) return url.endsWith("/models") ? new Response(JSON.stringify({ data: [{ id: "bigcode/starcoder2-15b" }] })) : eol(model);
    if (host.includes("groq")) {
      if (isPlanner(body)) return reply(PLAN3);
      return ++groqBuilds === 3
        ? new Response('{"error":{"message":"Rate limit reached for model openai/gpt-oss-120b. Please try again in 0.3s."}}', { status: 429 })
        : reply(`// built by groq ${groqBuilds}`);
    }
    if (host.includes("generativelanguage")) return new Response('{"error":{"message":"high demand","status":"UNAVAILABLE"}}', { status: 503 });
    if (host.includes("openrouter")) return new Response('{"error":{"message":"Missing Authentication header","code":401}}', { status: 401 });
    return new Response('{"error":{"code":"insufficient_quota","message":"check your plan and billing details"}}', { status: 429 });
  });
  const app = server();
  const keys = { groqApiKey: "g", geminiApiKey: "m", nvidiaApiKey: "n", openrouterApiKey: "r", openaiApiKey: "o" };
  const out = await (async () => {
    const saved = [process.env.BATON_PLANNER_ORDER, process.env.BATON_RELAY_ORDER];
    process.env.BATON_PLANNER_ORDER = process.env.BATON_RELAY_ORDER = "nvidia,groq,google,openrouter,openai";
    try { return (await post(app, { userPrompt: "shop with cart", keys })).json(); }
    finally { [process.env.BATON_PLANNER_ORDER, process.env.BATON_RELAY_ORDER] = saved; process.env.BATON_MAX_RATE_WAIT_MS = "0"; }
  })();

  assert.equal(out.status, "success", JSON.stringify(out.executionLogs.map((l: any) => l.message), null, 1));
  assert.deepEqual(out.summary.artifactsGenerated, ["script.js", "index.html", "cart.html"]);
  const msgs = out.executionLogs.map((l: any) => `${l.step}|${l.provider}/${l.model}|${l.message}`);
  // NVIDIA: discovery never tried starcoder2; once out of models it is skipped (logged once), not "tried" every step.
  assert.ok(!out.calls.some((c: any) => c.model === "bigcode/starcoder2-15b"));
  assert.equal(msgs.filter((m: string) => m.includes("|skipped: nvidia: none of its models are available")).length, 1, msgs.join("\n"));
  assert.ok(!msgs.some((m: string) => /^[123]\|nvidia\/.*passing baton/.test(m)), "no fake per-step NVIDIA failovers");
  // Groq's rate limit was on gpt-oss-120b only: Groq's next model built cart.html straight away.
  assert.ok(msgs.some((m: string) => m.startsWith("3|groq/openai/gpt-oss-120b|HTTP 429 rate limit detected; retrying with llama-3.3-70b-versatile")), msgs.join("\n"));
  assert.ok(msgs.some((m: string) => m.startsWith("3|groq/llama-3.3-70b-versatile|Generated cart.html successfully")));
  assert.ok(!out.calls.some((c: any) => c.step === 3 && c.provider !== "groq"), "no detour to slower providers");
  // NVIDIA (no working models) is remembered as a skip, with the reason. OpenRouter and OpenAI were never needed.
  const reasons = Object.fromEntries(snapshotMemory().busyProviders.map((b) => [b.provider, b.reason]));
  assert.match(reasons.nvidia, /none of its models/);
  assert.equal(reasons.openrouter, undefined);
});

test("Groq's 'Please try again in Xs' text is read as the retry time when there is no Retry-After header", async () => {
  installFetch(() => new Response('{"error":{"message":"Rate limit reached ... Please try again in 1m2.5s."}}', { status: 429 }));
  await assert.rejects(chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], []), (e: any) => e.retryAfterMs === 62_500);
});

test("a rejected key skips that provider in later runs (10 min) until the key changes", async () => {
  installFetch(() => new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 }));
  const t = buildTargets({ groqApiKey: "bad" }, "code").relay[0];
  await assert.rejects(chatCompletion(t, []));
  const left = busyUntilFor(t)! - Date.now();
  assert.ok(left > 9 * 60_000 && left <= 10 * 60_000);
  assert.equal(busyUntilFor(buildTargets({ groqApiKey: "fixed" }, "code").relay[0]), undefined, "a new key is not skipped");
});

test("POST /api/keys/test checks each key without spending tokens", async () => {
  installFetch(({ url }) => {
    if (url.includes("openrouter.ai") && url.endsWith("/key")) return new Response('{"error":{"message":"Missing Authentication header","code":401}}', { status: 401 });
    if (url.includes("nvidia")) return new Response(JSON.stringify({ data: [{ id: "deepseek-ai/deepseek-v4.1-flash" }, { id: "bigcode/starcoder2-15b" }] }));
    if (url.includes("groq")) return new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-120b" }, { id: "whisper-large-v3" }] }));
    return new Response('{"error":{"message":"API key not valid"}}', { status: 400 });
  });
  const res = await server().inject({ method: "POST", url: "/api/keys/test", payload: { keys: { nvidiaApiKey: "n", groqApiKey: "g", geminiApiKey: "bad", openrouterApiKey: "r" } } });
  assert.equal(res.statusCode, 200);
  const r = Object.fromEntries(res.json().results.map((x: any) => [x.provider, x]));
  assert.equal(r.groq.ok, true);
  assert.deepEqual(r.groq.configuredAvailable, ["openai/gpt-oss-120b"]);
  assert.ok(r.groq.missing.includes("llama-3.3-70b-versatile"));
  assert.equal(r.nvidia.ok, true);
  assert.deepEqual(r.nvidia.configuredAvailable, ["deepseek-ai/deepseek-v4.1-flash"]);
  assert.equal(r.google.ok, false);
  assert.equal(r.openrouter.ok, false);
  assert.match(r.openrouter.message, /401/);
  assert.ok(!calls.some((c: any) => c.url.endsWith("/chat/completions")), "no chat calls, so no tokens spent");
});
