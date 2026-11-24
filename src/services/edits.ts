// Edit blocks: for follow-ups, the model returns only what changes instead of
// rewriting a whole file (far fewer output tokens).
//
//   <<<<<<< SEARCH
//   exact lines from the current file
//   =======
//   replacement lines
//   >>>>>>> REPLACE

const BLOCK = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

export interface EditResult {
  ok: boolean;
  content?: string;
  edits: number;
  /** Characters of replacement text (what the model actually wrote). */
  writtenChars: number;
  error?: string;
}

const normalizeWs = (s: string) => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");

/** Apply SEARCH/REPLACE blocks to `current`. Every block must match, or nothing is applied. */
export function applyEdits(current: string, reply: string): EditResult {
  const blocks = [...reply.matchAll(BLOCK)].map((m) => ({ search: m[1], replace: m[2] }));
  if (!blocks.length) return { ok: false, edits: 0, writtenChars: 0, error: "no edit blocks in the reply" };
  let content = current;
  for (const [i, b] of blocks.entries()) {
    if (b.search.trim() === "") return { ok: false, edits: 0, writtenChars: 0, error: `edit ${i + 1} has an empty SEARCH` };
    if (content.includes(b.search)) {
      content = content.replace(b.search, () => b.replace);
      continue;
    }
    // Tolerate trailing-whitespace differences (models often drop them).
    const normContent = normalizeWs(content);
    const normSearch = normalizeWs(b.search);
    if (normSearch && normContent.includes(normSearch)) {
      content = normContent.replace(normSearch, () => b.replace);
      continue;
    }
    return { ok: false, edits: 0, writtenChars: 0, error: `edit ${i + 1}: SEARCH text not found in the current file` };
  }
  return { ok: true, content, edits: blocks.length, writtenChars: blocks.reduce((n, b) => n + b.replace.length, 0) };
}
