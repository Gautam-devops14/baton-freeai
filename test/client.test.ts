import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion, ProviderError } from "../src/providers/client.js";
import { completion, installFetch, rateLimited } from "./helpers.js";

const target = { provider: "groq", model: "m", baseUrl: "https://example.test/v1/", apiKey: "k" };

test("posts to <baseUrl>/chat/completions and returns content", async () => {
  let seen = "";
  installFetch(({ url }) => ((seen = url), completion("hello")));
  assert.equal(await chatCompletion(target, [{ role: "user", content: "x" }]), "hello");
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
