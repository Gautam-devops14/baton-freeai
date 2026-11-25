import { test } from "node:test";
import assert from "node:assert/strict";
import { circuitAllows, circuitState, recordFailure, recordSuccess, resetCircuits } from "../src/providers/circuitBreaker.js";
import { fullJitterDelay, countdownSleep } from "../src/services/retry.js";
import { orchestrate } from "../src/services/orchestrator.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";
import type { ProviderTarget } from "../src/types.js";

const T = { provider: "groq", baseUrl: "https://x", apiKey: "k", model: "m" } as ProviderTarget;
const reply = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("circuit breaker: CLOSED -> OPEN after 3 failures (45s) -> one HALF_OPEN probe -> CLOSED or OPEN 60s", () =>
  withEnv({ BATON_CIRCUIT_FAILS: "3" }, async () => {
    let clock = 1_000_000;
    resetCircuits(() => clock);
    recordFailure(T);
    recordFailure(T);
    assert.equal(circuitState(T), "CLOSED");
    recordFailure(T);
    assert.equal(circuitState(T), "OPEN");
    const blocked = circuitAllows(T);
    assert.ok(!blocked.ok && blocked.retryInMs === 45_000);

    clock += 45_000;
    assert.deepEqual(circuitAllows(T), { ok: true, probe: true }, "exactly one trial request");
    assert.equal(circuitAllows(T).ok, false, "a second request waits for the probe");
    recordFailure(T); // probe failed
    const reopened = circuitAllows(T);
    assert.ok(!reopened.ok && reopened.retryInMs === 60_000, "re-opens for 60s");

    clock += 60_000;
    assert.equal(circuitAllows(T).ok, true);
    recordSuccess(T);
    assert.equal(circuitState(T), "CLOSED");
    assert.deepEqual(circuitAllows(T), { ok: true, probe: false });
    resetCircuits();
  }));

test("open circuit: after 3 failures in a row the provider is skipped instantly (0 ms), in later runs too", () =>
  withEnv({ BATON_CIRCUIT_FAILS: "3", BATON_RELAY_ORDER: "groq,google", BATON_PLANNER_ORDER: "google" }, async () => {
    let groqCalls = 0;
    installFetch(({ url, body }) => {
      if (isPlanner(body)) return reply('{"tasks":[{"title":"A","targetArtifact":"a.js"}]}');
      if (url.includes("groq")) {
        groqCalls++;
        return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 });
      }
      return reply("const x = 1;");
    });
    const run = () => orchestrate({ userPrompt: "Build it", keys: { groqApiKey: "g", geminiApiKey: "m" } }, new InMemoryWorkspaceStore()) as Promise<any>;
    for (let i = 0; i < 3; i++) assert.equal((await run()).status, "success");
    const before = groqCalls;
    const t0 = Date.now();
    const res = await run();
    assert.equal(res.status, "success");
    assert.equal(groqCalls, before, "no request sent to the tripped provider");
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(res.executionLogs.some((l: any) => /^circuit open \(3 failures in a row\); skipped instantly, next trial in 4\ds; passing baton to/.test(l.message)));
  }));

test("full jitter: delay = floor(random * min(60s, 15s * 2^attempt))", () => {
  assert.equal(fullJitterDelay(0, 15_000, 60_000, () => 0.5), 7_500);
  assert.equal(fullJitterDelay(1, 15_000, 60_000, () => 0.5), 15_000);
  assert.equal(fullJitterDelay(2, 15_000, 60_000, () => 0.999), 59_940);
  assert.equal(fullJitterDelay(5, 15_000, 60_000, () => 0.999), 59_940, "capped at 60s");
  assert.equal(fullJitterDelay(3, 15_000, 60_000, () => 0), 0);
  const many = Array.from({ length: 200 }, () => fullJitterDelay(1));
  assert.ok(many.every((d) => d >= 0 && d < 30_000));
  assert.ok(new Set(many).size > 100, "randomised, so users don't retry in lock-step");
});

test("countdown ticks every second for the live status line, and Stop cancels it", async () => {
  const ticks: number[] = [];
  await countdownSleep(2100, undefined, (s) => ticks.push(s));
  assert.equal(ticks[0], 3);
  assert.equal(ticks.at(-1), 0);
  assert.ok(ticks.every((t, i) => i === 0 || t <= ticks[i - 1]), "counts down");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(countdownSleep(5000, ctl.signal, () => {}), /stopped/);
});

test("backoff: all providers busy -> random wait, then the retry succeeds", () =>
  withEnv({ BATON_BACKOFF_ROUNDS: "1", BATON_BACKOFF_BASE_MS: "1500", BATON_BACKOFF_MAX_MS: "1500", BATON_RELAY_ORDER: "groq", BATON_PLANNER_ORDER: "groq" }, async () => {
    let busyUntil = 0;
    installFetch(({ body }) => {
      if (isPlanner(body)) {
        busyUntil = Date.now() + 800; // every Groq model is busy for the first 0.8s of the build
        return reply('{"tasks":[{"title":"A","targetArtifact":"a.js"}]}');
      }
      return Date.now() < busyUntil ? new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }) : reply("const a = 1;");
    });
    const orig = Math.random;
    Math.random = () => 0.99; // ~1.5s
    try {
      const res: any = await orchestrate({ userPrompt: "Build", keys: { groqApiKey: "g" } }, new InMemoryWorkspaceStore());
      assert.equal(res.status, "success");
      assert.ok(res.executionLogs.some((l: any) => /backing off 1\.\ds \(random, round 1\/1\)/.test(l.message)));
    } finally {
      Math.random = orig;
    }
  }));

test("strict memory boundary: chatter that fails the file check twice is never saved", () =>
  withEnv({ BATON_RELAY_ORDER: "groq,google", BATON_PLANNER_ORDER: "google" }, async () => {
    installFetch(({ url, body }) => {
      if (isPlanner(body)) return reply('{"tasks":[{"title":"Config","targetArtifact":"config.json"}]}');
      if (url.includes("groq")) return reply("Sure! Here is your config, I think it should work: {name: test");
      return reply('```json\n{"name": "test"}\n```');
    });
    const res: any = await orchestrate({ userPrompt: "Make a config", keys: { groqApiKey: "g", geminiApiKey: "m" } }, new InMemoryWorkspaceStore());
    assert.equal(res.status, "success");
    assert.equal(res.artifacts["config.json"], '{"name": "test"}\n', "only the verified file from the next provider");
    assert.ok(res.executionLogs.some((l: any) => /rejected, not saved: invalid JSON/.test(l.message)));
    assert.ok(!JSON.stringify(res.artifacts).includes("Sure!"));
  }));
