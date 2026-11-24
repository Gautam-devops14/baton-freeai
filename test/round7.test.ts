import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { chatCompletion } from "../src/providers/client.js";
import { busyUntilFor, resetProviderMemory } from "../src/providers/memory.js";
import { FileHistoryStore } from "../src/services/history.js";
import { buildTargets, providerOrder } from "../src/services/orchestrator.js";
import { parsePlan, textOnlyPath } from "../src/services/planner.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const busy = () => new Response('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}', { status: 503 });
const notFound = (m: string) => new Response(JSON.stringify({ error: { message: `The model \`${m}\` does not exist or you do not have access to it.` } }), { status: 404 });
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const host = (url: string) => new URL(url).hostname;
const ALL = { groqApiKey: "g", geminiApiKey: "m", nvidiaApiKey: "n", openaiApiKey: "o" };

/** Run fn with env vars set, restoring them afterwards (after the promise settles, for async fns). */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  let result: T;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return Promise.resolve(result).finally(restore) as T; // also covers Fastify's inject() thenable
  }
  restore();
  return result;
}
const server = () => buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-r7-"))), store: new InMemoryWorkspaceStore() });

// ---------- Provider order ----------

test("default order is NVIDIA -> Groq -> Gemini -> OpenAI for planning and building", () => {
  withEnv({ BATON_PLANNER_ORDER: undefined, BATON_RELAY_ORDER: undefined, BATON_PROVIDER_ORDER: undefined }, () => {
    const t = buildTargets(ALL, "code");
    assert.deepEqual(t.planner.map((x) => x.provider), ["nvidia", "groq", "google", "openai"]);
    assert.deepEqual(t.relay.map((x) => x.provider), ["nvidia", "groq", "google", "openai"]);
    // With an OpenRouter key too, it slots in before paid OpenAI.
    const all5 = buildTargets({ ...ALL, openrouterApiKey: "r" }, "code");
    assert.deepEqual(all5.relay.map((x) => x.provider), ["nvidia", "groq", "google", "openrouter", "openai"]);
  });
});

test("order is configurable; 'gemini' is accepted, unknown names ignored, missing providers appended", () => {
  withEnv({ BATON_PLANNER_ORDER: undefined, BATON_RELAY_ORDER: undefined, BATON_PROVIDER_ORDER: "gemini, groq, bogus" }, () => {
    assert.deepEqual(providerOrder("relay"), ["google", "groq", "nvidia", "openrouter", "openai"]);
  });
});

// ---------- Text-only artifacts ----------

test("binary files are never planned: images become .svg, other binaries are dropped", () => {
  assert.equal(textOnlyPath("src/assets/logo.png"), "src/assets/logo.svg");
  assert.equal(textOnlyPath("favicon.ico"), "favicon.svg");
  assert.equal(textOnlyPath("docs/report.pdf"), null);
  assert.equal(textOnlyPath("app.js"), "app.js");
  const p = parsePlan(JSON.stringify({ tasks: [
    { title: "Logo", targetArtifact: "src/assets/logo.png" },
    { title: "Font", targetArtifact: "fonts/brand.woff2" },
    { title: "Item", targetArtifact: "src/components/Item.jsx" },
  ] }));
  assert.deepEqual(p.tasks.map((t) => t.targetArtifact), ["src/assets/logo.svg", "src/components/Item.jsx"]);
});

// ---------- Memory across runs ----------

test("a model that answered 404 is skipped in later runs; a discovered replacement is reused", async () => {
  installFetch(({ url, model }) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "new-chat-model-70b" }] }));
    return model === "new-chat-model-70b" ? reply("ok") : notFound(model);
  });
  // Run 1: both configured models 404, discovery finds a replacement.
  const r1 = await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], []);
  assert.equal(r1.model, "new-chat-model-70b");
  // Run 2: a fresh target (new request) goes straight to the remembered model.
  calls.length = 0;
  const r2 = await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], []);
  assert.equal(r2.model, "new-chat-model-70b");
  assert.deepEqual(calls.map((c) => c.model), ["new-chat-model-70b"], "no repeated 404s, no repeated /models call");
  // A different API key (another account) does not inherit this memory.
  calls.length = 0;
  await chatCompletion(buildTargets({ groqApiKey: "other" }, "code").relay[0], []);
  assert.equal(calls[0].model, "openai/gpt-oss-120b");
});

test("remembered retirements expire after BATON_DEAD_MODEL_TTL_MS", async () => {
  let clock = 1_000_000;
  installFetch(({ model }) => (model === "openai/gpt-oss-120b" ? notFound(model) : reply("ok")));
  resetProviderMemory(() => clock);
  await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], []);
  clock += 25 * 3600_000; // default TTL is 24h
  calls.length = 0;
  await chatCompletion(buildTargets({ groqApiKey: "g" }, "code").relay[0], []);
  assert.equal(calls[0].model, "openai/gpt-oss-120b", "tried again after expiry");
});

test("a provider busy on every model is skipped for a few minutes, in later steps and later runs", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
  let groqBuilds = false; // run 1: Groq is rate limited while building; run 2: it works
  installFetch(({ url, body }) => {
    if (host(url).includes("generativelanguage")) return busy();
    if (isPlanner(body)) return reply('{"tasks":[{"title":"A","targetArtifact":"a.js"},{"title":"B","targetArtifact":"b.js"}]}');
    return groqBuilds ? reply("ok") : new Response("{}", { status: 429 });
  });
  const keys = { geminiApiKey: "m", groqApiKey: "g" };
  const order = { BATON_PLANNER_ORDER: "google,groq", BATON_RELAY_ORDER: "groq,google" };
  const app = server();
  const out1 = await withEnv(order, () => app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build it", keys } }));
  const logs1 = out1.json().executionLogs;
  assert.ok(busyUntilFor(buildTargets(keys, "code").planner.find((t) => t.provider === "google")!), "Gemini marked busy");
  // Within the same run, the build steps skip Gemini (logged once) instead of calling it again.
  assert.equal(logs1.filter((l: any) => l.message.startsWith("skipped: every google model was busy")).length, 1);

  calls.length = 0;
  groqBuilds = true;
  const app2 = server();
  const out2 = await withEnv(order, () =>
    app2.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build it again", keys } }));
  const logs2 = out2.json().executionLogs;
  assert.match(logs2[0].message, /^skipped: every google model was busy \(503\) in the last few minutes; will try it again after/);
  assert.equal(out2.json().status, "success");
  assert.ok(!calls.some((c) => host(c.url).includes("generativelanguage")), "Gemini not called at all in the next run");
});

// ---------- Follow-ups ----------

const FIRST_PLAN = '{"decisions":{"framework":"vanilla"},"tasks":[{"title":"Page","targetArtifact":"index.html"},{"title":"Logic","targetArtifact":"app.js"}]}';
const FOLLOW_PLAN = '{"tasks":[{"title":"Add delete button","targetArtifact":"app.js"},{"title":"Logo","targetArtifact":"logo.png"}]}';

test("follow-up: edits the existing project with full context, keeps untouched files, records the chain", async () => {
  const prompts: Record<string, string[]> = { plan: [], task: [] };
  let phase = 1;
  installFetch(({ body }) => {
    const user = body.messages[1].content as string;
    if (isPlanner(body)) {
      prompts.plan.push(user);
      return reply(phase === 1 ? FIRST_PLAN : FOLLOW_PLAN);
    }
    prompts.task.push(user);
    const target = /Produce the full contents of `([^`]+)`/.exec(user)![1];
    return reply(`/* ${target} v${phase} */`);
  });
  const app = server();
  const keys = { nvidiaApiKey: "n" };
  const first = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Student marks app", keys } })).json();
  assert.equal(first.status, "success");
  assert.deepEqual(first.changes, { modified: [], added: ["index.html", "app.js"] });

  phase = 2;
  prompts.plan.length = prompts.task.length = 0;
  const res = await app.inject({
    method: "POST", url: "/api/orchestrate",
    payload: { userPrompt: "add a logo and a delete button", keys, continueFrom: first.historyId },
  });
  const second = res.json();
  assert.equal(second.status, "success");
  assert.equal(second.parentId, first.historyId);

  // Planner saw the earlier request and the existing files.
  assert.match(prompts.plan[0], /FOLLOW-UP to an existing project/);
  assert.match(prompts.plan[0], /1\. Student marks app/);
  assert.match(prompts.plan[0], /=== app\.js ===\n\/\* app\.js v1 \*\//);
  // The app.js step got its current contents to rewrite, plus the other files with who wrote them.
  const appStep = prompts.task.find((p) => p.includes("Produce the full contents of `app.js`"))!;
  assert.match(appStep, /## Earlier requests \(oldest first\)\n1\. Student marks app\n\n## Current request\nadd a logo and a delete button/);
  assert.match(appStep, /## Current contents of `app\.js` \(rewrite the WHOLE file/);
  assert.match(appStep, /=== index\.html === \(written by nvidia\/qwen\/qwen3-coder-480b-a35b-instruct\)/);

  // Result: full merged project; logo.png planned as SVG; changes reported.
  assert.deepEqual(Object.keys(second.artifacts).sort(), ["app.js", "index.html", "logo.svg"]);
  assert.equal(second.artifacts["index.html"], "/* index.html v1 */\n", "untouched file carried over");
  assert.equal(second.artifacts["app.js"], "/* app.js v2 */\n");
  assert.deepEqual(second.changes, { modified: ["app.js"], added: ["logo.svg"] });

  // A second follow-up sees both earlier requests.
  phase = 3;
  prompts.plan.length = 0;
  await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "make it blue", keys, continueFrom: second.historyId } });
  assert.match(prompts.plan[0], /1\. Student marks app\n2\. add a logo and a delete button/);

  const rec = (await app.inject({ method: "GET", url: `/api/history/${second.historyId}` })).json();
  assert.deepEqual(rec.conversation, ["Student marks app"]);
  assert.equal(rec.artifactOrigins["index.html"].runId, first.historyId);
  assert.equal(rec.artifactOrigins["app.js"].runId, second.historyId);
});

test("follow-up to a missing or file-less run -> 404 with a clear message", async () => {
  installFetch(() => reply("x"));
  const app = server();
  const missing = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "add a button", keys: { nvidiaApiKey: "n" }, continueFrom: "ws_123_abc" } });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().message, /not found in history/);
  const gated = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "hello" } })).json();
  const noFiles = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "add a button", keys: { nvidiaApiKey: "n" }, continueFrom: gated.historyId } });
  assert.equal(noFiles.statusCode, 404);
  assert.match(noFiles.json().message, /no files to build on/);
});

// ---------- Context sharing, made visible ----------

test("each step records what it was given: files with who wrote them, decisions, prompt size and exact prompt", async () => {
  let n = 0;
  installFetch(({ url, body }) => {
    if (isPlanner(body)) return reply(FIRST_PLAN);
    n++;
    if (host(url).includes("nvidia") && n === 2) return new Response("{}", { status: 429 }); // app.js fails over to Groq
    return reply(`content ${n}`);
  });
  const out = (await withEnv({ BATON_RELAY_ORDER: "nvidia,groq" }, () => server().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Student marks app", keys: { nvidiaApiKey: "n", groqApiKey: "g" } },
  }))).json();
  const [plan, step1, step2] = out.contexts;
  assert.equal(plan.kind, "plan");
  assert.equal(step1.target, "index.html");
  assert.deepEqual(step1.files, []);
  assert.equal(step2.target, "app.js");
  assert.deepEqual(step2.decisions, { framework: "vanilla" });
  assert.deepEqual(step2.files.map((f: any) => [f.path, f.source, f.by]), [["index.html", "this-run", "nvidia/qwen/qwen3-coder-480b-a35b-instruct"]]);
  assert.ok(step2.promptTokens > 0);
  assert.match(step2.messages[1].content, /=== index\.html === \(written by nvidia\//);
  // The same context went to Groq after NVIDIA failed: the log shows both attempts for step 2.
  assert.deepEqual(out.executionLogs.filter((l: any) => l.step === 2).map((l: any) => `${l.event}:${l.provider}`), ["failover:nvidia", "execute:groq"]);
  assert.equal(out.artifactOrigins["app.js"].provider, "groq");
});
