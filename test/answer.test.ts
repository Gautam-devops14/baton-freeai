import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/index.js";
import { FileHistoryStore } from "../src/services/history.js";
import { buildPlannerMessages, parsePlan } from "../src/services/planner.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { calls, installFetch } from "./helpers.js";

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 } }));
const isPlanner = (body: any) => body.messages?.[0]?.content?.includes("Task Architect");
const server = () => buildServer({ history: new FileHistoryStore(mkdtempSync(join(tmpdir(), "baton-ans-"))), store: new InMemoryWorkspaceStore() });

test("planner prompt tells the model to answer questions instead of planning files, and to build runnable code", () => {
  const sys = buildPlannerMessages({ workspaceId: "ws_1", userPrompt: "x", taskType: "code", metadata: {}, tasks: [], artifacts: {}, executionLogs: [] })[0].content;
  assert.match(sys, /If the message is a question/);
  assert.match(sys, /\{"answer": "Yes\."\}/);
  assert.match(sys, /not requirements, architecture or API documents/);
});

test("parsePlan: an answer with no tasks is an answer", () => {
  assert.deepEqual(parsePlan('{"answer":"Yes."}'), { metadata: {}, tasks: [], answer: "Yes." });
  // If the model plans files anyway, the files win.
  assert.equal(parsePlan('{"answer":"Sure","tasks":[{"title":"a","targetArtifact":"a.js"}]}').answer, undefined);
});

test("the user's case: a yes/no follow-up question is answered, nothing is built, the project is untouched", async () => {
  let phase = 1;
  installFetch(({ body }) => {
    if (isPlanner(body)) {
      return phase === 1
        ? reply('{"tasks":[{"title":"Spec","targetArtifact":"requirements.md"}]}')
        : reply('{"answer":"Yes."}');
    }
    return reply("# requirements");
  });
  const app = server();
  const keys = { groqApiKey: "g" };
  const first = (await app.inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Create a social media posting application", keys } })).json();
  phase = 2;
  calls.length = 0;
  const q = (await app.inject({
    method: "POST", url: "/api/orchestrate",
    payload: { userPrompt: "just tell me yes or no\ncan you make it a web working page?\nyes or no only", keys, continueFrom: first.historyId },
  })).json();

  assert.equal(q.status, "answered");
  assert.equal(q.answer, "Yes.");
  assert.deepEqual(q.artifacts, {});
  assert.equal(calls.length, 1, "one planner call, no build calls");
  assert.equal(q.usage.total.totalTokens, 43);
  assert.equal(q.chatId, first.chatId, "stays in the same chat");

  const rec = (await app.inject({ method: "GET", url: `/api/history/${q.historyId}` })).json();
  assert.equal(rec.status, "answered");
  assert.equal(rec.message, "Yes.");
  assert.equal(rec.downloadUrl, undefined, "no files to download");
  // The next real follow-up still continues from the built project (the answer changed nothing).
  const runs = (await app.inject({ method: "GET", url: "/api/history" })).json().runs;
  assert.equal(runs.find((r: any) => r.id === first.historyId).artifactCount, 1);
});

test("a standalone question in a new chat gets an answer too", async () => {
  installFetch(({ body }) => (isPlanner(body) ? reply('{"answer":"RAG = Retrieval-Augmented Generation: the AI looks up documents before answering."}') : reply("x")));
  const out = (await server().inject({ method: "POST", url: "/api/orchestrate", payload: { userPrompt: "Check what is AI in RAG?", keys: { groqApiKey: "g" } } })).json();
  assert.equal(out.status, "answered");
  assert.match(out.answer, /Retrieval-Augmented Generation/);
  assert.equal(calls.length, 1);
});
