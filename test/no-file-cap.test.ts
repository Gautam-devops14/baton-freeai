import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../src/services/planner.js";
import { orchestrate } from "../src/services/orchestrator.js";
import { InMemoryWorkspaceStore } from "../src/services/storage.js";
import { installFetch } from "./helpers.js";

const FILES = ["package.json", "database.js", "server.js", "public/styles.css", "public/index.html", "public/app.js"];
const PLAN = JSON.stringify({ tasks: FILES.map((f) => ({ title: `Write ${f}`, targetArtifact: f })) });
const reply = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));

test("no 4-file cap: a 6-file plan builds every file, frontend included", async () => {
  installFetch(({ body }) => {
    if (body.messages?.[0]?.content?.includes("Task Architect")) return reply(PLAN);
    return reply("```\n{\"ok\": true}\n```");
  });
  const res: any = await orchestrate({ userPrompt: "Build a student app with login and dashboard", keys: { groqApiKey: "g" } }, new InMemoryWorkspaceStore());
  assert.equal(res.status, "success");
  assert.deepEqual(Object.keys(res.artifacts).sort(), [...FILES].sort());
  assert.equal(res.summary.totalTasks, 6);
});

test("safety guard only catches runaway plans, and says what it skipped", () => {
  const many = JSON.stringify({ tasks: Array.from({ length: 30 }, (_, i) => ({ title: "f", targetArtifact: `f${i}.js` })) });
  const p = parsePlan(many);
  assert.equal(p.tasks.length, 25);
  assert.equal(p.dropped?.length, 5);
  process.env.BATON_MAX_FILES = "40";
  try {
    assert.equal(parsePlan(many).tasks.length, 30);
  } finally {
    delete process.env.BATON_MAX_FILES;
  }
});
