import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { diffFile, lineDiff } from "../src/services/diff.js";
import { computeHealth } from "../src/services/health.js";
import { FileHistoryStore } from "../src/services/history.js";
import { defaultProjectName, slugify } from "../src/services/project.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const reply = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
const server = () => {
  const history = new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-dt-")));
  return { history, app: buildServer({ history, store: new InMemoryWorkspaceStore() }) };
};

async function projectWithFollowUp(app: any) {
  let phase = 1;
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply(phase === 1 ? '{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}' : '{"tasks":[{"title":"Add delete","targetArtifact":"index.html"}]}');
    return reply(phase === 1 ? "```html\n<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n```" : "```html\n<ul>\n  <li>a</li>\n  <li>b <button>Delete</button></li>\n</ul>\n```");
  });
  const first = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Create a web app to score student marks", keys: { groqApiKey: "g" } } })).json();
  phase = 2;
  const second = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "add a delete button", keys: { groqApiKey: "g" }, continueFrom: first.historyId } })).json();
  return { first, second };
}

test("project names: default from the first prompt, editable, used for the zip name and folder", async () => {
  assert.equal(defaultProjectName("Create a web app to score marks and student registration"), "web-app-score-marks");
  assert.equal(slugify("Student Portal!"), "student-portal");
  const { app } = server();
  const { first, second } = await projectWithFollowUp(app);
  let chats = (await app.inject({ method: "GET", url: "/api/chats" })).json().chats;
  assert.deepEqual(chats.map((c: any) => [c.projectName, c.custom]), [["web-app-score-student", false]]);
  const put = await app.inject({ method: "PUT", url: `/api/chats/${first.chatId}`, payload: { projectName: "Student Portal" } });
  assert.equal(put.statusCode, 200);
  chats = (await app.inject({ method: "GET", url: "/api/chats" })).json().chats;
  assert.deepEqual(chats.map((c: any) => [c.projectName, c.slug, c.custom]), [["Student Portal", "student-portal", true]]);
  const zip = await app.inject({ method: "GET", url: `/api/download/${second.historyId}` });
  assert.match(String(zip.headers["content-disposition"]), /filename="student-portal\.zip"/);
  assert.ok(zip.rawPayload.includes("student-portal/index.html"), "files sit in a folder named after the project");
  assert.equal((await app.inject({ method: "PUT", url: `/api/chats/${first.chatId}`, payload: { projectName: "x".repeat(81) } })).statusCode, 400);
});

test("diff: what a follow-up changed, line by line", async () => {
  const { app } = server();
  const { second } = await projectWithFollowUp(app);
  const d = (await app.inject({ method: "GET", url: `/api/history/${second.historyId}/diff` })).json();
  assert.equal(d.files.length, 1);
  const f = d.files[0];
  assert.deepEqual([f.path, f.status, f.added, f.removed], ["index.html", "modified", 1, 1]);
  const changed = f.hunks[0].lines.filter((l: any) => l.t !== " ").map((l: any) => l.t + l.text);
  assert.deepEqual(changed, ["-  <li>b</li>", "+  <li>b <button>Delete</button></li>"]);
});

test("lineDiff/diffFile basics: added files, identical files, line numbers", () => {
  assert.equal(diffFile("a.js", undefined, "x\ny\n").status, "added");
  assert.equal(diffFile("a.js", "x\n", "x\n").hunks.length, 0);
  const { lines } = lineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(lines.map((l) => `${l.t}${l.text}:${l.oldNo ?? ""}/${l.newNo ?? ""}`), [" a:1/1", "-b:2/", "+B:/2", " c:3/3"]);
});

test("provider health: success rate, latency and failures per model", async () => {
  const rows = computeHealth([
    { phase: "end", at: "2026-01-01T00:00:01Z", provider: "groq", model: "m", host: "h", outcome: "ok", latencyMs: 100, tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 50 } },
    { phase: "end", at: "2026-01-01T00:00:02Z", provider: "groq", model: "m", host: "h", outcome: "rate_limit", status: 429, latencyMs: 20, detail: "HTTP 429" },
    { phase: "end", at: "2026-01-01T00:00:03Z", provider: "groq", model: "m", host: "h", outcome: "ok", latencyMs: 300, tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 70 } },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ calls: rows[0].calls, ok: rows[0].ok, rate: rows[0].successRate.toFixed(2), avg: rows[0].avgLatencyMs, tokens: rows[0].tokens, failures: rows[0].failures },
    { calls: 3, ok: 2, rate: "0.67", avg: 200, tokens: 120, failures: { rate_limit: 1 } });
  assert.equal(rows[0].lastError!.outcome, "rate_limit");

  const { app } = server();
  await projectWithFollowUp(app);
  const h = (await app.inject({ method: "GET", url: "/api/health" })).json();
  assert.equal(h.runs, 2);
  assert.ok(h.models.some((m: any) => m.provider === "groq" && m.successRate === 1));
  assert.ok(Array.isArray(h.skipping));
});

test("replay: re-sends a step's exact recorded prompt to a chosen provider/model, without changing the project", async () => {
  const { app } = server();
  const { first } = await projectWithFollowUp(app);
  const rec = (await app.inject({ method: "GET", url: `/api/history/${first.historyId}` })).json();
  const recorded = rec.contexts.find((c: any) => c.step === 1).messages;
  let sent: any;
  installFetch(({ url, body }) => ((sent = { url, body }), reply("```html\n<p>replayed</p>\n```")));
  const r = (await app.inject({ method: "POST", url: "/api/replay", payload: { historyId: first.historyId, step: 1, provider: "openrouter", model: "some/model:free", keys: { openrouterApiKey: "r" } } })).json();
  assert.equal(r.ok, true);
  assert.equal(r.model, "some/model:free");
  assert.match(r.reply, /replayed/);
  assert.deepEqual(sent.body.messages, recorded, "exactly the recorded prompt");
  assert.ok(sent.url.startsWith("https://openrouter.ai/"));
  assert.equal(calls.length, 1, "exactly one call: the chosen model, no fallbacks");
  const after = (await app.inject({ method: "GET", url: `/api/history/${first.historyId}` })).json();
  assert.deepEqual(after.artifacts, rec.artifacts, "the project is untouched");
  const noKey = await app.inject({ method: "POST", url: "/api/replay", payload: { historyId: first.historyId, step: 1, provider: "groq", keys: {} } });
  assert.equal(noKey.statusCode, 400);
  installFetch(() => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }));
  const fail = (await app.inject({ method: "POST", url: "/api/replay", payload: { historyId: first.historyId, step: 1, provider: "groq", model: "x", keys: { groqApiKey: "g" } } })).json();
  assert.equal(fail.ok, false);
  assert.equal(fail.kind, "rate_limit");
});
