// Code-fence hygiene (spec §5, guardrail 2): turn a model's reply into a clean
// file, and check the result so a broken file can be retried.

const WHOLE_FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/;
const BLOCK_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;
/** A line that is only a fence marker (``` or ```lang or ~~~). */
const FENCE_LINE = /^\s*(`{3,}|~{3,})[\w.+-]*\s*$/;
/** Typical chatter around code: "Sure! Here's the file:", "Let me know if...". */
const LEAD_PROSE = /^(sure|certainly|of course|okay|ok\b|absolutely|great|here('s| is| are)|below (is|are)|this (is|file|code)|i('ve| have| will|'ll)|the following|as requested)\b/i;
const TRAIL_PROSE = /^(let me know|feel free|hope this|this (file|code|script|page|component|implementation)\b|note:|notes:|explanation:|key (points|features)|you can (now|run|open)|to (run|use) (this|it)|enjoy|happy coding)/i;

const ext = (path: string) => path.toLowerCase().split(".").pop() ?? "";
const isMarkdown = (path: string) => ["md", "markdown", "mdx"].includes(ext(path));
const isHtml = (path: string) => ["html", "htm"].includes(ext(path));
const CODE_EXT = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "less", "py", "go", "rb", "java", "kt", "rs", "php", "sql", "sh", "vue", "svelte"];

/** Drop prose lines before the code starts and after it ends (unfenced replies). */
function trimProse(text: string): string {
  const lines = text.split("\n");
  const isProse = (l: string, re: RegExp) => re.test(l.trim()) && !/[{};=<>]|^\s*(\/\/|#|\/\*)/.test(l.replace(/`[^`]*`/g, ""));
  while (lines.length > 1 && (lines[0].trim() === "" || isProse(lines[0], LEAD_PROSE) || FENCE_LINE.test(lines[0]))) lines.shift();
  // Trailing chatter: cut from the first trailing prose line to the end, if only prose/blank lines follow it.
  for (let i = lines.length - 1; i > 0; i--) {
    const l = lines[i].trim();
    if (l === "" || FENCE_LINE.test(lines[i])) continue;
    if (isProse(lines[i], TRAIL_PROSE)) {
      lines.splice(i);
      continue;
    }
    break;
  }
  while (lines.length && (lines[lines.length - 1].trim() === "" || FENCE_LINE.test(lines[lines.length - 1]))) lines.pop();
  return lines.join("\n");
}

/** Type-specific cleanup: keep only the part that belongs in the file. */
function trimToContent(text: string, path: string): string {
  const e = ext(path);
  if (isHtml(path)) {
    const start = text.search(/<!doctype html|<html[\s>]/i);
    if (start > 0) text = text.slice(start);
    const end = text.search(/<\/html>/i);
    if (end >= 0) text = text.slice(0, end + "</html>".length);
    return text;
  }
  if (e === "json") {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    return start >= 0 && end > start ? text.slice(start, end + 1) : text;
  }
  if (e === "svg") {
    const start = text.search(/<svg[\s>]/i);
    const end = text.search(/<\/svg>/i);
    return start >= 0 && end > start ? text.slice(start, end + "</svg>".length) : text;
  }
  return text;
}

/**
 * Turn a raw model reply into clean artifact contents.
 *  1. If the entire reply is one fenced block, unwrap it.
 *  2. Otherwise, for non-Markdown targets, take the longest fenced block
 *     (drops chatty "Here is your file:" preambles/epilogues).
 *  3. Unfenced replies: drop chatter lines before/after the code and stray fence lines.
 *  4. Type-specific trim: HTML from <!doctype/<html> to </html>, JSON from the first
 *     { or [ to the last } or ], SVG from <svg> to </svg>.
 *  Markdown targets keep internal fences (they're legitimate content).
 */
export function extractArtifactBody(raw: string, targetArtifact = ""): string {
  let text = raw.replace(/\r\n/g, "\n").trim();

  const whole = WHOLE_FENCE_RE.exec(text);
  let fenced = false;
  if (whole) {
    text = whole[2];
    fenced = true;
  } else if (!isMarkdown(targetArtifact)) {
    let best: string | undefined;
    for (const m of text.matchAll(BLOCK_RE)) {
      if (best === undefined || m[3].length > best.length) best = m[3];
    }
    if (best !== undefined) {
      text = best;
      fenced = true;
    }
  }
  if (!isMarkdown(targetArtifact)) {
    if (!fenced) text = trimProse(text);
    text = trimToContent(text, targetArtifact);
  }
  return text.replace(/\s+$/, "") + "\n";
}

/** Strip strings and comments so brace counting isn't fooled by them (rough, on purpose). */
function stripStringsAndComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/**
 * Check an extracted file for signs of a bad reply. Returns a short problem
 * description, or undefined if it looks fine. Deliberately lenient: only flags
 * things that are clearly broken (invalid JSON, cut-off HTML, leftover fences,
 * chatter at the top, clearly unclosed braces).
 */
export function checkArtifact(path: string, content: string): string | undefined {
  const e = ext(path);
  const text = content.trim();
  if (!text) return "the file is empty";
  if (isMarkdown(path)) return undefined;
  if (e === "json") {
    try {
      JSON.parse(text);
      return undefined;
    } catch {
      return "invalid JSON";
    }
  }
  if (/^\s*(`{3,}|~{3,})/m.test(text)) return "leftover code fence";
  if (isHtml(path)) {
    if (/<html[\s>]/i.test(text) && !/<\/html>/i.test(text)) return "missing </html> (reply cut off?)";
    return undefined;
  }
  if (e === "svg") return /<svg[\s>]/i.test(text) && /<\/svg>/i.test(text) ? undefined : "not a complete <svg>";
  if (CODE_EXT.includes(e)) {
    const first = text.split("\n")[0].trim();
    if (LEAD_PROSE.test(first) && !/[{};=<>()]/.test(first)) return "starts with explanation text, not code";
    if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "less", "java", "kt", "rs", "go", "php"].includes(e)) {
      const code = stripStringsAndComments(text);
      const open = (code.match(/\{/g) ?? []).length;
      const close = (code.match(/\}/g) ?? []).length;
      if (open - close >= 2) return `unbalanced braces (${open - close} unclosed; reply cut off?)`;
    }
  }
  return undefined;
}
