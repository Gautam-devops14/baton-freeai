// Run history: every prompt sent to Baton, with its outcome, relay log and
// generated files, persisted to disk so it survives page refreshes and server
// restarts. API keys are never part of a record.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactOrigin, BatonTask, CallTrace, TokenBreakdown, BatonWorkspace, ExecutionLog, OrchestrateResponse, RunUsage, StepContext, TaskType } from "../types.js";
import { sumUsage } from "./logging.js";

export type RunStatus = OrchestrateResponse["status"] | "gated" | "error";

export interface HistoryRecord {
  /** Equals the workspaceId for runs that built something; `run_...` otherwise. */
  id: string;
  createdAt: string;
  durationMs: number;
  userPrompt: string;
  /** The request as sent to the models (greeting removed; for a resume, the original request). */
  goal?: string;
  taskType: TaskType;
  status: RunStatus;
  /** Error message, or the canned reply for a gated prompt. */
  message?: string;
  /** Which providers had keys for this run (names only, never the keys). */
  providers: string[];
  /** The order providers were tried in (only providers with keys). */
  providerOrder?: string[];
  summary?: OrchestrateResponse["summary"];
  /** Tokens spent by this run (absent for gated prompts and old records). */
  usage?: RunUsage;
  /** Follow-ups: the run this continued, and the earlier requests in the chain (oldest first). */
  parentId?: string;
  conversation?: string[];
  /** Files this run changed vs. added. */
  changes?: { modified: string[]; added: string[] };
  /** The plan (decisions + tasks), so a follow-up can keep the project's decisions. */
  plan?: { metadata: BatonWorkspace["metadata"]; tasks: BatonTask[] };
  /** What each step was given, and who wrote each file. */
  contexts?: StepContext[];
  artifactOrigins?: Record<string, ArtifactOrigin>;
  /** Chat thread (root run id); older records fall back to their parent chain. */
  chatId?: string;
  /** Every provider call this run made (debug view). */
  calls?: CallTrace[];
  /** Where this run's tokens went, by purpose. */
  breakdown?: TokenBreakdown;
  executionLogs: ExecutionLog[];
  artifacts: Record<string, string>;
}

export type HistorySummary = Omit<HistoryRecord, "executionLogs" | "artifacts" | "contexts" | "plan" | "artifactOrigins" | "calls"> & {
  artifactCount: number;
  logCount: number;
};

/** Per-chat settings the user chooses (e.g. the project name used for downloads). */
export interface ChatMeta {
  chatId: string;
  projectName?: string;
  updatedAt: string;
}

export interface HistoryStore {
  add(record: HistoryRecord): Promise<void>;
  getChatMeta(chatId: string): Promise<ChatMeta | undefined>;
  setChatMeta(meta: ChatMeta): Promise<void>;
  listChatMeta(): Promise<ChatMeta[]>;
  /** Newest first. */
  list(limit?: number): Promise<HistorySummary[]>;
  get(id: string): Promise<HistoryRecord | undefined>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export const HISTORY_ID_RE = /^(ws|run)_[A-Za-z0-9_]+$/;

/**
 * Records saved before per-model usage existed still have per-call tokens in
 * their log, so recompute usage from the log when `byModel` is missing.
 */
export function withUsage(r: HistoryRecord): HistoryRecord {
  if (r.usage?.byModel && r.usage.total?.calls !== undefined) return r;
  if (!r.executionLogs?.some((l) => l.tokens)) return r;
  return { ...r, usage: sumUsage(r.executionLogs) };
}

export function summarize(record: HistoryRecord): HistorySummary {
  const { executionLogs, artifacts, contexts: _c, plan: _p, artifactOrigins: _o, calls: _k, ...rest } = withUsage(record);
  return { ...rest, artifactCount: Object.keys(artifacts).length, logCount: executionLogs.length };
}

/**
 * One JSON file per run under `<dir>/runs/`. Summaries are cached in memory
 * after the first read; full records (with file contents) are read on demand.
 */
export class FileHistoryStore implements HistoryStore {
  private readonly runsDir: string;
  private readonly chatsDir: string;
  private index?: Map<string, HistorySummary>;
  private loading?: Promise<Map<string, HistorySummary>>;

  constructor(
    dir: string,
    private readonly maxRuns = Number(process.env.BATON_HISTORY_MAX ?? 500),
  ) {
    this.runsDir = join(dir, "runs");
    this.chatsDir = join(dir, "chats");
  }

  private chatFile(chatId: string) {
    if (!HISTORY_ID_RE.test(chatId)) throw new Error(`invalid chat id: ${chatId}`);
    return join(this.chatsDir, `${chatId}.json`);
  }

  async getChatMeta(chatId: string): Promise<ChatMeta | undefined> {
    if (!HISTORY_ID_RE.test(chatId)) return undefined;
    try {
      return JSON.parse(await readFile(this.chatFile(chatId), "utf8")) as ChatMeta;
    } catch {
      return undefined;
    }
  }

  async setChatMeta(meta: ChatMeta): Promise<void> {
    await mkdir(this.chatsDir, { recursive: true });
    const path = this.chatFile(meta.chatId);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, path);
  }

  async listChatMeta(): Promise<ChatMeta[]> {
    try {
      const names = (await readdir(this.chatsDir)).filter((n) => n.endsWith(".json"));
      const out: ChatMeta[] = [];
      for (const n of names) {
        try {
          out.push(JSON.parse(await readFile(join(this.chatsDir, n), "utf8")) as ChatMeta);
        } catch {
          // skip unreadable files
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private file(id: string) {
    if (!HISTORY_ID_RE.test(id)) throw new Error(`invalid history id: ${id}`);
    return join(this.runsDir, `${id}.json`);
  }

  private async load(): Promise<Map<string, HistorySummary>> {
    if (this.index) return this.index;
    this.loading ??= (async () => {
      await mkdir(this.runsDir, { recursive: true });
      const map = new Map<string, HistorySummary>();
      for (const name of await readdir(this.runsDir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const rec = JSON.parse(await readFile(join(this.runsDir, name), "utf8")) as HistoryRecord;
          if (HISTORY_ID_RE.test(rec.id)) map.set(rec.id, summarize(rec));
        } catch {
          // Skip a corrupt or half-written file rather than losing the whole history.
        }
      }
      this.index = map;
      return map;
    })();
    return this.loading;
  }

  async add(record: HistoryRecord) {
    const index = await this.load();
    const path = this.file(record.id);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, path); // atomic: a crash never leaves a half-written record
    index.set(record.id, summarize(record));
    await this.prune(index);
  }

  private async prune(index: Map<string, HistorySummary>) {
    if (index.size <= this.maxRuns) return;
    const oldest = [...index.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of oldest.slice(0, index.size - this.maxRuns)) await this.delete(r.id);
  }

  async list(limit = 200) {
    const index = await this.load();
    return [...index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async get(id: string) {
    if (!HISTORY_ID_RE.test(id)) return undefined;
    const index = await this.load();
    if (!index.has(id)) return undefined;
    try {
      return withUsage(JSON.parse(await readFile(this.file(id), "utf8")) as HistoryRecord);
    } catch {
      return undefined;
    }
  }

  async delete(id: string) {
    if (!HISTORY_ID_RE.test(id)) return false;
    const index = await this.load();
    const existed = index.delete(id);
    await rm(this.file(id), { force: true });
    return existed;
  }

  async clear() {
    const index = await this.load();
    for (const id of [...index.keys()]) await this.delete(id);
    await rm(this.chatsDir, { recursive: true, force: true });
  }
}
