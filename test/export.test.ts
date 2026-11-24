import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { allExportFiles, chatExportFiles } from "../src/services/export.js";
import { FileHistoryStore } from "../src/services/history.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const KEYS = { groqApiKey: "gsk_SECRET_123", geminiApiKey: "AIza_SECRET_456" };

async function makeChat() {
  const dir = mkdtempSync(join(tmpdir(), "baton-exp-"));
  const history = new FileHistoryStore(dir);
  const app = buildServer({ history, store: new InMemoryWorkspaceStore() });
  let phase = 1;
  let groqCalls = 0;
  installFetch(({ url, body }) => {
    if (isPlanner(body)) {
      return reply(phase === 1
        ? '{"decisions":{"framework":"vanilla"},"tasks":[{"title":"Page","targetArtifact":"index.html"}]}'
        : '{"tasks":[{"title":"Add delete buttons","targetArtifact":"index.html"}]}');
    }
    if (url.includes("groq") && ++groqCalls === 1) return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 });
    return reply(phase === 1 ? "```html\n<h1>v1</h1>\n```" : "```html\n<h1>v2 with delete</h1>\n```");
  });
  const first = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build a todo page", keys: KEYS } })).json();
  phase = 2;
  await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "add delete buttons", keys: KEYS, continueFrom: first.historyId } });
  return { app, history, chatId: first.chatId as string };
}

test("each successful call's raw reply is stored on the run (not streamed, not in /api/debug)", async () => {
  const { app, history, chatId } = await makeChat();
  const rec = await history.get(chatId);
  const ok = rec!.calls!.filter((c) => c.outcome === "ok");
  assert.ok(ok.every((c) => typeof c.reply === "string" && c.reply.length > 0));
  assert.match(ok[0].reply!, /"framework":"vanilla"/, "the planner's own words are kept");
  const dbg = (await app.inject({ method: "GET", url: "/api/debug" })).json();
  assert.ok(dbg.recentCalls.every((c: any) => !("reply" in c)));
});

test("chat export: readable transcript with prompts, plan, attempts, exact prompts and raw replies", async () => {
  const { history, chatId } = await makeChat();
  const files = (await chatExportFiles(history, chatId))!;
  assert.deepEqual(Object.keys(files).sort(), ["chat.json", "project/index.html", "transcript.md"]);
  const md = files["transcript.md"];
  assert.match(md, /^# Baton chat export/);
  assert.match(md, /## 1\. You · .*\n\n> Build a todo page/);
  assert.match(md, /## 2\. You \(follow-up\) · .*\n\n> add delete buttons/);
  assert.match(md, /\*\*Plan\*\* by google\/gemini-3\.8-flash:/);
  assert.match(md, /- Decisions: framework = vanilla/);
  assert.match(md, /\| 1 \| groq\/openai\/gpt-oss-120b \| ✗ 429 rate_limit \|/, "failed attempts are listed with the reason");
  assert.match(md, /<summary>Exact prompt sent/);
  assert.match(md, /<summary>Raw reply from google\/gemini-3\.8-flash/);
  assert.match(md, /~~~~text\n```html\n<h1>v2 with delete<\/h1>\n```\n~~~~/, "raw reply kept verbatim, fences intact");
  assert.match(md, /\*\*Files:\*\* changed `index\.html`/);
  assert.equal(files["project/index.html"], "<h1>v2 with delete</h1>\n", "latest version of the files");
  const json = JSON.parse(files["chat.json"]);
  assert.equal(json.runs.length, 2);
  for (const content of Object.values(files)) assert.doesNotMatch(content, /SECRET/, "no API keys anywhere in the export");
});

test("export endpoints return zips; unknown chat -> 404; 'all' includes every chat plus usage and server info", async () => {
  const { app, history, chatId } = await makeChat();
  const one = await app.inject({ method: "GET", url: `/api/export/chat/${chatId}` });
  assert.equal(one.statusCode, 200);
  assert.equal(one.headers["content-type"], "application/zip");
  assert.match(String(one.headers["content-disposition"]), /todo-page-chat-export-.*\.zip/);
  assert.equal(one.rawPayload.subarray(0, 2).toString(), "PK");
  assert.equal((await app.inject({ method: "GET", url: "/api/export/chat/ws_nope" })).statusCode, 404);
  const all = await app.inject({ method: "GET", url: "/api/export/all" });
  assert.equal(all.statusCode, 200);
  const files = await allExportFiles(history, { server: "info" });
  assert.ok(Object.keys(files).some((f) => /^chats\/01-build-a-todo-page\/transcript\.md$/.test(f)), Object.keys(files).join());
  assert.ok(files["index.md"].includes("Build a todo page"));
  assert.ok(files["usage.json"] && files["server.json"]);
});
