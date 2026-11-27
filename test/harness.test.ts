import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlannerMessages, ensureHarness } from "../src/services/planner.js";
import type { BatonTask } from "../src/types.js";

const tasks = (...paths: string[]): BatonTask[] => paths.map((p, i) => ({ id: i + 1, title: p, targetArtifact: p, status: "pending" }));
const paths = (ws: { tasks: BatonTask[] }) => ws.tasks.map((t) => t.targetArtifact);

test("planner prompt carries the Universal Runnable Harness Contract (code tasks only)", () => {
  const sys = (taskType: string) => buildPlannerMessages({ taskType, userPrompt: "x", artifacts: {}, tasks: [], metadata: {} } as any)[0].content;
  assert.match(sys("code"), /UNIVERSAL RUNNABLE HARNESS CONTRACT/);
  assert.match(sys("code"), /CLIENT_WEB[\s\S]*NODE_BACKEND[\s\S]*PYTHON_BACKEND_OR_SCRIPT[\s\S]*DATABASE_DATA[\s\S]*RULE: even if the user asks only for specific internal files/);
  assert.doesNotMatch(sys("document"), /HARNESS CONTRACT/);
});

test("CLIENT_WEB: CSS/JS planned without a page -> index.html added before the script, scripts use it", () => {
  const ws = { tasks: tasks("public/styles.css", "public/app.js"), artifacts: {}, metadata: {} };
  assert.deepEqual(ensureHarness(ws), ["public/index.html"]);
  assert.deepEqual(paths(ws), ["public/styles.css", "public/index.html", "public/app.js"]);
  assert.deepEqual(ws.tasks.map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(ws.tasks[1].uses, ["public/styles.css"]);
  assert.deepEqual(ws.tasks[2].uses, ["public/index.html"]);
});

test("NODE_BACKEND: server without package.json -> package.json added first", () => {
  const ws = { tasks: tasks("server.js", "database.js"), artifacts: {}, metadata: { framework: "Node.js/Express" } };
  assert.deepEqual(ensureHarness(ws), ["package.json"]);
  assert.equal(paths(ws)[0], "package.json");
});

test("NODE_BACKEND RULE: only models asked for -> package.json, server.js entry and .env.example (JWT/DB) added", () => {
  const ws = { tasks: tasks("models/user.js", "models/order.js"), artifacts: {}, metadata: { framework: "Express", database: "MongoDB", auth: "JWT" } };
  assert.deepEqual(ensureHarness(ws), ["package.json", "server.js", ".env.example"]);
  assert.deepEqual(paths(ws), ["package.json", "models/user.js", "models/order.js", "server.js", ".env.example"]);
  assert.deepEqual(ws.tasks[3].uses, ["models/user.js", "models/order.js"]);
});

test("PYTHON_BACKEND_OR_SCRIPT: Flask without requirements.txt -> requirements.txt added; app.py is the entry", () => {
  const ws = { tasks: tasks("app.py", "templates/index.html"), artifacts: {}, metadata: { framework: "Flask" } };
  assert.deepEqual(ensureHarness(ws), ["requirements.txt"]);
});

test("PYTHON_BACKEND_OR_SCRIPT: no root entry -> main.py added", () => {
  const ws = { tasks: tasks("scraper/fetch.py"), artifacts: {}, metadata: { primaryLanguage: "Python" } };
  assert.deepEqual(ensureHarness(ws), ["main.py"]);
});

test("DATABASE_DATA: SQL planned -> schema.sql, seed.sql and test_queries.sql in a runnable order", () => {
  const ws = { tasks: tasks("migrations/001_users.sql"), artifacts: {}, metadata: {} };
  assert.deepEqual(ensureHarness(ws).sort(), ["schema.sql", "seed.sql", "test_queries.sql"]);
  assert.deepEqual(paths(ws), ["schema.sql", "seed.sql", "migrations/001_users.sql", "test_queries.sql"]);
});

test("nothing added when the harness is already planned or already in the project (follow-ups)", () => {
  const full = { tasks: tasks("package.json", "server.js", "public/index.html", "public/styles.css", "public/app.js"), artifacts: {}, metadata: { framework: "Express" } };
  const sql = { tasks: tasks("schema.sql", "seed.sql", "test_queries.sql"), artifacts: {}, metadata: {} };
  assert.deepEqual(ensureHarness(sql), []);
  assert.deepEqual(ensureHarness(full), []);
  const followUp = { tasks: tasks("public/styles.css"), artifacts: { "public/index.html": "<html></html>" }, metadata: {} };
  assert.deepEqual(ensureHarness(followUp), []);
  const single = { tasks: tasks("index.html"), artifacts: {}, metadata: {} };
  assert.deepEqual(ensureHarness(single), []);
  const cli = { tasks: tasks("cli.js"), artifacts: {}, metadata: { primaryLanguage: "JavaScript" } };
  assert.deepEqual(ensureHarness(cli), [], "a plain script isn't forced into a server");
});
