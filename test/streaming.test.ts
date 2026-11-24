import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion, ProviderError } from "../src/providers/client.js";
import { buildTargets } from "../src/services/orchestrator.js";
import { calls, installFetch } from "./helpers.js";

/** Build a streamed (SSE) chat reply, delivering chunks with optional delays. */
function sse(chunks: Array<object | string>, opts: { delayMs?: number; stallAfter?: number } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const [i, c] of chunks.entries()) {
        if (opts.stallAfter !== undefined && i === opts.stallAfter) return; // never closes: simulates a stuck stream
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        controller.enqueue(enc.encode(typeof c === "string" ? c : `data: ${JSON.stringify(c)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const delta = (content: string) => ({ choices: [{ delta: { content } }] });
const groq = () => buildTargets({ groqApiKey: "g" }, "code").relay[0];

test("streams the reply: joins deltas, reads usage from the final chunk, requests stream + usage", async () => {
  let sent: any;
  installFetch(({ body }) => {
    sent = body;
    return sse([": keep-alive\n\n", delta("Hello"), delta(", world"), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }, "data: [DONE]\n\n"]);
  });
  const r = await chatCompletion(groq(), [{ role: "user", content: "hi" }]);
  assert.equal(r.content, "Hello, world");
  assert.deepEqual(r.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
});

test("a slow but steady stream is NOT cut off by the first-chunk timeout", async () => {
  installFetch(() => sse(Array.from({ length: 6 }, (_, i) => delta(`part${i} `)), { delayMs: 40 }));
  const r = await chatCompletion(groq(), [], { timeoutMs: 100, idleTimeoutMs: 100 });
  assert.equal(r.content.trim(), "part0 part1 part2 part3 part4 part5"); // ~240ms total, > 100ms first-chunk timeout
});

test("no first chunk in time -> timeout with a clear reason", async () => {
  installFetch(({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))));
  await assert.rejects(chatCompletion(groq(), [], { timeoutMs: 60 }), (e: ProviderError) =>
    e.kind === "timeout" && /no response within/.test(e.reason));
});

test("a stream that stalls midway -> timeout ('reply stalled')", async () => {
  installFetch(() => sse([delta("start "), delta("more "), delta("never")], { stallAfter: 2 }));
  await assert.rejects(chatCompletion(groq(), [], { timeoutMs: 500, idleTimeoutMs: 80 }), (e: ProviderError) =>
    e.kind === "timeout" && /reply stalled/.test(e.reason));
});

test("an error sent mid-stream is classified like an HTTP error", async () => {
  installFetch(() => sse([delta("par"), { error: { code: 429, message: "Rate limit exceeded. Please try again in 2s" } }]));
  await assert.rejects(chatCompletion(groq(), []), (e: ProviderError) => e.kind === "rate_limit" && e.retryAfterMs === 2000);
});

test("providers that reject stream_options are retried once without it", async () => {
  const bodies: any[] = [];
  installFetch(({ body }) => {
    bodies.push(body);
    return body.stream_options
      ? new Response('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', { status: 400 })
      : sse([delta("ok")]);
  });
  const r = await chatCompletion(groq(), []);
  assert.equal(r.content, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(r.usage.estimated, true, "no usage chunk without stream_options: tokens estimated");
});

test("NVIDIA streams without stream_options (tokens estimated)", async () => {
  let sent: any;
  installFetch(({ body }) => ((sent = body), sse([delta("x")])));
  await chatCompletion(buildTargets({ nvidiaApiKey: "n" }, "code").relay[0], []);
  assert.equal(sent.stream, true);
  assert.equal("stream_options" in sent, false);
});

test("streaming progress is reported while the reply arrives (for live UI)", async () => {
  installFetch(() => sse(Array.from({ length: 8 }, () => delta("x".repeat(100))), { delayMs: 90 }));
  const ticks: number[] = [];
  await chatCompletion(groq(), [], { onTrace: (t) => { if (t.phase === "progress") ticks.push(t.chars!); } });
  assert.ok(ticks.length >= 1, "at least one progress tick");
  assert.ok(ticks.every((n, i) => i === 0 || n >= ticks[i - 1]), "monotonic");
});

test("models picked by discovery get a shorter first-chunk timeout", async () => {
  process.env.BATON_DISCOVERED_TIMEOUT_MS = "60";
  try {
    installFetch(({ url, model, signal }) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "new-coder-instruct" }] }));
      if (model === "new-coder-instruct") return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return new Response('{"error":{"message":"model does not exist"}}', { status: 404 });
    });
    const t0 = Date.now();
    await assert.rejects(chatCompletion(groq(), []));
    assert.ok(Date.now() - t0 < 2000, "gave up on the unknown model quickly (not the 30s default)");
    assert.ok(calls.some((c) => c.model === "new-coder-instruct"));
  } finally {
    delete process.env.BATON_DISCOVERED_TIMEOUT_MS;
  }
});
