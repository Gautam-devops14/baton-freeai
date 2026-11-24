import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { chatCompletion } from "../src/providers/client.js";
import { busyUntilFor } from "../src/providers/memory.js";
import { FileHistoryStore } from "../src/services/history.js";
import { buildTargets } from "../src/services/orchestrator.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const target = (type: "code" | "document" = "code") => buildTargets({ openrouterApiKey: "sk-or-x" }, type).relay[0];

test("OpenRouter target: endpoint, free models, no JSON mode, attribution header", async () => {
  const t = target();
  assert.equal(t.provider, "openrouter");
  assert.equal(t.baseUrl, "https://openrouter.ai/api/v1");
  // OpenRouter's own free router: always routes to a model that is free right now.
  assert.deepEqual([t.model, ...(t.fallbackModels ?? [])], ["openrouter/free"]);
  let headers: any, body: any;
  globalThis.fetch = (async (url: any, init: any) => { headers = init.headers; body = JSON.parse(init.body); return reply("ok"); }) as any;
  await chatCompletion(t, [], { jsonMode: true });
  assert.equal(headers["X-Title"], "Baton");
  assert.equal(headers.Authorization, "Bearer sk-or-x");
  assert.equal("response_format" in body, false);
});

test("OpenRouter discovery only ever picks ':free' models", async () => {
  installFetch(({ url, model }) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [
      { id: "anthropic/some-paid-coder" }, { id: "openai/gpt-paid-coder" }, { id: "qwen/qwen9-coder:free" }, { id: "meta/llama-4:free" },
    ] }));
    return model === "qwen/qwen9-coder:free" ? reply("ok") : new Response('{"error":{"message":"No endpoints found for this model"}}', { status: 404 });
  });
  const r = await chatCompletion(target(), []);
  assert.equal(r.model, "qwen/qwen9-coder:free");
  assert.ok(!calls.some((c) => c.model && !/:free$|^openrouter\/free$/.test(c.model)), "never calls a paid model");
});

test("OpenRouter's free daily cap skips it for an hour (not just this run)", async () => {
  installFetch(() => new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}', { status: 429 }));
  const t = target();
  await assert.rejects(chatCompletion(t, []), (e: any) => e.kind === "rate_limit" && /daily limit/.test(e.message));
  const until = busyUntilFor(t)!;
  assert.ok(until - Date.now() > 50 * 60_000, "skipped for about an hour");
});

test("OpenRouter 402 'Insufficient credits' is a billing error", async () => {
  installFetch(() => new Response('{"error":{"message":"Insufficient credits","code":402}}', { status: 402 }));
  await assert.rejects(chatCompletion(target(), []), (e: any) => e.kind === "billing");
});

test("an OpenRouter key alone is enough to run a project", async () => {
  installFetch(({ url, body }) => {
    assert.ok(url.startsWith("https://openrouter.ai/"), url);
    return body.messages[0].content.includes("Task Architect")
      ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}')
      : reply("<h1>hi</h1>");
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-or-"))), store: new InMemoryWorkspaceStore() });
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "hello page", keys: { openrouterApiKey: "sk-or-x" } } })).json();
  assert.equal(out.status, "success");
  assert.deepEqual(out.providers ?? (await app.inject({ method: "GET", url: `/api/history/${out.historyId}` })).json().providers, ["openrouter"]);
});
