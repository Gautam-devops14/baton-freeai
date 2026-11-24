import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { chatCompletion } from "../src/providers/client.js";
import { FileHistoryStore } from "../src/services/history.js";
import { buildCallBreakdown } from "../src/services/logging.js";
import { buildTaskPrompt } from "../src/services/relay.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";

const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const reply = (content: string, usage: object) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
const single = () => ({ provider: "groq", model: "m", baseUrl: "https://api.groq.com/openai/v1", apiKey: "g" });

test("build prompts measure their sections: instructions, request, context", () => {
  const ws: any = { workspaceId: "ws_1", userPrompt: "Build a todo app", taskType: "code", metadata: { framework: "vanilla" },
    tasks: [{ id: 1, title: "Page", targetArtifact: "index.html", status: "completed" }, { id: 2, title: "Logic", targetArtifact: "app.js", status: "pending" }],
    artifacts: { "index.html": "<html>" + "x".repeat(2000) + "</html>" }, executionLogs: [] };
  const { messages, sections } = buildTaskPrompt(ws, ws.tasks[1]);
  const all = messages.map((m) => m.content).join("");
  assert.ok(sections.context > sections.request, "shared files dominate the context");
  assert.ok(sections.instructions > 100 && sections.request >= "Build a todo app".length);
  assert.ok(Math.abs(sections.instructions + sections.request + sections.context - all.length) < 20, "sections cover the prompt");
});

test("call breakdown: input split by section share; output split into thinking, code and other text", () => {
  const b = buildCallBreakdown(
    { promptTokens: 1000, completionTokens: 600, totalTokens: 1600, reasoningTokens: 200 },
    { instructions: 200, request: 100, context: 700 },
    300, 400, // the file is 3/4 of the visible reply
  );
  assert.deepEqual(b, { instructions: 200, request: 100, context: 700, code: 300, otherText: 100, thinking: 200 });
});

test("thinking tokens: reported reasoning_tokens are used; otherwise streamed reasoning / <think> text is estimated", async () => {
  installFetch(() => reply("ok", { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60, completion_tokens_details: { reasoning_tokens: 30 } }));
  assert.equal((await chatCompletion(single(), [])).usage.reasoningTokens, 30);
  installFetch(() => reply("<think>" + "r".repeat(400) + "</think>answer", { prompt_tokens: 10, completion_tokens: 120, total_tokens: 130 }));
  const r = await chatCompletion(single(), []);
  assert.equal(r.content, "answer");
  assert.equal(r.usage.reasoningTokens, 104); // ~ (400 + tags) / 4
  assert.equal(r.usage.reasoningEstimated, true);
});

test("a run records where its tokens went (per call and in total), also in /api/usage", async () => {
  installFetch(({ body }) => {
    if (isPlanner(body)) return reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"},{"title":"Logic","targetArtifact":"app.js"}]}', { prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 });
    return reply("Here you go:\n```js\n" + "const a = 1;\n".repeat(20) + "```", { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000, completion_tokens_details: { reasoning_tokens: 40 } });
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-bd-"))), store: new InMemoryWorkspaceStore() });
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "todo app", keys: { groqApiKey: "g" } } })).json();
  const b = out.breakdown;
  assert.equal(b.understanding, 350, "the planning call");
  assert.equal(b.thinking, 80, "2 build calls x 40 reasoning tokens");
  assert.equal(b.instructions + b.request + b.context, 1600, "input of both build calls, split by purpose");
  assert.ok(b.code > b.otherText, "most visible output is the file itself");
  assert.equal(b.code + b.otherText + b.thinking, 400);
  assert.equal(b.wasted, 0);
  const total = Object.values(b as Record<string, number>).reduce((s, n) => s + n, 0);
  assert.equal(total, out.usage.total.totalTokens, "categories add up to the run's token total");
  assert.ok(out.calls.filter((c: any) => c.outcome === "ok").every((c: any) => c.breakdown));
  const u = (await app.inject({ method: "GET", url: "/api/usage" })).json();
  assert.equal(u.today.breakdown.understanding, 350);
});

test("tokens spent on an unusable plan count as 'wasted'", async () => {
  installFetch(({ url, body }) => {
    if (url.endsWith("/models")) return new Response('{"data":[]}');
    if (isPlanner(body) && url.includes("generativelanguage")) return reply('{"tasks":[{"title":"no path"}]}', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    return isPlanner(body)
      ? reply('{"tasks":[{"title":"Page","targetArtifact":"index.html"}]}', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
      : reply("<h1>x</h1>", { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
  });
  const app = buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-bd2-"))), store: new InMemoryWorkspaceStore() });
  const out = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "page", keys: { geminiApiKey: "m", groqApiKey: "g" } } })).json();
  assert.equal(out.breakdown.wasted, 120);
  assert.equal(out.breakdown.understanding, 120);
});
