import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { mergeUsage, sumUsage } from "../src/services/logging.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";

const tok = (p: number, c: number) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c });
const entry = (provider: string, model: string, tokens?: ReturnType<typeof tok>) =>
  ({ step: 1, event: "execute" as const, provider, model, message: "m", timestamp: "t", ...(tokens ? { tokens } : {}) });

test("sumUsage: separate totals per model, with call counts, biggest first", () => {
  const u = sumUsage([
    entry("groq", "llama-3.3-70b-versatile", tok(100, 20)),
    entry("groq", "llama-3.1-8b-instant", tok(50, 10)),
    entry("groq", "llama-3.3-70b-versatile", tok(300, 80)),
    entry("google", "gemini-3.8-flash"), // failed call, no tokens: not counted
  ]);
  assert.deepEqual(u.byModel.map((m) => [m.model, m.totalTokens, m.calls]), [
    ["llama-3.3-70b-versatile", 500, 2],
    ["llama-3.1-8b-instant", 60, 1],
  ]);
  assert.deepEqual(u.byProvider.groq, { promptTokens: 450, completionTokens: 110, totalTokens: 560, calls: 3 });
  assert.equal(u.total.calls, 3);
});

test("mergeUsage: combines runs per model", () => {
  const a = sumUsage([entry("groq", "m1", tok(10, 0)), entry("nvidia", "m2", tok(5, 0))]);
  const b = sumUsage([entry("groq", "m1", tok(20, 0))]);
  const m = mergeUsage([a, b]);
  assert.deepEqual(m.byModel.map((x) => [x.provider, x.model, x.totalTokens, x.calls]), [["groq", "m1", 30, 2], ["nvidia", "m2", 5, 1]]);
  assert.equal(m.total.totalTokens, 35);
  assert.equal(m.total.calls, 3);
});

function seed(dir: string, id: string, createdAt: string, logs: any[], usage?: any) {
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "runs", `${id}.json`), JSON.stringify({
    id, createdAt, durationMs: 1, userPrompt: id, taskType: "code", status: "success", providers: ["groq"],
    executionLogs: logs, artifacts: {}, ...(usage ? { usage } : {}),
  }));
}

test("/api/usage: today vs all time per model, including runs saved before per-model tracking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baton-usage-"));
  const now = new Date();
  const lastWeek = new Date(now.getTime() - 7 * 86400_000);
  // Older record format: usage without byModel/calls; per-model data comes from the log.
  seed(dir, "ws_1_old", lastWeek.toISOString(), [entry("groq", "llama-3.3-70b-versatile", tok(1000, 200))],
    { total: tok(1000, 200), byProvider: { groq: tok(1000, 200) } });
  seed(dir, "ws_2_new", now.toISOString(), [
    entry("groq", "llama-3.3-70b-versatile", tok(400, 100)),
    entry("nvidia", "qwen/qwen3-coder-480b-a35b-instruct", tok(300, 50)),
  ]);
  seed(dir, "run_3_gated", now.toISOString(), []); // gated: no tokens

  const app = buildServer({ history: new FileHistoryStore(dir), store: new InMemoryWorkspaceStore() });
  const u = (await app.inject({ method: "GET", url: "/api/usage" })).json();

  assert.equal(u.today.runs, 2);
  assert.deepEqual(u.today.byModel.map((m: any) => [m.model, m.totalTokens, m.calls]), [
    ["llama-3.3-70b-versatile", 500, 1],
    ["qwen/qwen3-coder-480b-a35b-instruct", 350, 1],
  ]);
  assert.equal(u.allTime.runs, 3);
  assert.deepEqual(u.allTime.byModel.map((m: any) => [m.model, m.totalTokens, m.calls]), [
    ["llama-3.3-70b-versatile", 1700, 2],
    ["qwen/qwen3-coder-480b-a35b-instruct", 350, 1],
  ]);
  assert.equal(u.allTime.total.totalTokens, 2050);
  assert.equal(u.allTime.since, lastWeek.toISOString());

  // The old record also gets a per-model breakdown when opened.
  const old = (await app.inject({ method: "GET", url: "/api/history/ws_1_old" })).json();
  assert.equal(old.usage.byModel[0].model, "llama-3.3-70b-versatile");
});

test("/api/usage with no history returns zeros", async () => {
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-empty-"))), store: new InMemoryWorkspaceStore() });
  const u = (await app.inject({ method: "GET", url: "/api/usage" })).json();
  assert.equal(u.allTime.total.totalTokens, 0);
  assert.deepEqual(u.today.byModel, []);
});
