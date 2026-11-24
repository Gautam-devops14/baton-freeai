import { test } from "node:test";
import assert from "node:assert/strict";
import { extractArtifactBody } from "../src/services/sanitize.js";

test("unwraps a fully fenced reply", () => {
  assert.equal(extractArtifactBody("```javascript\nconst a = 1;\n```", "a.js"), "const a = 1;\n");
});

test("drops chatty preamble and epilogue around a code block", () => {
  const raw = "Here is the file:\n\n```json\n{\"name\": \"x\"}\n```\n\nLet me know!";
  assert.equal(extractArtifactBody(raw, "package.json"), '{"name": "x"}\n');
});

test("keeps unfenced replies as-is", () => {
  assert.equal(extractArtifactBody("print('hi')", "a.py"), "print('hi')\n");
});

test("markdown targets keep their internal code fences", () => {
  const doc = "# Usage\n\nRun:\n\n```bash\nnpm start\n```\n\nDone.";
  assert.equal(extractArtifactBody(doc, "overview.md"), doc + "\n");
});

test("markdown wrapped in an outer fence is unwrapped once", () => {
  assert.equal(extractArtifactBody("```markdown\n# Title\n\nBody\n```", "overview.md"), "# Title\n\nBody\n");
});
