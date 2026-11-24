import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/index.js";
import { calls, completion, installFetch, rateLimited } from "./helpers.js";

const KEYS = { groqApiKey: "gsk_test", geminiApiKey: "AIza_test" };
const PLAN = JSON.stringify({
  decisions: { primaryLanguage: "javascript", framework: "express" },
  tasks: [
    { title: "Package manifest", targetArtifact: "package.json" },
    { title: "User model", targetArtifact: "src/models/User.js" },
    { title: "Auth routes", targetArtifact: "src/routes/auth.js" },
  ],
});

const isGemini = (url: string) => url.includes("generativelanguage");
const isPlanner = (body: any) => body.response_format?.type === "json_object";

test("gated prompts short-circuit with zero provider calls and no keys", async () => {
  installFetch(() => assert.fail("no network expected"));
  const app = buildServer();
  const res = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "thanks!" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "gated");
  assert.equal(calls.length, 0);
});

test("full relay: Groq sprint, 429 failover to Gemini with full context, zip download", async () => {
  let groqCalls = 0;
  const geminiPrompts: string[] = [];
  installFetch(({ url, body }) => {
    if (isGemini(url)) {
      if (isPlanner(body)) return completion(PLAN);
      geminiPrompts.push(body.messages[1].content);
      return completion("```js\nexport const User = {};\n```");
    }
    groqCalls++;
    if (groqCalls === 1) return completion('```json\n{"name": "auth"}\n```');
    return rateLimited();
  });

  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/api/orchestrate",
    payload: { userPrompt: "Create an Express.js authentication service with JWT and bcrypt", taskType: "code", keys: KEYS },
  });
  assert.equal(res.statusCode, 200);
  const out = res.json();

  assert.equal(out.status, "success");
  assert.match(out.workspaceId, /^ws_\d+_[0-9a-f]{16}$/);
  assert.deepEqual(out.summary, {
    totalTasks: 3,
    completedTasks: 3,
    artifactsGenerated: ["package.json", "src/models/User.js", "src/routes/auth.js"],
  });
  assert.equal(out.artifacts["package.json"], '{"name": "auth"}\n');
  assert.equal(out.artifacts["src/models/User.js"], "export const User = {};\n");

  const events = out.executionLogs.map((l: any) => `${l.step}:${l.event}:${l.provider}`);
  assert.deepEqual(events, [
    "0:plan:google",
    "1:execute:groq",
    // Step 2: every Groq model is rate limited (gpt-oss, llama-3.3, llama-3.1), then Baton leaves Groq.
    "2:failover:groq",
    "2:failover:groq",
    "2:failover:groq",
    "2:failover:groq",
    "2:execute:google",
    // Groq is cooling down after the 429s, so task 3 goes straight to Gemini.
    "3:execute:google",
    "4:complete:baton",
  ]);
  assert.ok(out.executionLogs.some((l: any) => /HTTP 429 rate limit detected; passing baton to Google AI Studio/.test(l.message)));
  assert.deepEqual(out.calls.filter((c: any) => c.step === 2 && c.provider === "groq").map((c: any) => c.model),
    ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);

  // Context preservation: Gemini sees Groq's earlier output via the workspace.
  assert.match(geminiPrompts[0], /=== package\.json === \(written by groq\/openai\/gpt-oss-120b\)\n\{"name": "auth"\}/);
  assert.match(geminiPrompts[0], /framework: express/);

  const zip = await app.inject({ method: "GET", url: out.downloadUrl });
  assert.equal(zip.statusCode, 200);
  assert.equal(zip.headers["content-type"], "application/zip");
  assert.equal(zip.rawPayload.subarray(0, 2).toString(), "PK");
  for (const name of out.summary.artifactsGenerated) assert.ok(zip.rawPayload.includes(name), name);
});

test("planner falls back to Groq when Gemini is rate limited", async () => {
  installFetch(({ url, body }) => {
    if (isGemini(url)) return rateLimited();
    return isPlanner(body) ? completion(PLAN) : completion("ok");
  });
  const res = await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: KEYS },
  });
  const out = res.json();
  assert.equal(out.status, "success");
  assert.equal(out.executionLogs.find((l: any) => l.event === "plan").provider, "groq");
  assert.ok(out.executionLogs.some((l: any) => l.provider === "google" && /passing planning to groq/.test(l.message)));
  assert.deepEqual(calls.filter((c) => c.url.includes("generativelanguage") && c.url.endsWith("/chat/completions")).map((c) => c.model),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite"], "both Gemini models tried before leaving Gemini");
});

test("reports partial status when every provider fails a task", async () => {
  let n = 0;
  installFetch(({ url, body }) => {
    if (isGemini(url) && isPlanner(body)) return completion(PLAN);
    n++;
    return n <= 1 ? completion("ok") : new Response("boom", { status: 500 });
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: KEYS },
  })).json();
  assert.equal(out.status, "partial");
  assert.equal(out.summary.completedTasks, 1);
});

test("validation: missing keys -> 400, bad taskType -> 400, unknown workspace -> 404", async () => {
  installFetch(() => assert.fail("no network expected"));
  const app = buildServer();
  const noKeys = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an app", keys: {} } });
  assert.equal(noKeys.statusCode, 400);
  assert.equal(noKeys.json().error, "missing_keys");
  const badType = await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "x y", taskType: "poem", keys: KEYS } });
  assert.equal(badType.statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/download/ws_123" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/download/..%2Fetc" })).statusCode, 404);
});

test("planning failure on all providers -> 502", async () => {
  installFetch(() => rateLimited());
  const res = await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an app", keys: KEYS },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "planning_failed");
});

test("GET / serves the web UI", async () => {
  const res = await buildServer().inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(res.body, /<title>Baton<\/title>/);
});

test("defaults: Gemini prefers gemini-3.8-flash, then gemini-3.5-flash-lite", async () => {
  const { geminiTarget } = await import("../src/providers/gemini.js");
  const t = geminiTarget("k");
  assert.equal(t.model, "gemini-3.8-flash");
  assert.deepEqual(t.fallbackModels, ["gemini-3.5-flash-lite"]);
});

test("retired Gemini model: planner swaps to the lite model, relay skips the dead one afterwards", async () => {
  const RETIRED = new Response('[{"error":{"code":404,"message":"This model is no longer available to new users."}}]', { status: 404 });
  installFetch(({ url, model, body }) => {
    if (!isGemini(url)) return rateLimited(); // force every task onto Gemini
    if (model === "gemini-3.8-flash") return RETIRED.clone();
    return isPlanner(body) ? completion(PLAN) : completion("ok");
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: KEYS },
  })).json();

  assert.equal(out.status, "success");
  const first = out.executionLogs.slice(0, 2).map((l: any) => [l.event, l.model, l.message]);
  assert.deepEqual(first, [
    ["failover", "gemini-3.8-flash", "HTTP 404 model unavailable: This model is no longer available to new users; retrying with gemini-3.5-flash-lite"],
    ["plan", "gemini-3.5-flash-lite", "Project decomposed into 3 milestones"],
  ]);
  const geminiModelsCalled = calls.filter((c) => isGemini(c.url)).map((c) => c.model);
  assert.equal(geminiModelsCalled.filter((m) => m === "gemini-3.8-flash").length, 1, "dead model only tried once per run");
  for (const t of ["src/models/User.js", "src/routes/auth.js"]) {
    assert.ok(out.executionLogs.some((l: any) => l.event === "execute" && l.model === "gemini-3.5-flash-lite" && l.message.includes(t)));
  }
});

test("all Gemini models retired: planning falls over to Groq only after both were tried", async () => {
  installFetch(({ url, body }) => {
    if (isGemini(url)) return new Response('{"error":{"message":"no longer available"}}', { status: 404 });
    return isPlanner(body) ? completion(PLAN) : completion("ok");
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: KEYS },
  })).json();
  assert.equal(out.status, "success");
  assert.deepEqual(out.executionLogs.slice(0, 4).map((l: any) => `${l.event}:${l.provider}:${l.model}`), [
    "failover:google:gemini-3.8-flash",
    "failover:google:gemini-3.5-flash-lite",
    "failover:google:gemini-3.5-flash-lite",
    "plan:groq:openai/gpt-oss-120b",
  ]);
  assert.match(out.executionLogs[2].message, /HTTP 404 model unavailable: no longer available; passing planning to groq/);
});

const OVERLOADED = () => new Response(
  '[{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}]',
  { status: 503 },
);

test("Gemini overloaded with both keys: planner hands off to Groq at once, without waiting", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "5000"; // would make the test slow if we waited
  try {
    installFetch(({ url, body }) => (isGemini(url) ? OVERLOADED() : isPlanner(body) ? completion(PLAN) : completion("ok")));
    const t0 = Date.now();
    const out = (await buildServer().inject({
      method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: KEYS },
    })).json();
    assert.ok(Date.now() - t0 < 2000, "no overload wait when another provider is available");
    assert.equal(out.status, "success");
    assert.equal(out.executionLogs.find((l: any) => l.event === "plan").provider, "groq");
    assert.equal(calls.filter((c) => isGemini(c.url) && c.url.endsWith("/chat/completions")).length, 2, "both Gemini models tried once");
  } finally {
    process.env.BATON_OVERLOAD_RETRY_MS = "0";
  }
});

test("Gemini-only and overloaded: retries once, then a clear 502 with a hint", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
  installFetch(() => OVERLOADED());
  const res = await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: { geminiApiKey: "AIza_test" } },
  });
  assert.equal(res.statusCode, 502);
  const msg = res.json().message;
  assert.match(msg, /google: HTTP 503 model overloaded/);
  assert.match(msg, /Gemini's servers are busy right now/);
  assert.match(msg, /Tip: adding a Groq, NVIDIA NIM, OpenRouter or OpenAI key/);
  assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 4, "2 models x 2 passes");
});

test("Gemini-only: overloaded first, recovers on the retry pass", async () => {
  process.env.BATON_OVERLOAD_RETRY_MS = "100";
  let n = 0;
  installFetch(({ body }) => (++n <= 2 ? OVERLOADED() : isPlanner(body) ? completion(PLAN) : completion("ok")));
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: { geminiApiKey: "AIza_test" } },
  })).json();
  assert.equal(out.status, "success");
  assert.deepEqual(out.executionLogs.slice(0, 3).map((l: any) => l.message), [
    "HTTP 503 model overloaded; retrying with gemini-3.5-flash-lite",
    "HTTP 503 model overloaded; retrying with gemini-3.8-flash in 0.1s",
    "Project decomposed into 3 milestones",
  ]);
  process.env.BATON_OVERLOAD_RETRY_MS = "0";
});

// ---- OpenAI (optional, paid, last resort) ----

const isOpenAI = (url: string) => url.includes("api.openai.com");

test("OpenAI target: last in the waterfall, model fallback list, no temperature sent", async () => {
  const { buildTargets } = await import("../src/services/orchestrator.js");
  const t = buildTargets({ groqApiKey: "g", geminiApiKey: "m", openaiApiKey: "o" }, "code");
  assert.deepEqual(t.planner.map((x) => x.provider), ["google", "groq", "openai"]);
  assert.deepEqual(t.relay.map((x) => x.provider), ["groq", "google", "openai"]);
  const openai = t.relay[2];
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.model, "gpt-5-mini");
  assert.deepEqual(openai.fallbackModels, ["gpt-4.1-mini"]);

  let sent: any;
  installFetch(({ body }) => ((sent = body), completion("ok")));
  const { chatCompletion } = await import("../src/providers/client.js");
  await chatCompletion(openai, [], { temperature: 0.1 });
  assert.equal("temperature" in sent, false);
});

test("OpenAI only used after Groq and Gemini both fail", async () => {
  installFetch(({ url, body }) => {
    if (isGemini(url) && isPlanner(body)) return completion(PLAN);
    if (isOpenAI(url)) return completion("from openai");
    return rateLimited(); // Groq and Gemini execution both rate limited
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate",
    payload: { userPrompt: "Build an auth service", keys: { ...KEYS, openaiApiKey: "sk-test" } },
  })).json();
  assert.equal(out.status, "success");
  // Each provider's models are all tried before moving on; the provider-level hand-offs are in order.
  const step1 = out.executionLogs.filter((l: any) => l.step === 1);
  assert.deepEqual(step1.filter((l: any) => /passing baton/.test(l.message) || l.event === "execute").map((l: any) => `${l.event}:${l.provider}`), [
    "failover:groq", "failover:google", "execute:openai",
  ]);
  assert.ok(out.executionLogs.some((l: any) => l.step === 1 && l.provider === "google" && /passing baton to OpenAI/.test(l.message)));
  assert.equal(out.artifacts["package.json"], "from openai\n");
});

test("OpenAI key alone is enough to run", async () => {
  installFetch(({ url, body }) => {
    assert.ok(isOpenAI(url), "only OpenAI should be called");
    return isPlanner(body) ? completion(PLAN) : completion("ok");
  });
  const out = (await buildServer().inject({
    method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build an auth service", keys: { openaiApiKey: "sk-test" } },
  })).json();
  assert.equal(out.status, "success");
  assert.equal(out.executionLogs[0].provider, "openai");
});

test("the web UI's inline script is valid JavaScript (guards against template-literal escaping slips)", async () => {
  const { Script } = await import("node:vm");
  const { UI_HTML } = await import("../src/ui.js");
  const js = /<script>([\s\S]*)<\/script>/.exec(UI_HTML)![1];
  assert.doesNotThrow(() => new Script(js));
  // The page lives in a TS template literal, where backslash escapes get rewritten; the script avoids them entirely.
  assert.ok(!js.includes(String.fromCharCode(92)), "no backslashes in the inline script");
});
