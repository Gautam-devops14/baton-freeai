import { mkdtempSync } from "node:fs";
import { resetProviderMemory } from "../src/providers/memory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep test runs out of the real ./data history.
process.env.BATON_DATA_DIR ??= mkdtempSync(join(tmpdir(), "baton-test-"));
// Most tests exercise failover mechanics written against the spec's original order
// (Gemini plans, Groq builds). The default order has its own tests in order.test.ts.
process.env.BATON_PLANNER_ORDER ??= "google,groq,nvidia,openai";
process.env.BATON_RELAY_ORDER ??= "groq,google,nvidia,openai";
// Older tests rate-limit every provider on purpose; don't make them wait for the second chance.
process.env.BATON_MAX_RATE_WAIT_MS ??= "0";
process.env.BATON_SHORT_RATE_WAIT_MS ??= "0";
// The pacer has its own tests; keep it out of tests that make many quick Groq calls.
process.env.BATON_TPM_LIMITS ??= "none=0";

// Fake OpenAI-compatible provider backend for tests.
export type Handler = (req: { url: string; model: string; body: any; signal?: AbortSignal }) => Promise<Response> | Response;

export const calls: Array<{ url: string; model: string }> = [];

export function installFetch(handler: Handler) {
  calls.length = 0;
  resetProviderMemory(); // each test starts with no remembered models or busy providers
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, model: body.model });
    return handler({ url, model: body.model, body, signal: init?.signal ?? undefined });
  }) as typeof fetch;
}

export function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function rateLimited(): Response {
  return new Response(JSON.stringify({ error: { message: "Rate limit reached for model" } }), { status: 429 });
}
