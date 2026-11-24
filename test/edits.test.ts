import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { applyEdits } from "../src/services/edits.js";
import { FileHistoryStore } from "../src/services/history.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const BIG = Array.from({ length: 80 }, (_, i) => `  <li id="item${i}">Item ${i}</li>`).join("\n");
const PAGE = `<ul id="list">\n${BIG}\n</ul>\n<button id="add">Add</button>\n`;
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const reply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));

test("applyEdits: applies every block, tolerates trailing spaces, and refuses partial application", () => {
  const ok = applyEdits(PAGE, '<<<<<<< SEARCH\n<button id="add">Add</button>\n=======\n<button id="add">Add</button>\n<button id="del">Delete</button>\n>>>>>>> REPLACE');
  assert.equal(ok.ok, true);
  assert.equal(ok.edits, 1);
  assert.match(ok.content!, /<button id="del">Delete<\/button>/);
  assert.match(ok.content!, /id="item79"/, "rest of the file untouched");
  const ws = applyEdits("a = 1;   \nb = 2;\n", "<<<<<<< SEARCH\na = 1;\nb = 2;\n=======\na = 10;\nb = 2;\n>>>>>>> REPLACE");
  assert.equal(ws.ok, true);
  const bad = applyEdits(PAGE, "<<<<<<< SEARCH\n<button id=\"add\">Add</button>\n=======\nX\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nnot in the file\n=======\nY\n>>>>>>> REPLACE");
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /edit 2: SEARCH text not found/);
  assert.equal(applyEdits(PAGE, "no blocks here").ok, false);
});

async function followUp(editReply: (n: number) => string) {
  let phase = 1;
  let builds = 0;
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply(phase === 1 ? '{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}' : '{"tasks":[{"title":"Add a delete button","targetArtifact":"index.html"}]}');
    if (phase === 1) return reply("```html\n" + PAGE + "```", { prompt_tokens: 100, completion_tokens: 900, total_tokens: 1000 });
    return reply(editReply(++builds), { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 });
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-ed-"))), store: new InMemoryWorkspaceStore() });
  const first = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "list page", keys: { groqApiKey: "g" } } })).json();
  phase = 2;
  calls.length = 0;
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "add a delete button", keys: { groqApiKey: "g" }, continueFrom: first.historyId } })).json();
  return out;
}

test("follow-up on a big file asks for edit blocks and applies them (only the change is generated)", async () => {
  const out = await followUp(() => '<<<<<<< SEARCH\n<button id="add">Add</button>\n=======\n<button id="add">Add</button>\n<button id="del">Delete</button>\n>>>>>>> REPLACE');
  assert.equal(out.status, "success");
  assert.match(out.artifacts["index.html"], /<button id="del">Delete<\/button>/);
  assert.match(out.artifacts["index.html"], /id="item79"/);
  assert.ok(out.executionLogs.some((l: any) => l.message === "Generated index.html successfully (edited in place: 1 change)"));
  const buildPrompt = out.contexts.find((c: any) => c.kind === "task").messages[1].content;
  assert.match(buildPrompt, /<<<<<<< SEARCH/, "the model was asked for edit blocks");
});

test("edit blocks that don't match fall back to one full-file request from the same model", async () => {
  const out = await followUp((n) => (n === 1
    ? "<<<<<<< SEARCH\nthis text is not in the file\n=======\nX\n>>>>>>> REPLACE"
    : "```html\n" + PAGE.replace("</ul>", "</ul>\n<button id=\"del\">Delete</button>") + "```"));
  assert.equal(out.status, "success");
  assert.match(out.artifacts["index.html"], /id="del"/);
  assert.ok(out.executionLogs.some((l: any) => /edit blocks didn't apply .*asking for the full file instead/.test(l.message)));
  assert.equal(out.breakdown.wasted, 140, "the unusable edit reply counts as wasted");
});

test("small files are still rewritten in full (edit blocks wouldn't save much)", async () => {
  let phase = 1;
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply(phase === 1 ? '{"tasks":[{"title":"P","targetArtifact":"a.js"}]}' : '{"tasks":[{"title":"Change","targetArtifact":"a.js"}]}');
    return reply("```js\nconst a = " + phase + ";\n```");
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-ed2-"))), store: new InMemoryWorkspaceStore() });
  const first = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "x", keys: { groqApiKey: "g" } } })).json();
  phase = 2;
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "change", keys: { groqApiKey: "g" }, continueFrom: first.historyId } })).json();
  assert.equal(out.artifacts["a.js"], "const a = 2;\n");
  assert.doesNotMatch(out.contexts.find((c: any) => c.kind === "task").messages[1].content, /<<<<<<< SEARCH/);
});
