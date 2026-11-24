// Chat export: everything needed to review what happened, as a zip.
//   transcript.md  readable story: each prompt, the plan, every step's context,
//                  attempts (who failed and why), exact prompt, raw reply, files
//   chat.json      the complete run records (machine-readable)
//   project/       the latest version of the project's files
// API keys are never part of a record, so they can't end up in an export.

import type { HistoryRecord, HistoryStore, HistorySummary } from "./history.js";
import { mergeUsage } from "./logging.js";
import type { CallTrace, StepContext } from "../types.js";

const PROVIDER_LABEL: Record<string, string> = {
  groq: "Groq",
  google: "Gemini",
  nvidia: "NVIDIA NIM",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  baton: "Baton",
};
const label = (p: string) => PROVIDER_LABEL[p] ?? p;
const fmt = (n: number | undefined) => Math.round(n ?? 0).toLocaleString("en-US");
const secs = (ms: number | undefined) => `${((ms ?? 0) / 1000).toFixed(1)}s`;
/** Tilde fences: generated code often contains backtick fences itself. */
const block = (text: string, lang = "text") => `~~~~${lang}\n${text.replace(/\n?$/, "\n")}~~~~`;
const details = (summary: string, body: string) => `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Chat id of a summary, following the parent chain for records saved before chat ids existed. */
export function chatIdOf(r: Pick<HistorySummary, "id" | "chatId" | "parentId">, byId: Map<string, Pick<HistorySummary, "id" | "chatId" | "parentId">>): string {
  let c = r;
  const seen = new Set<string>();
  while (!c.chatId && c.parentId && byId.has(c.parentId) && !seen.has(c.id)) {
    seen.add(c.id);
    c = byId.get(c.parentId)!;
  }
  return c.chatId ?? c.id;
}

/** Group run summaries into chats: chatId -> runs (oldest first). */
export function groupChats(runs: HistorySummary[]): Map<string, HistorySummary[]> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const chats = new Map<string, HistorySummary[]>();
  for (const r of runs) {
    const id = chatIdOf(r, byId);
    if (!chats.has(id)) chats.set(id, []);
    chats.get(id)!.push(r);
  }
  for (const list of chats.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return chats;
}

function attemptsTable(calls: CallTrace[]): string {
  if (!calls.length) return "_No provider calls recorded for this step._";
  const rows = calls.map((c, i) => {
    const result = c.outcome === "ok" ? `✓ ${c.status ?? 200}` : `✗ ${c.status ?? "-"} ${c.outcome ?? ""}`;
    return `| ${i + 1} | ${cell(`${c.provider}/${c.model}`)} | ${cell(result)} | ${secs(c.latencyMs)} | ${c.tokens ? fmt(c.tokens.totalTokens) : ""} | ${cell(c.detail ?? "")} |`;
  });
  return ["| # | Provider / model | Result | Time | Tokens | Detail |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

function contextSummary(c: StepContext, rec: HistoryRecord): string {
  const parts = ["the goal"];
  if (c.conversation.length) parts.push(`${c.conversation.length} earlier request(s)`);
  const dec = Object.entries(c.decisions);
  if (dec.length) parts.push(`decisions (${dec.map(([k, v]) => `${k}=${v}`).join(", ")})`);
  if (c.manifest.length) parts.push(`the file list (${c.manifest.length})`);
  const files = c.files.map((f) => {
    const o = rec.artifactOrigins?.[f.path];
    const from = f.source === "previous" ? "earlier run" : o ? `step ${o.step}` : "this run";
    return `\`${f.path}\` (~${fmt(f.tokens)} tok, from ${from}${f.by ? `, ${f.by}` : ""})`;
  });
  if (files.length) parts.push(`full text of ${files.join(", ")}`);
  if (c.targetExisted) parts.push(`the current \`${c.target}\` to rewrite`);
  return `Given: ${parts.join("; ")}. Prompt ≈ ${fmt(c.promptTokens)} tokens.`;
}

function runSection(rec: HistoryRecord, n: number): string {
  const out: string[] = [];
  const when = new Date(rec.createdAt).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  out.push(`## ${n}. You${rec.parentId ? " (follow-up)" : ""} · ${when}`, "", quote(rec.userPrompt), "");

  const u = rec.usage?.total;
  const head = [
    rec.status,
    rec.durationMs !== undefined ? secs(rec.durationMs) : "",
    u ? `${fmt(u.totalTokens)} tokens (${fmt(u.promptTokens)} in, ${fmt(u.completionTokens)} out)` : rec.status === "gated" ? "0 tokens" : "",
    rec.providerOrder?.length ? `order: ${rec.providerOrder.map(label).join(" → ")}` : "",
  ].filter(Boolean);
  out.push(`### Baton · ${head.join(" · ")}`, "");
  out.push(`Run id: \`${rec.id}\`${rec.parentId ? ` · continues \`${rec.parentId}\`` : ""} · task type: ${rec.taskType} · keys: ${rec.providers.map(label).join(", ") || "none"}`, "");

  if (rec.status === "gated") {
    out.push(`Answered locally without calling any AI: ${rec.message ?? ""}`, "");
    return out.join("\n");
  }
  if (rec.status === "answered") out.push("**Answer** (a question, so no files were built):", "", quote(rec.message ?? ""), "");
  if (rec.status === "error" && rec.message) out.push("**Error:**", "", quote(rec.message), "");

  // Where the tokens went
  if (rec.breakdown) {
    const b = rec.breakdown;
    const total = Object.values(b).reduce((s, n) => s + n, 0) || 1;
    const rows: Array<[string, number, string]> = [
      ["Understanding (planning)", b.understanding, "measured"],
      ["Instructions", b.instructions, "estimated share of input"],
      ["Your request", b.request, "estimated share of input"],
      ["Context (files, decisions)", b.context, "estimated share of input"],
      ["Code written", b.code, "measured share of output"],
      ["Other reply text", b.otherText, "measured share of output"],
      ["Thinking", b.thinking, "reported or estimated"],
      ["Wasted", b.wasted, "measured"],
    ];
    out.push("**Where the tokens went:**", "", "| Category | Tokens | % | How measured |", "|---|---|---|---|",
      ...rows.map(([n, v, how]) => `| ${n} | ${fmt(v)} | ${((100 * v) / total).toFixed(1)}% | ${how} |`), "");
  }

  // Plan
  const tasks = rec.plan?.tasks ?? [];
  const planLog = rec.executionLogs.find((l) => l.event === "plan");
  if (tasks.length) {
    out.push(`**Plan**${planLog ? ` by ${planLog.provider}/${planLog.model}` : ""}:`, "");
    const dec = Object.entries(rec.plan?.metadata ?? {}).filter(([, v]) => v !== undefined && v !== "");
    if (dec.length) out.push(`- Decisions: ${dec.map(([k, v]) => `${k} = ${v}`).join("; ")}`);
    for (const t of tasks) out.push(`- Step ${t.id}: \`${t.targetArtifact}\` — ${t.title} → **${t.status}**${t.assignedProvider ? ` (${t.assignedProvider}/${t.assignedModel})` : ""}`);
    out.push("");
  }
  if (rec.changes && (rec.changes.modified.length || rec.changes.added.length)) {
    out.push(`**Files:** ${[rec.changes.modified.length ? `changed ${rec.changes.modified.map((f) => `\`${f}\``).join(", ")}` : "", rec.changes.added.length ? `added ${rec.changes.added.map((f) => `\`${f}\``).join(", ")}` : ""].filter(Boolean).join("; ")}`, "");
  }

  // Steps: context, attempts, exact prompt, raw replies
  const calls = rec.calls ?? [];
  for (const c of rec.contexts ?? []) {
    const title = c.kind === "plan" ? "Plan" : `${c.target} ${c.targetExisted ? "(rewrite)" : "(new file)"}`;
    out.push(`#### Step ${c.step} · ${title}`, "");
    out.push(contextSummary(c, rec), "");
    const stepCalls = calls.filter((k) => k.step === c.step);
    out.push(attemptsTable(stepCalls), "");
    const skips = rec.executionLogs.filter((l) => l.step === c.step && l.message.startsWith("skipped:"));
    for (const s of skips) out.push(`- ${s.message}`);
    if (skips.length) out.push("");
    out.push(details(`Exact prompt sent (~${fmt(c.promptTokens)} tokens)`, block(c.messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"))), "");
    for (const k of stepCalls.filter((x) => x.reply !== undefined)) {
      out.push(details(`Raw reply from ${k.provider}/${k.model} (${fmt(k.tokens?.completionTokens)} output tokens)`, block(k.reply!)), "");
    }
  }
  if (!rec.contexts?.length && rec.status !== "error") out.push("_Step details (context, prompts, replies) were not recorded for runs made before that feature._", "");

  // Relay log
  if (rec.executionLogs.length) {
    out.push(details(`Relay log (${rec.executionLogs.length} entries)`, rec.executionLogs.map((l) => `- ${l.timestamp.slice(11, 19)} [${l.step}] **${l.event}** ${l.provider}/${l.model}: ${l.message}${l.tokens ? ` (${fmt(l.tokens.totalTokens)} tok)` : ""}`).join("\n")), "");
  }
  return out.join("\n");
}

export function transcript(records: HistoryRecord[], chatId: string): string {
  const totals = mergeUsage(records.flatMap((r) => (r.usage?.byModel ? [r.usage] : [])));
  const calls = records.reduce((n, r) => n + (r.calls?.length ?? 0), 0);
  const head = [
    "# Baton chat export",
    "",
    `- Chat: ${records[0]?.userPrompt.split("\n")[0] ?? ""}`,
    `- Chat id: \`${chatId}\``,
    `- Exported: ${new Date().toISOString()}`,
    `- Messages: ${records.length} · Tokens: ${fmt(totals.total.totalTokens)} · Provider calls: ${calls}`,
    totals.byModel.length ? `- Tokens by model: ${totals.byModel.map((m) => `${m.provider}/${m.model} ${fmt(m.totalTokens)} (${m.calls} calls)`).join("; ")}` : "",
    "",
    "Files in this export: `transcript.md` (this story), `chat.json` (complete data), `project/` (latest version of the files). No API keys are included.",
    "",
    "---",
    "",
  ].filter((l) => l !== undefined);
  return head.join("\n") + records.map((r, i) => runSection(r, i + 1)).join("\n---\n\n") + "\n";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat";

/** Files for one chat's export, relative to `root`. */
export async function chatExportFiles(history: HistoryStore, chatId: string, root = ""): Promise<Record<string, string> | undefined> {
  const runs = groupChats(await history.list(Number.MAX_SAFE_INTEGER)).get(chatId);
  if (!runs?.length) return undefined;
  const records = (await Promise.all(runs.map((r) => history.get(r.id)))).filter((r): r is HistoryRecord => Boolean(r));
  const files: Record<string, string> = {
    [`${root}transcript.md`]: transcript(records, chatId),
    [`${root}chat.json`]: JSON.stringify({ chatId, exportedAt: new Date().toISOString(), runs: records }, null, 2),
  };
  const latest = [...records].reverse().find((r) => Object.keys(r.artifacts).length && r.status !== "error");
  for (const [path, content] of Object.entries(latest?.artifacts ?? {})) files[`${root}project/${path}`] = content;
  return files;
}

/** Files for exporting every chat, plus usage and server state. */
export async function allExportFiles(history: HistoryStore, server: unknown): Promise<Record<string, string>> {
  const runs = await history.list(Number.MAX_SAFE_INTEGER);
  const chats = [...groupChats(runs)].sort((a, b) => a[1][0].createdAt.localeCompare(b[1][0].createdAt));
  const files: Record<string, string> = {};
  const index: string[] = ["# Baton export: all chats", "", `Exported ${new Date().toISOString()} · ${chats.length} chats · ${runs.length} messages`, ""];
  for (const [i, [chatId, list]] of chats.entries()) {
    const folder = `chats/${String(i + 1).padStart(2, "0")}-${slug(list[0].userPrompt)}/`;
    Object.assign(files, await chatExportFiles(history, chatId, folder));
    index.push(`${i + 1}. [${list[0].userPrompt.split("\n")[0].slice(0, 80)}](${folder}transcript.md) — ${list.length} message(s), last ${list[list.length - 1].status}`);
  }
  files["index.md"] = index.join("\n") + "\n";
  files["usage.json"] = JSON.stringify(mergeUsage(runs.flatMap((r) => (r.usage?.byModel ? [r.usage] : []))), null, 2);
  files["server.json"] = JSON.stringify(server, null, 2);
  return files;
}
