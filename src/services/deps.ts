// Direct dependencies between project files, detected from the code itself, so a
// build step gets the full text only of files it actually depends on (the rest
// as outlines). Complements the planner's "uses" list.

import { posix } from "node:path";

const CODE_EXT = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".css", ".vue", ".svelte"];

/** Raw references in a file: imports, requires, script/link/img src/href, CSS @import/url(). */
export function rawReferences(path: string, content: string): string[] {
  const refs: string[] = [];
  const add = (re: RegExp) => {
    for (const m of content.matchAll(re)) refs.push(m[1]);
  };
  add(/(?<!@)\bimport\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g); // ES import ... from "x" / import "x" (stops at ; so it can't span lines)
  add(/\bimport\(\s*["']([^"']+)["']\s*\)/g); // dynamic import("x")
  add(/\brequire\(\s*["']([^"']+)["']\s*\)/g); // CommonJS
  add(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g); // re-exports
  if (/\.(html?|vue|svelte|jsx|tsx)$/i.test(path)) add(/\b(?:src|href)=["']([^"'#?]+)["']/g);
  if (/\.(css|scss|less)$/i.test(path)) {
    add(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?/g);
    add(/url\(\s*["']?([^"')]+)["']?\s*\)/g);
  }
  return [...new Set(refs)].filter((r) => r && !/^(https?:|data:|mailto:|\/\/|#)/i.test(r));
}

/** Resolve a reference from `fromPath` to a known project file, trying common extensions and index files. */
export function resolveReference(fromPath: string, ref: string, known: Set<string>): string | undefined {
  const base = ref.startsWith("/") ? ref.slice(1) : ref.startsWith(".") ? posix.join(posix.dirname(fromPath), ref) : ref;
  const norm = posix.normalize(base).replace(/^\.\//, "");
  for (const ext of CODE_EXT) if (known.has(norm + ext)) return norm + ext;
  for (const ext of CODE_EXT.slice(1)) if (known.has(`${norm}/index${ext}`)) return `${norm}/index${ext}`;
  // Bare names in HTML (src="app.js") resolve relative to the page; also accept a basename match.
  const byBase = [...known].filter((k) => posix.basename(k) === posix.basename(norm));
  return byBase.length === 1 ? byBase[0] : undefined;
}

/** Files `path` directly depends on, among `known`. */
export function dependenciesOf(path: string, content: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const ref of rawReferences(path, content)) {
    const r = resolveReference(path, ref, known);
    if (r && r !== path) out.add(r);
  }
  return [...out];
}

/**
 * Direct dependencies for writing `target`:
 *  - files the planner listed in `uses`
 *  - files the current version of `target` references (follow-up edits)
 *  - files that reference `target` (e.g. index.html loads app.js -> app.js must match its ids)
 *  - package.json for JS/TS code (small, defines modules and scripts)
 */
export function directDependencies(target: string, artifacts: Record<string, string>, uses: string[] = []): string[] {
  const others = Object.keys(artifacts).filter((p) => p !== target);
  const known = new Set([...others, target]);
  const deps = new Set(uses.filter((u) => u !== target && others.includes(u)));
  if (artifacts[target] !== undefined) for (const d of dependenciesOf(target, artifacts[target], known)) if (d !== target) deps.add(d);
  for (const p of others) if (dependenciesOf(p, artifacts[p], known).includes(target)) deps.add(p);
  if (/\.(m?[jt]sx?|cjs)$/i.test(target) && others.includes("package.json")) deps.add("package.json");
  return others.filter((p) => deps.has(p));
}
