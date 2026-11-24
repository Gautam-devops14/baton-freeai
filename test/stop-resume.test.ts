import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { stripGreeting } from "../src/services/gate.js";
import { FileHistoryStore } from "../src/services/history.js";
import { orchestrate } from "../src/services/orchestrator.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const reply = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
const PLAN = '{"tasks":[{"title":"Page","targetArtifact":"index.html"},{"title":"Styles","targetArtifact":"style.css"},{"title":"Logic","targetArtifact":"app.js"}]}';
const fileFor = (body: any) => {
  const user = String(body.messages?.[1]?.content ?? "");
  const target = /contents of `([^`]+)`/.exec(user)?.[1] ?? "";
  return target === "index.html" ? "```html\n<!doctype html><html><body>hi</body></html>\n```" : target === "style.css" ? "```css\nbody { color: red; }\n```" : "```js\nconsole.log(1);\n```";
};
const targetOf = (body: any) => /contents of `([^`]+)`/.exec(String(body.messages?.[1]?.content ?? ""))?.[1];
/** A request that never answers, but fails like fetch does when its signal is aborted. */
const hang = (signal?: AbortSignal) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("greeting prefix is stripped before planning; the chat keeps what the user typed", async () => {
  assert.equal(stripGreeting("Hi Baton, can you build a todo app"), "Can you build a todo app");
  assert.equal(stripGreeting("Hey, write a poem"), "Write a poem");
  assert.equal(stripGreeting("Good morning team! Create an API"), "Create an API");
  assert.equal(stripGreeting("hello world app in python"), "hello world app in python");
  assert.equal(stripGreeting("Hiking tracker"), "Hiking tracker");
  assert.equal(stripGreeting("hi"), "hi");
  let plannerPrompt = "";
  installFetch(({ body }) => {
    if (isPlanner(body)) {
      plannerPrompt = body.messages[1].content;
      return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}');
    }
    return reply(fileFor(body));
  });
  const history = new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-g-")));
  const res: any = await orchestrate({ userPrompt: "Hey Baton, build a todo page", keys: { groqApiKey: "g" } }, new InMemoryWorkspaceStore(), history);
  assert.equal(res.status, "success");
  assert.ok(plannerPrompt.includes("Build a todo page"));
  assert.ok(!/hey baton/i.test(plannerPrompt), "the greeting never reaches the planner");
  const rec = await history.get(res.historyId);
  assert.equal(rec?.userPrompt, "Hey Baton, build a todo page");
  assert.equal(rec?.goal, "Build a todo page");
});

test("Stop: upstream calls are aborted at once and finished files are kept", async () => {
  const ctl = new AbortController();
  let upstreamAborted = false;
  let cssRequests = 0;
  installFetch(({ body, signal }) => {
    if (isPlanner(body)) return reply(PLAN);
    if (targetOf(body) === "style.css") {
      cssRequests++;
      setTimeout(() => ctl.abort(), 30); // user presses Stop while step 2 is waiting on the provider
      signal?.addEventListener("abort", () => (upstreamAborted = true));
      return hang(signal);
    }
    return reply(fileFor(body));
  });
  const store = new InMemoryWorkspaceStore();
  const history = new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-s-")));
  const t0 = Date.now();
  const res: any = await orchestrate({ userPrompt: "Build a page", keys: { groqApiKey: "g", geminiApiKey: "m" } }, store, history, { signal: ctl.signal });
  assert.ok(Date.now() - t0 < 2000, "stopped promptly");
  assert.equal(res.status, "stopped");
  assert.ok(upstreamAborted, "the provider request itself was cancelled");
  assert.deepEqual(Object.keys(res.artifacts), ["index.html"]);
  assert.deepEqual(res.summary, { totalTasks: 3, completedTasks: 1, artifactsGenerated: ["index.html"] });
  assert.equal(cssRequests, 1, "no failover to another model or provider after Stop");
  const rec = await history.get(res.historyId);
  assert.equal(rec?.status, "stopped");
  assert.deepEqual(rec?.plan?.tasks.map((t) => t.status), ["completed", "pending", "pending"]);
  assert.ok(await store.get(res.workspaceId), "partial project can be downloaded");
});

test("POST /api/cancel stops a running request by its clientRunId", async () => {
  const history = new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-c-")));
  const app = buildServer({ history, store: new InMemoryWorkspaceStore() });
  const id = "abcdef0123456789";
  installFetch(({ body, signal }) => {
    if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}');
    setTimeout(() => void app.inject({ method: "POST", url: `/api/cancel/${id}` }), 30);
    return hang(signal);
  });
  const res = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build a page", keys: { groqApiKey: "g" }, clientRunId: id } })).json();
  assert.equal(res.status, "stopped");
  assert.deepEqual((await app.inject({ method: "POST", url: `/api/cancel/${id}` })).json(), { cancelled: false });
});

test("12s first-chunk timeout and a hard per-step deadline across every fallback", async () => {
  await withEnv({ BATON_STEP_DEADLINE_MS: "300", BATON_PROVIDER_TIMEOUT_MS: "12000" }, async () => {
    installFetch(({ body, signal }) => {
      if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}');
      return hang(signal); // every provider and model hangs
    });
    const t0 = Date.now();
    const res: any = await orchestrate({ userPrompt: "Build a page", keys: { groqApiKey: "g", geminiApiKey: "m", nvidiaApiKey: "n" } }, new InMemoryWorkspaceStore());
    const took = Date.now() - t0;
    assert.equal(res.status, "failed");
    assert.ok(took < 4000, `gave up at the step deadline, not after 12s per model (took ${took}ms)`);
    assert.ok(res.executionLogs.some((l: any) => /step time limit/.test(l.message)));
  });
});

test("Resume from step N: reuses the plan (no planning call), builds only what's missing", async () => {
  const history = new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-r-")));
  const store = new InMemoryWorkspaceStore();
  let failCss = true;
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply(PLAN);
    if (targetOf(body) === "style.css" && failCss) return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 });
    return reply(fileFor(body));
  });
  const first: any = await orchestrate({ userPrompt: "Hi, build a page", keys: { groqApiKey: "g" } }, store, history);
  assert.equal(first.status, "partial");
  assert.deepEqual(first.summary.artifactsGenerated, ["index.html", "app.js"]);

  failCss = false;
  calls.length = 0;
  const plannerCalls = () => calls.length;
  const second: any = await orchestrate({ userPrompt: "Resume from step 2 (style.css)", keys: { groqApiKey: "g" }, resumeFrom: first.historyId }, store, history);
  assert.equal(second.status, "success");
  assert.equal(plannerCalls(), 1, "one call: the missing file only (no planner)");
  assert.deepEqual(Object.keys(second.artifacts).sort(), ["app.js", "index.html", "style.css"]);
  assert.deepEqual(second.changes, { modified: [], added: ["style.css"] });
  assert.equal(second.chatId, first.chatId);
  assert.equal(second.summary.completedTasks, 3);
  const rec = await history.get(second.historyId);
  assert.equal(rec?.goal, "Build a page", "models keep the original request, not 'Resume from step 2'");

  const again: any = await orchestrate({ userPrompt: "Resume", keys: { groqApiKey: "g" }, resumeFrom: second.historyId }, store, history).catch((e) => e);
  assert.match(String(again.message), /nothing to resume/);
});
