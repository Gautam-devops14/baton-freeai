import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion, ProviderError } from "../src/providers/client.js";
import { calls, completion, installFetch, rateLimited } from "./helpers.js";

const target = { provider: "groq", model: "m", baseUrl: "https://example.test/v1/", apiKey: "k" };

test("posts to <baseUrl>/chat/completions and returns content", async () => {
  let seen = "";
  installFetch(({ url }) => ((seen = url), completion("hello")));
  assert.equal((await chatCompletion(target, [{ role: "user", content: "x" }])).content, "hello");
  assert.equal(seen, "https://example.test/v1/chat/completions");
});

test("classifies 429 as rate_limit with Retry-After", async () => {
  installFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "7" } }));
  await assert.rejects(chatCompletion(target, []), (e: ProviderError) => e.kind === "rate_limit" && e.retryAfterMs === 7000);
});

test("classifies rate-limit text on non-429 status as rate_limit", async () => {
  installFetch(() => new Response('{"error":"RESOURCE_EXHAUSTED quota"}', { status: 400 }));
  await assert.rejects(chatCompletion(target, []), (e: ProviderError) => e.kind === "rate_limit");
  installFetch(() => rateLimited());
  await assert.rejects(chatCompletion(target, []), (e: ProviderError) => e.kind === "rate_limit");
});

test("aborts a hanging socket and reports a timeout", async () => {
  installFetch(({ signal }) => new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  }));
  const t0 = Date.now();
  await assert.rejects(chatCompletion(target, [], { timeoutMs: 50 }), (e: ProviderError) => e.kind === "timeout");
  assert.ok(Date.now() - t0 < 1000);
});

// ---- Model fallback (retired Gemini model IDs) ----

const RETIRED_BODY = JSON.stringify([{
  error: {
    code: 404,
    message: "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash...",
    status: "NOT_FOUND",
  },
}]);
const gemini = () => ({
  provider: "google",
  model: "gemini-3.8-flash",
  fallbackModels: ["gemini-3.5-flash-lite"],
  baseUrl: "https://example.test/v1",
  apiKey: "k",
});

test("HTTP 404 on the first model retries with the next model", async () => {
  installFetch(({ model }) => (model === "gemini-3.8-flash" ? new Response(RETIRED_BODY, { status: 404 }) : completion("from lite")));
  const r = await chatCompletion(gemini(), []);
  assert.equal(r.content, "from lite");
  assert.equal(r.model, "gemini-3.5-flash-lite");
  assert.deepEqual(r.skippedModels, [
    { model: "gemini-3.8-flash", reason: "HTTP 404 model unavailable", next: "gemini-3.5-flash-lite" },
  ]);
});

test("'no longer available' on a 400 also retries with the next model", async () => {
  installFetch(({ model }) =>
    model === "gemini-3.8-flash"
      ? new Response('{"error":{"message":"models/gemini-3.8-flash is no longer available"}}', { status: 400 })
      : completion("ok"));
  assert.equal((await chatCompletion(gemini(), [])).model, "gemini-3.5-flash-lite");
});

test("a plain 400 (not a missing model) does not trigger a model swap", async () => {
  installFetch(() => new Response('{"error":{"message":"Invalid JSON payload"}}', { status: 400 }));
  await assert.rejects(chatCompletion(gemini(), []), (e: ProviderError) => e.kind === "client");
  assert.equal(calls.length, 1);
});

test("when every model is gone, throws model_unavailable with the full swap history", async () => {
  installFetch(() => new Response(RETIRED_BODY, { status: 404 }));
  await assert.rejects(chatCompletion(gemini(), []), (e: ProviderError) =>
    e.kind === "model_unavailable" &&
    e.skippedModels.map((s) => s.model).join() === "gemini-3.8-flash,gemini-3.5-flash-lite" &&
    e.skippedModels[1].next === undefined);
  assert.deepEqual(calls.map((c) => c.model), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
});

test("a 429 on the first model does NOT try the next model (provider failover handles it)", async () => {
  installFetch(() => rateLimited());
  await assert.rejects(chatCompletion(gemini(), []), (e: ProviderError) => e.kind === "rate_limit");
  assert.equal(calls.length, 1);
});

test("a retired model is remembered on the target and skipped on later calls", async () => {
  installFetch(({ model }) => (model === "gemini-3.8-flash" ? new Response(RETIRED_BODY, { status: 404 }) : completion("ok")));
  const t = gemini();
  await chatCompletion(t, []);
  await chatCompletion(t, []);
  assert.deepEqual(calls.map((c) => c.model), ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
});
