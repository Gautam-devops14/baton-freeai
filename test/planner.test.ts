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

test("tolerates fenced JSON and caps at four tasks", () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, targetArtifact: `f${i}.js` }));
  assert.equal(parsePlan("```json\n" + plan(tasks) + "\n```").tasks.length, 4);
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

test("rejects plans with fewer than two valid tasks", () => {
  assert.throws(() => parsePlan(plan([{ title: "only", targetArtifact: "a.js" }])), /at least 2/);
  assert.throws(() => parsePlan("not json"), /no JSON/);
});
