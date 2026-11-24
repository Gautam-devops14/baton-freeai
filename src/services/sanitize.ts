// Robust code-fence stripping (spec §5, guardrail 2).

const WHOLE_FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/;
const BLOCK_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;

function isMarkdownTarget(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/**
 * Turn a raw model reply into clean artifact contents.
 *  1. If the entire reply is one fenced block, unwrap it.
 *  2. Otherwise, for non-Markdown targets, take the longest fenced block
 *     (drops chatty "Here is your file:" preambles/epilogues).
 *  3. Markdown targets keep internal fences (they're legitimate content).
 */
export function extractArtifactBody(raw: string, targetArtifact = ""): string {
  let text = raw.replace(/\r\n/g, "\n").trim();

  const whole = WHOLE_FENCE_RE.exec(text);
  if (whole) {
    text = whole[2];
  } else if (!isMarkdownTarget(targetArtifact)) {
    let best: string | undefined;
    for (const m of text.matchAll(BLOCK_RE)) {
      if (best === undefined || m[3].length > best.length) best = m[3];
    }
    if (best !== undefined) text = best;
  }

  return text.replace(/\s+$/, "") + "\n";
}
