import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { checkArtifact, extractArtifactBody } from "../src/services/sanitize.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";

test("unfenced HTML with chatter before and after: only the document is kept", () => {
  const raw = "Sure! Here's the complete file you asked for:\n\n<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>\n\nLet me know if you want changes!";
  assert.equal(extractArtifactBody(raw, "index.html"), "<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>\n");
});

test("unfenced JS with a preamble and an epilogue: chatter lines removed, code intact", () => {
  const raw = "Here is the updated app.js:\nconst items = [];\nfunction add(x) {\n  items.push(x);\n}\nThis file keeps the list in memory.";
  assert.equal(extractArtifactBody(raw, "app.js"), "const items = [];\nfunction add(x) {\n  items.push(x);\n}\n");
});

test("JSON is trimmed to the object; SVG to the <svg> element; stray fence lines dropped", () => {
  assert.equal(extractArtifactBody('Here you go: {"name": "x"} — enjoy', "package.json"), '{"name": "x"}\n');
  assert.equal(extractArtifactBody('Logo:\n<svg viewBox="0 0 1 1"><circle/></svg>\nDone.', "logo.svg"), '<svg viewBox="0 0 1 1"><circle/></svg>\n');
  assert.equal(extractArtifactBody("```js\nconst a = 1;", "a.js"), "const a = 1;\n", "an unclosed opening fence is not left in the file");
});

test("code comments and Markdown are not mistaken for chatter", () => {
  const js = "// Here is the main entry point\nconst a = 1;\n";
  assert.equal(extractArtifactBody(js, "main.js"), js);
  const md = "Here is how to install:\n\n```bash\nnpm i\n```\n";
  assert.equal(extractArtifactBody(md, "README.md"), md);
});

test("checkArtifact flags clearly broken files and accepts good ones", () => {
  assert.equal(checkArtifact("data.json", '{"a": 1}'), undefined);
  assert.equal(checkArtifact("data.json", '{"a": 1'), "invalid JSON");
  assert.equal(checkArtifact("index.html", "<html><body>cut off here"), "missing </html> (reply cut off?)");
  assert.equal(checkArtifact("index.html", "<div>a fragment is fine</div>"), undefined);
  assert.equal(checkArtifact("app.js", "```js\nconst a = 1;\n```"), "leftover code fence");
  assert.equal(checkArtifact("app.js", "Here is your code\nconst a = 1;"), "starts with explanation text, not code");
  assert.match(checkArtifact("app.js", "function a() {\n  if (x) {\n    run();\n")!, /unbalanced braces \(2 unclosed/);
  assert.equal(checkArtifact("app.js", 'const s = "{{{"; // {\nfunction a() { return `${x}`; }'), undefined, "braces in strings/comments don't count");
  assert.equal(checkArtifact("README.md", "anything"), undefined);
});

test("a broken file is retried once with the problem spelled out; the bad reply counts as wasted", async () => {
  const prompts: string[] = [];
  let builds = 0;
  installFetch(({ body }) => {
    const sys = body.messages[0].content as string;
    if (sys.includes("Task Architect")) return new Response(JSON.stringify({ choices: [{ message: { content: '{"tasks":[{"title":"Data","targetArtifact":"data.json"}]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    prompts.push(body.messages[1].content);
    const content = ++builds === 1 ? '{"products": [1, 2' : '{"products": [1, 2]}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }));
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-hy-"))), store: new InMemoryWorkspaceStore() });
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "data", keys: { groqApiKey: "g" } } })).json();
  assert.equal(out.status, "success");
  assert.equal(out.artifacts["data.json"], '{"products": [1, 2]}\n');
  assert.ok(out.executionLogs.some((l: any) => l.message === "file check failed for data.json (invalid JSON); asking again"));
  assert.ok(out.executionLogs.some((l: any) => l.message === "Generated data.json successfully (fixed after a file check)"));
  assert.match(prompts[1], /A previous reply for this file had a problem: invalid JSON/);
  assert.equal(out.breakdown.wasted, 70);
});
