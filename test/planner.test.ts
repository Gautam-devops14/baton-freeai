import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../src/services/planner.js";

const plan = (tasks: unknown[], decisions: object = { primaryLanguage: "javascript" }) =>
  JSON.stringify({ decisions, tasks });

test("parses decisions and ordered tasks", () => {
  const p = parsePlan(plan([
    { title: "Manifest", targetArtifact: "package.json" },
    { title: "Model", targetArtifact: "./src/models/User.js" },
  ]));
  assert.equal(p.metadata.primaryLanguage, "javascript");
  assert.deepEqual(p.tasks.map((t) => [t.id, t.targetArtifact, t.status]), [
    [1, "package.json", "pending"],
    [2, "src/models/User.js", "pending"],
  ]);
});

test("tolerates fenced JSON and keeps every task (no 4-file cap)", () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, targetArtifact: `f${i}.js` }));
  assert.equal(parsePlan("```json\n" + plan(tasks) + "\n```").tasks.length, 6);
});

test("rejects path traversal, absolute-path tricks and duplicates", () => {
  const p = parsePlan(plan([
    { title: "a", targetArtifact: "../../etc/passwd" },
    { title: "b", targetArtifact: "/src/a.js" },
    { title: "c", targetArtifact: "src/a.js" },
    { title: "d", targetArtifact: "src/b.js" },
  ]));
  assert.deepEqual(p.tasks.map((t) => t.targetArtifact), ["src/a.js", "src/b.js"]);
});

test("accepts a one-task plan instead of failing a small request", () => {
  const p = parsePlan(plan([{ title: "only", targetArtifact: "index.html" }]));
  assert.deepEqual(p.tasks.map((t) => t.targetArtifact), ["index.html"]);
});

test("tolerates schema near-misses: other key names, bare arrays, missing titles", () => {
  const a = parsePlan(JSON.stringify({ architecture: { tone: "formal" }, files: [{ path: "a.md", description: "Intro" }, { filename: "b.md" }] }));
  assert.equal(a.metadata.tone, "formal");
  assert.deepEqual(a.tasks.map((t) => [t.targetArtifact, t.title]), [["a.md", "Intro"], ["b.md", "Write b.md"]]);
  const b = parsePlan(JSON.stringify([{ name: "Server", file_path: "server.js" }]));
  assert.deepEqual(b.tasks.map((t) => t.targetArtifact), ["server.js"]);
});

test("rejects plans with no usable tasks", () => {
  assert.throws(() => parsePlan(plan([{ title: "no path here" }])), /no usable tasks/);
  assert.throws(() => parsePlan(JSON.stringify({ decisions: {} })), /no tasks array/);
  assert.throws(() => parsePlan("not json"), /no JSON/);
});
