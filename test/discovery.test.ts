import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/index.js";
import { chatCompletion } from "../src/providers/client.js";
import { rankModels } from "../src/providers/discovery.js";
import { buildTargets } from "../src/services/orchestrator.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const gone = (status = 410, detail = "Function 'abc' is no longer available") =>
  new Response(JSON.stringify({ status, title: "Gone", detail }), { status });
const models = (...ids: string[]) => new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
const isModels = (url: string) => url.endsWith("/models");
const isGemini = (url: string) => url.includes("generativelanguage");
const isGroq = (url: string) => url.includes("api.groq.com");
const isNvidia = (url: string) => url.includes("integrate.api.nvidia.com");
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");

test("rankModels: drops non-chat models, follows hints, newest version first", () => {
  const ids = ["models/gemini-3.5-flash", "models/gemini-3.8-flash", "models/gemini-3.8-flash-lite", "models/text-embedding-004",
    "models/gemini-3.8-flash-image", "models/gemini-3.5-pro"];
  const hints = [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/, /^gemini-.*pro/];
  assert.deepEqual(rankModels(ids, hints, new Set()), ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.8-flash-lite"]);
  assert.deepEqual(rankModels(ids, hints, new Set(["gemini-3.8-flash"])), ["gemini-3.5-flash", "gemini-3.8-flash-lite", "gemini-3.5-pro"]);
  assert.deepEqual(rankModels(["whisper-large-v3", "llama-guard-4", "nv-embed-v2", "some-chat-model"], ["coder"], new Set()), ["some-chat-model"]);
});

test("Groq 400 'decommissioned' is recognised as a retired model and the next model is used", async () => {
  installFetch(({ model }) =>
    model === "openai/gpt-oss-120b"
      ? new Response(JSON.stringify({ error: { message: "The model `openai/gpt-oss-120b` has been decommissioned and is no longer supported.", type: "invalid_request_error", code: "model_decommissioned" } }), { status: 400 })
      : reply("ok"));
  const r = await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], []);
  assert.equal(r.model, "llama-3.3-70b-versatile");
  assert.match(r.skippedModels[0].reason, /^HTTP 400 model unavailable: The model `openai\/gpt-oss-120b` has been decommissioned/);
});

test("all configured models retired: discovers a replacement from the live model list, once per run", async () => {
  installFetch(({ url, model }) => {
    if (isModels(url)) return models("nvidia/nv-embed-v1", "meta/llama-guard-4", "qwen/qwen9-coder-instruct", "meta/llama-3.1-8b-instruct");
    return model === "qwen/qwen9-coder-instruct" ? reply("discovered!") : gone();
  });
  const t = buildTargets({ nvidiaApiKey: "n" }, "code").relay[0];
  const r = await chatCompletion(t, []);
  assert.equal(r.content, "discovered!");
  assert.equal(r.model, "qwen/qwen9-coder-instruct");
  assert.equal(r.skippedModels.at(-1)!.next, "qwen/qwen9-coder-instruct");
  assert.equal(r.skippedModels.at(-1)!.nextDiscovered, true);

  // Second call in the same run: goes straight to the discovered model, no new /models call.
  calls.length = 0;
  assert.equal((await chatCompletion(t, [])).model, "qwen/qwen9-coder-instruct");
  assert.deepEqual(calls.map((c) => c.model), ["qwen/qwen9-coder-instruct"]);
});

test("discovery finds nothing usable: the provider fails over normally", async () => {
  installFetch(({ url }) => (isModels(url) ? models("nvidia/nv-embed-v1", "openai/whisper-large-v3") : gone()));
  await assert.rejects(chatCompletion(buildTargets({ nvidiaApiKey: "n" }, "code").relay[0], []), (e: any) => e.kind === "model_unavailable");
});

test("the user's run: Groq decommissioned, Gemini busy, NVIDIA 410 -> recovers via Groq fallback and discovery", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
  installFetch(({ url, model, body }) => {
    if (isGemini(url)) {
      if (isPlanner(body) && model === "gemini-3.5-flash-lite") return reply('{"tasks":[{"title":"Todo app","targetArtifact":"index.html"}]}');
      return new Response('[{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}]', { status: 503 });
    }
    if (isGroq(url)) {
      return new Response(JSON.stringify({ error: { message: `The model \`${model}\` has been decommissioned and is no longer supported.` } }), { status: 400 });
    }
    if (isNvidia(url)) {
      if (isModels(url)) return models("qwen/qwen9-coder-instruct", "nvidia/nv-embed-v1");
      return model === "qwen/qwen9-coder-instruct" ? reply("```html\n<!doctype html><title>Todo</title>\n```") : gone();
    }
    return new Response('{"error":{"code":"insufficient_quota","message":"check your plan and billing details"}}', { status: 429 });
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate",
    payload: { userPrompt: "Create a todo list using HTML and JS", keys: { groqApiKey: "g", geminiApiKey: "m", nvidiaApiKey: "n", openaiApiKey: "o" } },
  })).json();

  assert.equal(out.status, "success");
  assert.equal(out.artifacts["index.html"], "<!doctype html><title>Todo</title>\n");
  const msgs = out.executionLogs.map((l: any) => `${l.provider}/${l.model}: ${l.message}`);
  assert.ok(msgs.some((m: string) => m.startsWith("google/gemini-3.5-flash-lite: Project decomposed into 1 milestone")), msgs.join("\n"));
  assert.ok(msgs.some((m: string) => /^groq\/openai\/gpt-oss-120b: HTTP 400 model unavailable: The model .* decommissioned/.test(m)));
  assert.ok(msgs.some((m: string) => m.includes("(picked from nvidia's current model list)")));
  assert.ok(msgs.some((m: string) => m.startsWith("nvidia/qwen/qwen9-coder-instruct: Generated index.html successfully")));
  assert.ok(!calls.some((c) => c.url.includes("openai.com")), "paid OpenAI never reached");
});

test("Groq defaults: gpt-oss-120b, then the llama models, for every task type", () => {
  for (const type of ["code", "document", "analysis"] as const) {
    const t = buildTargets({ groqApiKey: "g" }, type).relay[0];
    assert.equal(t.model, "openai/gpt-oss-120b");
    assert.deepEqual(t.fallbackModels, ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
  }
});
