import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion } from "../src/providers/client.js";
import { pacerWait, recordTokens, tpmLimit } from "../src/providers/pacer.js";
import { installFetch } from "./helpers.js";

const groq = (model = "m") => ({ provider: "groq", model, baseUrl: "https://api.groq.com/openai/v1", apiKey: "g" });
const reply = (total: number) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: total - 10, completion_tokens: 10, total_tokens: total } }));

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); });
}

test("limits come from BATON_TPM_LIMITS, per provider with per-model overrides (default groq=8000)", async () => {
  await withEnv({ BATON_TPM_LIMITS: "groq=8000,groq:llama-3.1-8b-instant=6000" }, async () => {
    assert.equal(tpmLimit("groq", "openai/gpt-oss-120b"), 8000);
    assert.equal(tpmLimit("groq", "llama-3.1-8b-instant"), 6000);
    assert.equal(tpmLimit("google", "gemini-3.8-flash"), undefined);
  });
  const saved = process.env.BATON_TPM_LIMITS;
  delete process.env.BATON_TPM_LIMITS;
  try { assert.equal(tpmLimit("groq", "x"), 8000); } finally { process.env.BATON_TPM_LIMITS = saved; }
});

test("waits just long enough for earlier usage to age out of the window, and says so", async () => {
  await withEnv({ BATON_TPM_LIMITS: "groq=1000", BATON_PACER_WINDOW_MS: "300", BATON_TPM_OUTPUT_RESERVE: "100" }, async () => {
    installFetch(() => reply(900));
    await chatCompletion(groq(), [{ role: "user", content: "hi" }]); // 900 tokens used in this window
    const waits: string[] = [];
    const t0 = Date.now();
    await chatCompletion(groq(), [{ role: "user", content: "hi" }], { onWait: (_ms, msg) => waits.push(msg) });
    const waited = Date.now() - t0;
    assert.ok(waited >= 250, `waited ${waited}ms for the window to clear`);
    assert.equal(waits.length, 1);
    assert.match(waits[0], /^pacing: waiting 0\.\ds to stay under groq's 1,000 tokens\/min for m$/);
  });
});

test("no wait when there's room, when the cap is per model, or when one call alone exceeds the cap", async () => {
  await withEnv({ BATON_TPM_LIMITS: "groq=1000", BATON_PACER_WINDOW_MS: "60000" }, async () => {
    installFetch(() => reply(10));
    recordTokens(groq("a"), "a", 500);
    assert.equal(pacerWait(groq("a"), "a", 400), 0, "room left");
    assert.ok(pacerWait(groq("a"), "a", 600) > 0, "would exceed");
    assert.equal(pacerWait(groq("b"), "b", 600), 0, "another model has its own budget");
    assert.equal(pacerWait(groq("a"), "a", 5000), 0, "waiting can't make a 5k call fit a 1k cap");
  });
});

test("waits longer than BATON_PACER_MAX_WAIT_MS are skipped (failover handles any 429)", async () => {
  await withEnv({ BATON_TPM_LIMITS: "groq=1000", BATON_PACER_WINDOW_MS: "60000", BATON_PACER_MAX_WAIT_MS: "100", BATON_TPM_OUTPUT_RESERVE: "100" }, async () => {
    installFetch(() => reply(950));
    await chatCompletion(groq(), []);
    const waits: string[] = [];
    const t0 = Date.now();
    await chatCompletion(groq(), [], { onWait: (_ms, m) => waits.push(m) });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(waits.length, 0);
  });
});
