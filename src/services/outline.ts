// File outlines: a short summary of a file (names, ids, selectors, headings)
// sent instead of its full text when a step doesn't need the whole file.
// Cuts context tokens while keeping every step aware of what exists.

const uniq = <T,>(a: T[]) => [...new Set(a)];

function take(lines: string[], maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) {
      out.push(`… (${lines.length - out.length} more)`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}

function htmlOutline(src: string): string[] {
  const ids = uniq([...src.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
  const classes = uniq([...src.matchAll(/\bclass=["']([^"']+)["']/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  const links = uniq([...src.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]));
  const forms = uniq([...src.matchAll(/<(?:input|select|textarea|button)[^>]*\bname=["']([^"']+)["']/g)].map((m) => m[1]));
  const title = /<title>([^<]*)<\/title>/i.exec(src)?.[1];
  return [
    title ? `title: ${title}` : "",
    ids.length ? `ids: ${ids.slice(0, 40).join(", ")}` : "",
    classes.length ? `classes: ${classes.slice(0, 40).join(", ")}` : "",
    forms.length ? `form fields: ${forms.slice(0, 30).join(", ")}` : "",
    links.length ? `loads: ${links.join(", ")}` : "",
  ].filter(Boolean);
}

function cssOutline(src: string): string[] {
  const selectors = uniq([...src.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim().replace(/\s+/g, " ")).filter((s) => s && !s.startsWith("@")));
  const vars = uniq([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  return [
    `selectors: ${selectors.slice(0, 60).join(" | ")}`,
    vars.length ? `variables: ${vars.slice(0, 30).join(", ")}` : "",
  ].filter(Boolean);
}

function codeOutline(src: string): string[] {
  const lines = src.split("\n");
  const decl = lines
    .map((l) => l.trim())
    .filter((l) =>
      /^(import |export |(async )?function |class |interface |type |const \w+\s*=\s*(\(|async|function|\w+\s*=>)|def |module\.exports|router\.|app\.(get|post|put|delete|use)\(|@)/.test(l),
    )
    .map((l) => (l.length > 140 ? `${l.slice(0, 137)}...` : l));
  const dom = uniq([...src.matchAll(/(?:getElementById|querySelector(?:All)?)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));
  return [...decl, dom.length ? `uses DOM: ${dom.slice(0, 30).join(", ")}` : ""].filter(Boolean);
}

function jsonOutline(src: string): string[] {
  try {
    const j = JSON.parse(src);
    if (Array.isArray(j)) return [`array of ${j.length}${j[0] && typeof j[0] === "object" ? `, item keys: ${Object.keys(j[0]).join(", ")}` : ""}`];
    if (j && typeof j === "object") return [`keys: ${Object.keys(j).join(", ")}`];
  } catch {
    // fall through
  }
  return src.split("\n").slice(0, 10);
}

/** A compact outline of a file, for steps that only need to know it exists and what it defines. */
export function outlineFile(path: string, content: string, maxChars = 1200): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  let lines: string[];
  if (["html", "htm", "vue", "svelte"].includes(ext)) lines = [...htmlOutline(content), ...(ext === "html" || ext === "htm" ? [] : codeOutline(content))];
  else if (["css", "scss", "less"].includes(ext)) lines = cssOutline(content);
  else if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "go", "rb", "java", "kt", "rs", "php"].includes(ext)) lines = codeOutline(content);
  else if (ext === "json") lines = jsonOutline(content);
  else if (["md", "markdown", "mdx", "txt"].includes(ext)) lines = content.split("\n").filter((l) => /^#{1,4} /.test(l));
  else lines = content.split("\n").slice(0, 15);
  if (!lines.length) lines = content.split("\n").slice(0, 10);
  return take(lines, maxChars);
}
