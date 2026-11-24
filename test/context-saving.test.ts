import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineFile } from "../src/services/outline.js";
import { buildPlannerMessages, parsePlan } from "../src/services/planner.js";
import { buildTaskPrompt, selectContext } from "../src/services/relay.js";

const html = '<!doctype html><title>Shop</title><link href="styles.css" rel="stylesheet"><div id="cart" class="panel big"></div><input name="qty"><script src="app.js"></script>' + "<p>filler</p>".repeat(400);
const css = ".panel { color: red; }\n#cart .item:hover { opacity: .5 }\n:root { --brand: #333 }\n" + ".x { }\n".repeat(200);
const js = 'import { a } from "./a.js";\nexport function addToCart(id) {\n  document.getElementById("cart").append(id);\n}\nconst total = (items) => items.length;\n' + "// filler\n".repeat(400);

test("outlines keep names, ids, selectors and headings in a fraction of the size", () => {
  const h = outlineFile("index.html", html);
  assert.match(h, /title: Shop/);
  assert.match(h, /ids: cart/);
  assert.match(h, /classes: panel, big/);
  assert.match(h, /form fields: qty/);
  assert.match(h, /loads: styles\.css, app\.js/);
  assert.match(outlineFile("styles.css", css), /selectors: \.panel \| #cart \.item:hover/);
  const j = outlineFile("app.js", js);
  assert.match(j, /export function addToCart\(id\) \{/);
  assert.match(j, /const total = \(items\) => items\.length;/);
  assert.match(j, /uses DOM: cart/);
  assert.match(outlineFile("README.md", "# Title\ntext\n## Usage\nmore"), /# Title\n## Usage/);
  for (const [p, c] of [["index.html", html], ["styles.css", css], ["app.js", js]] as const) {
    assert.ok(outlineFile(p, c).length < c.length / 4, `${p} outline is much smaller`);
  }
});

test("parsePlan reads which earlier files each task uses", () => {
  const p = parsePlan(JSON.stringify({ tasks: [
    { title: "Page", targetArtifact: "index.html" },
    { title: "Logic", targetArtifact: "app.js", uses: ["index.html", "../evil", "app.js"] },
  ] }));
  assert.equal(p.tasks[0].uses, undefined);
  assert.deepEqual(p.tasks[1].uses, ["index.html"], "unsafe paths and self-references dropped");
});

const ws = (tasks: any[]): any => ({ workspaceId: "ws_1", userPrompt: "shop", taskType: "code", metadata: {}, tasks,
  artifacts: { "index.html": html, "styles.css": css, "data.json": '{"products":[]}' }, executionLogs: [] });

test("a step gets full text only of the files it uses; the rest as outlines", () => {
  const task = { id: 4, title: "Logic", targetArtifact: "app.js", status: "pending", uses: ["index.html"] };
  const w = ws([task]);
  assert.deepEqual(selectContext(w, task as any), { full: ["index.html"], outline: ["styles.css", "data.json"] });
  const prompt = buildTaskPrompt(w, task as any).messages[1].content;
  assert.ok(prompt.includes("<p>filler</p>"), "used file in full");
  assert.match(prompt, /=== styles\.css === \(outline only; full text not needed for this step\)\nselectors:/);
  assert.ok(!prompt.includes(".x { }"), "unused file's body not sent");
});

test("dependencies are detected from the code: the page that loads app.js goes in full when writing app.js", () => {
  const task = { id: 4, title: "Logic", targetArtifact: "app.js", status: "pending" };
  assert.deepEqual(selectContext(ws([task]), task as any), { full: ["index.html"], outline: ["styles.css", "data.json"] });
});

test("nothing detected and no 'uses': full text up to the budget (newest first), outlines beyond it", () => {
  process.env.BATON_CONTEXT_FULL_CHARS = "2000";
  try {
    const task = { id: 4, title: "Notes", targetArtifact: "notes.md", status: "pending" };
    const pick = selectContext(ws([task]), task as any);
    assert.ok(pick.full.includes("data.json"), "small file fits the budget");
    assert.ok(pick.outline.includes("index.html"), "the big file is outlined");
  } finally {
    delete process.env.BATON_CONTEXT_FULL_CHARS;
  }
});

test("planner is told to use the fewest files and to list what each file uses", () => {
  const sys = buildPlannerMessages(ws([]))[0].content;
  assert.match(sys, /FEWEST files that do the job well: 1 to 4/);
  assert.match(sys, /a simple page can be a single index\.html/);
  assert.match(sys, /list in "uses" the earlier files it must match/);
});
