import { test } from "node:test";
import assert from "node:assert/strict";
import { dependenciesOf, directDependencies, rawReferences } from "../src/services/deps.js";

test("finds ES imports, re-exports, dynamic imports, require, script/link src and CSS imports", () => {
  const js = 'import x from "./models/User";\nimport "./side.js";\nexport { a } from "../lib/util.js";\nconst y = require("./config.json");\nconst z = await import("./lazy.js");\nimport express from "express";';
  assert.deepEqual(rawReferences("routes/auth.js", js).sort(), ["../lib/util.js", "./config.json", "./lazy.js", "./models/User", "./side.js", "express"].sort());
  assert.deepEqual(rawReferences("index.html", '<link href="styles.css"><script src="app.js"></script><a href="https://x.com">x</a><img src="#top">'), ["styles.css", "app.js"]);
  assert.deepEqual(rawReferences("a.css", '@import "base.css";\n.logo { background: url("logo.svg"); }'), ["base.css", "logo.svg"]);
});

test("resolves references to project files (extensions, index files, relative paths)", () => {
  const known = new Set(["src/routes/auth.js", "src/models/User.js", "src/lib/index.ts", "package.json"]);
  const deps = dependenciesOf("src/routes/auth.js", 'const User = require("../models/User");\nimport { h } from "../lib";\nimport jwt from "jsonwebtoken";', known);
  assert.deepEqual(deps.sort(), ["src/lib/index.ts", "src/models/User.js"]);
});

test("direct dependencies of a new target: planner 'uses', files that reference it, package.json for JS", () => {
  const artifacts = {
    "package.json": '{"name":"auth"}',
    "models/User.js": "module.exports = {}",
    "index.html": '<script src="app.js"></script>',
    "requirements.md": "# Requirements",
    "database_schema.sql": "CREATE TABLE users();",
  };
  assert.deepEqual(directDependencies("routes/auth.js", artifacts, ["models/User.js"]), ["package.json", "models/User.js"]);
  assert.deepEqual(directDependencies("app.js", artifacts).sort(), ["index.html", "package.json"]);
  assert.deepEqual(directDependencies("styles.css", artifacts), [], "docs and schema are not dependencies of a stylesheet");
});

test("follow-up rewrite: the target's own imports count", () => {
  const artifacts = { "routes/auth.js": 'const User = require("../models/User");', "models/User.js": "x", "README.md": "# r" };
  assert.deepEqual(directDependencies("routes/auth.js", artifacts), ["models/User.js"]);
});
