import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { previewEntry, withPreviewShim } from "../src/services/preview.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";

const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const reply = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }] }));

test("live preview: sandboxed, serves the project's files, keeps localStorage apps working", async () => {
  assert.equal(previewEntry({ "a.html": "", "src/index.html": "", "index.html": "" }), "index.html");
  assert.equal(previewEntry({ "app.js": "" }), undefined);
  assert.ok(withPreviewShim("<html><head><title>x</title></head></html>").indexOf("localStorage") < "<html><head>".length + 400);
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"},{"title":"CSS","targetArtifact":"style.css"}]}');
    return /contents of `style\.css`/.test(body.messages[1].content)
      ? reply("```css\nh1 { color: red; }\n```")
      : reply('```html\n<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hi</h1></body></html>\n```');
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-pv-"))), store: new InMemoryWorkspaceStore() });
  const run = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Build a page", keys: { groqApiKey: "g" } } })).json();
  const entry = await app.inject({ method: "GET", url: `/api/preview/${run.historyId}` });
  assert.equal(entry.statusCode, 302);
  assert.equal(entry.headers.location, `/api/preview/${run.historyId}/index.html`);
  const page = await app.inject({ method: "GET", url: entry.headers.location as string });
  assert.match(String(page.headers["content-security-policy"]), /^sandbox allow-scripts/);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.ok(page.body.includes("localStorage") && page.body.includes("<h1>Hi</h1>"));
  const css = await app.inject({ method: "GET", url: `/api/preview/${run.historyId}/style.css` });
  assert.match(String(css.headers["content-type"]), /text\/css/);
  assert.equal((await app.inject({ method: "GET", url: `/api/preview/${run.historyId}/nope.js` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/preview/ws_missing` })).statusCode, 404);
});
