// Line diffs between two versions of a file (what a follow-up changed).

export type DiffLine = { t: " " | "+" | "-"; text: string; oldNo?: number; newNo?: number };
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "unchanged";
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** True when the file was too big to diff line by line (shown as replaced). */
  tooLarge?: boolean;
}

const MAX_CELLS = 4_000_000; // LCS table cap (e.g. 2000 x 2000 lines)

/** Longest-common-subsequence line diff. */
export function lineDiff(before: string, after: string): { lines: DiffLine[]; tooLarge: boolean } {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  // Trim the common prefix/suffix first: follow-up edits are usually small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const lines: DiffLine[] = [];
  let oldNo = 1, newNo = 1;
  const same = (text: string) => lines.push({ t: " ", text, oldNo: oldNo++, newNo: newNo++ });
  const del = (text: string) => lines.push({ t: "-", text, oldNo: oldNo++ });
  const add = (text: string) => lines.push({ t: "+", text, newNo: newNo++ });
  for (let i = 0; i < start; i++) same(a[i]);
  let tooLarge = false;
  if (midA.length * midB.length > MAX_CELLS) {
    tooLarge = true;
    midA.forEach(del);
    midB.forEach(add);
  } else {
    const n = midA.length, m = midB.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = midA[i] === midB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { same(midA[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { del(midA[i]); i++; }
      else { add(midB[j]); j++; }
    }
    while (i < n) del(midA[i++]);
    while (j < m) add(midB[j++]);
  }
  for (let i = endA; i < a.length; i++) same(a[i]);
  return { lines, tooLarge };
}

/** Group changed lines into hunks with `context` unchanged lines around them. */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((l, i) => (l.t === " " ? -1 : i)).filter((i) => i >= 0);
  const hunks: DiffHunk[] = [];
  let k = 0;
  while (k < changed.length) {
    let from = Math.max(0, changed[k] - context);
    let to = Math.min(lines.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= to + 1) {
      k++;
      to = Math.min(lines.length - 1, changed[k] + context);
    }
    const slice = lines.slice(from, to + 1);
    const firstOld = slice.find((l) => l.oldNo !== undefined)?.oldNo ?? 0;
    const firstNew = slice.find((l) => l.newNo !== undefined)?.newNo ?? 0;
    hunks.push({ oldStart: firstOld, newStart: firstNew, lines: slice });
    k++;
  }
  return hunks;
}

export function diffFile(path: string, before: string | undefined, after: string | undefined): FileDiff {
  const status = before === undefined ? "added" : after === undefined ? "deleted" : before === after ? "unchanged" : "modified";
  const { lines, tooLarge } = lineDiff(before ?? "", after ?? "");
  return {
    path,
    status,
    added: lines.filter((l) => l.t === "+").length,
    removed: lines.filter((l) => l.t === "-").length,
    hunks: status === "unchanged" ? [] : toHunks(lines),
    ...(tooLarge ? { tooLarge } : {}),
  };
}
