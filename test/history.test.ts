import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { completion, installFetch } from "./helpers.js";

const KEYS = { groqApiKey: "gsk_SECRET_test", geminiApiKey: "AIza_SECRET_test", openaiApiKey: "sk-SECRET_test" };
const PLAN = JSON.stringify({ tasks: [
  { title: "Manifest", targetArtifact: "package.json" },
  { title: "Server", targetArtifact: "server.js" },
] });
const isGemini = (url: string) => url.includes("generativelanguage");
const isPlanner = (body: any) => body.response_format?.type === "json_object";

function freshServer(dir = mkdtempSync(join(tmpdir(), "baton-hist-"))) {
  return { dir, app: buildServer({ history: new FileHistoryStore(dir), store: new InMemoryWorkspaceStore() }) };
}
const post = (app: any, payload: object) => app.inject({ method: "POST", url: "/api/orchestrate", payload });

test("successful run is saved with prompt, log and files, and survives a server restart", async () => {
  installFetch(({ body }) => (isPlanner(body) ? completion(PLAN) : completion("content")));
  const { dir, app } = freshServer();
  const out = (await post(app, { userPrompt: "Build a tiny server", keys: KEYS })).json();
  assert.equal(out.historyId, out.workspaceId);

  // "Restart": a brand-new server and store reading the same folder, empty workspace cache.
  const app2 = buildServer({ history: new FileHistoryStore(dir), store: new InMemoryWorkspaceStore() });
  const list = (await app2.inject({ method: "GET", url: "/api/history" })).json().runs;
  assert.equal(list.length, 1);
  assert.equal(list[0].userPrompt, "Build a tiny server");
  assert.equal(list[0].status, "success");
  assert.equal(list[0].artifactCount, 2);
  assert.deepEqual(list[0].providers, ["groq", "google", "openai"]);

  const rec = (await app2.inject({ method: "GET", url: `/api/history/${out.historyId}` })).json();
  assert.deepEqual(Object.keys(rec.artifacts), ["package.json", "server.js"]);
  assert.ok(rec.executionLogs.some((l: any) => l.event === "plan"));
  assert.equal(rec.downloadUrl, `/api/download/${out.historyId}`);

  const zip = await app2.inject({ method: "GET", url: rec.downloadUrl });
  assert.equal(zip.statusCode, 200, "download works after restart, from history");
  assert.equal(zip.rawPayload.subarray(0, 2).toString(), "PK");
});

test("API keys are never written to history files", async () => {
  installFetch(({ body }) => (isPlanner(body) ? completion(PLAN) : completion("content")));
  const { dir, app } = freshServer();
  await post(app, { userPrompt: "Build a tiny server", keys: KEYS });
  await post(app, { userPrompt: "hello" });
  for (const f of readdirSync(join(dir, "runs"))) {
    assert.doesNotMatch(readFileSync(join(dir, "runs", f), "utf8"), /SECRET/);
  }
});

test("every prompt is recorded: gated, missing keys, and planning failures (with their log)", async () => {
  installFetch(({ url, body }) => {
    if (isGemini(url) && isPlanner(body)) return completion(JSON.stringify({ tasks: [{ title: "no path" }] }));
    return new Response(JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } }), { status: 429 });
  });
  const { app } = freshServer();

  const gated = (await post(app, { userPrompt: "thanks!" })).json();
  assert.ok(gated.historyId);

  const nokeys = await post(app, { userPrompt: "Build an app", keys: {} });
  assert.equal(nokeys.statusCode, 400);
  assert.ok(nokeys.json().historyId);

  // The user's reported case: Gemini returns an unusable plan, OpenAI has no credit.
  const failed = await post(app, { userPrompt: "Build an app", keys: { geminiApiKey: "x", openaiApiKey: "y" } });
  assert.equal(failed.statusCode, 502);
  const body = failed.json();
  assert.ok(body.historyId);
  assert.ok(body.executionLogs.length >= 2, "502 response includes the relay log");
  assert.match(body.message, /google: invalid plan/);
  assert.match(body.message, /openai: HTTP 429 account has no credit/);
  assert.match(body.message, /Gemini answered, but its plan wasn't usable/);
  assert.match(body.message, /OpenAI account has no credit; add a payment method/);
  assert.match(body.message, /Tip: adding a Groq key/);

  const runs = (await app.inject({ method: "GET", url: "/api/history" })).json().runs;
  assert.deepEqual(runs.map((r: any) => r.status), ["error", "error", "gated"], "newest first");
  const rec = (await app.inject({ method: "GET", url: `/api/history/${body.historyId}` })).json();
  assert.equal(rec.status, "error");
  assert.match(rec.message, /Planning failed/);
  assert.equal(rec.executionLogs.length, body.executionLogs.length);
  assert.equal(rec.downloadUrl, undefined);
});

test("a one-task plan from Gemini now succeeds instead of failing", async () => {
  installFetch(({ body }) => (isPlanner(body) ? completion('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}') : completion("<h1>hi</h1>")));
  const { app } = freshServer();
  const out = (await post(app, { userPrompt: "Make a hello page", keys: { geminiApiKey: "x" } })).json();
  assert.equal(out.status, "success");
  assert.deepEqual(out.summary.artifactsGenerated, ["index.html"]);
});

test("delete one run, clear all, and reject bad ids", async () => {
  installFetch(() => completion("x"));
  const { app } = freshServer();
  const a = (await post(app, { userPrompt: "hi" })).json().historyId;
  await post(app, { userPrompt: "bye" });
  assert.equal((await app.inject({ method: "DELETE", url: `/api/history/${a}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/api/history/${a}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/history" })).json().runs.length, 1);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/history" })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/api/history" })).json().runs.length, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/history/..%2F..%2Fetc%2Fpasswd" })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/history/not-an-id" })).statusCode, 404);
});

test("history is capped at BATON_HISTORY_MAX, dropping the oldest runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baton-cap-"));
  const h = new FileHistoryStore(dir, 3);
  for (let i = 0; i < 5; i++) {
    await h.add({ id: `run_${i}`, createdAt: new Date(2026, 0, 1, 0, i).toISOString(), durationMs: 0, userPrompt: `p${i}`,
      taskType: "code", status: "gated", providers: [], executionLogs: [], artifacts: {} });
  }
  assert.deepEqual((await h.list()).map((r) => r.id), ["run_4", "run_3", "run_2"]);
  assert.equal(readdirSync(join(dir, "runs")).length, 3);
});
