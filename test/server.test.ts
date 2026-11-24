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
    "2:failover:groq",
    "2:execute:google",
    // Groq is cooling down after the 429, so task 3 goes straight to Gemini.
    "3:execute:google",
    "4:complete:baton",
  ]);
  assert.match(out.executionLogs[2].message, /HTTP 429 rate limit detected; passing baton to Google AI Studio/);
  assert.equal(groqCalls, 2);

  // Context preservation: Gemini sees Groq's earlier output via the workspace.
  assert.match(geminiPrompts[0], /=== package\.json ===\n\{"name": "auth"\}/);
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
  assert.deepEqual(out.executionLogs.slice(0, 2).map((l: any) => `${l.event}:${l.provider}`), ["failover:google", "plan:groq"]);
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
