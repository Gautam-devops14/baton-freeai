import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");

test("a short Groq rate limit is waited out immediately instead of detouring through slower providers", async () => {
  process.env.BATON_SHORT_RATE_WAIT_MS = "8000";
  let groqBuild = 0;
  installFetch(({ url, body }) => {
    if (url.includes("groq")) {
      if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}');
      return ++groqBuild === 1
        ? new Response('{"error":{"message":"Rate limit reached for model openai/gpt-oss-120b. Please try again in 0.2s."}}', { status: 429 })
        : reply("<h1>ok</h1>");
    }
    return reply("from a slower provider");
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-r10-"))), store: new InMemoryWorkspaceStore() });
  const saved = [process.env.BATON_PLANNER_ORDER, process.env.BATON_RELAY_ORDER];
  process.env.BATON_PLANNER_ORDER = process.env.BATON_RELAY_ORDER = "groq,google,openrouter";
  try {
    const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: { groqApiKey: "g", geminiApiKey: "m", openrouterApiKey: "r" } } })).json();
    assert.equal(out.status, "success");
    assert.equal(out.artifacts["index.html"], "<h1>ok</h1>\n", "built by Groq after the short wait");
    assert.ok(out.executionLogs.some((l: any) => /waiting 0\.\ds for groq's rate limit to reset, then retrying$/.test(l.message)));
    assert.ok(!calls.some((c) => c.url.includes("generativelanguage") || c.url.includes("openrouter")), "no detour");
  } finally {
    [process.env.BATON_PLANNER_ORDER, process.env.BATON_RELAY_ORDER] = saved;
    process.env.BATON_SHORT_RATE_WAIT_MS = "0";
  }
});

test("OpenRouter's 'unavailable for free, use the paid slug' 404 never makes Baton call the paid model", async () => {
  installFetch(({ url, model }) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "meta-llama/llama-3.3-70b-instruct" }, { id: "qwen/qwen3-coder" }] }));
    return new Response(JSON.stringify({ error: { message: `This model is unavailable for free. The paid version is available now - use this slug instead: ${String(model).replace(":free", "")}`, code: 404 } }), { status: 404 });
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-r10b-"))), store: new InMemoryWorkspaceStore() });
  await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: { openrouterApiKey: "r" } } });
  const models = calls.filter((c) => c.url.endsWith("/chat/completions")).map((c) => c.model);
  assert.deepEqual([...new Set(models)], ["openrouter/free"], "only the free router was tried; paid slugs never");
});
