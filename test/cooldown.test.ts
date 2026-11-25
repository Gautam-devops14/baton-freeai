import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const reply = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const r429 = () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 });
const r503 = () => new Response('{"error":{"message":"high demand","status":"UNAVAILABLE"}}', { status: 503 });
const server = () => buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-cd-"))), store: new InMemoryWorkspaceStore() });
const host = (u: string) => new URL(u).hostname;

async function run(payload: object, env: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return (await server().inject({ method: "POST", url: "/api/orchestrate", payload })).json();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
const ENV = { BATON_BACKOFF_ROUNDS: "2", BATON_BACKOFF_BASE_MS: "100", BATON_BACKOFF_MAX_MS: "200", BATON_OVERLOAD_RETRY_MS: "0", BATON_PLANNER_ORDER: "groq,google,openrouter", BATON_RELAY_ORDER: "groq,google,openrouter" };
const KEYS = { groqApiKey: "g", geminiApiKey: "m", openrouterApiKey: "r" };

test("everyone briefly 429/503 on a file -> cool down, retry the whole order, and finish instead of 'no providers left'", async () => {
  let blipUntil = 0;
  installFetch(({ url, body }) => {
    if (url.endsWith("/models")) return new Response('{"data":[]}');
    if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}');
    if (!blipUntil) blipUntil = Date.now() + 60; // the blip clears within the first cool-down
    if (Date.now() < blipUntil) return host(url).includes("google") ? r503() : r429();
    return reply("<h1>ok</h1>");
  });
  const rand = Math.random;
  Math.random = () => 0.9; // pin the jitter: a 90ms wait outlasts the 60ms blip
  const out = await run({ userPrompt: "page", keys: KEYS }, ENV).finally(() => (Math.random = rand));
  assert.equal(out.status, "success");
  const msgs = out.executionLogs.map((l: any) => l.message);
  assert.ok(msgs.some((m: string) => /^all providers are busy or rate limited; backing off \d+\.\ds \(random, round 1\/2\), then retrying Groq → Google AI Studio → OpenRouter$/.test(m)), msgs.join("\n"));
  assert.equal(out.artifacts["index.html"], "<h1>ok</h1>\n");
});

test("still failing after every cool-down -> the file fails, after both rounds", async () => {
  installFetch(({ url, body }) => (url.endsWith("/models") ? new Response('{"data":[]}') : isPlanner(body) ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}') : r429()));
  const out = await run({ userPrompt: "page", keys: KEYS }, ENV);
  assert.equal(out.status, "failed");
  assert.equal(out.executionLogs.filter((l: any) => /backing off/.test(l.message)).length, 2);
});

test("permanent problems (key rejected, no credit) don't trigger a cool-down: waiting won't fix them", async () => {
  installFetch(({ url, body }) => {
    if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}');
    return host(url).includes("groq") ? new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 })
      : new Response('{"error":{"code":"insufficient_quota","message":"check your plan and billing details"}}', { status: 429 });
  });
  const t0 = Date.now();
  const out = await run({ userPrompt: "page", keys: { groqApiKey: "g", openaiApiKey: "o" } }, { ...ENV, BATON_PLANNER_ORDER: "groq,openai", BATON_RELAY_ORDER: "groq,openai" });
  assert.notEqual(out.status, "success");
  assert.ok(!(out.executionLogs ?? []).some((l: any) => /backing off/.test(l.message)));
  assert.ok(Date.now() - t0 < 1000);
});

test("planning also cools down and retries when every planner is briefly unavailable", async () => {
  let blipUntil = 0;
  installFetch(({ url, body }) => {
    if (url.endsWith("/models")) return new Response('{"data":[]}');
    if (!blipUntil) blipUntil = Date.now() + 60;
    if (Date.now() < blipUntil) return r503();
    return isPlanner(body) ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}') : reply("<p>x</p>");
  });
  const rand = Math.random;
  Math.random = () => 0.9; // full jitter is random: pin it so the wait (90ms) outlasts the 60ms blip
  const out = await run({ userPrompt: "page", keys: KEYS }, ENV).finally(() => (Math.random = rand));
  assert.equal(out.status, "success");
  assert.ok(out.executionLogs.some((l: any) => l.step === 0 && /^all planners are busy or rate limited; backing off \d+\.\ds/.test(l.message)));
  assert.ok(calls.length > 3);
});
