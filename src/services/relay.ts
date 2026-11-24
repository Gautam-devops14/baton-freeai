// Stage 3: the resilient relay loop (spec §3).
// Explicit and imperative by design (guardrail 5): every prompt is built here,
// from the shared workspace, so any model can pick up where another stopped.

import { chatCompletion, ProviderError } from "../providers/client.js";
import type { BatonTask, BatonWorkspace, ChatMessage, ProviderTarget } from "../types.js";
import { busyUntilFor, splitBusy } from "../providers/memory.js";
import { attachBreakdown, buildCallBreakdown, log, logBusySkips, logModelSwaps, traceFor } from "./logging.js";
import { extractArtifactBody } from "./sanitize.js";
import { contextFile, originLabel, recordContext } from "./context.js";

const DEFAULT_COOLDOWN_MS = 60_000;
/** Assumed reset time when a 429 gives no Retry-After hint. */
const UNKNOWN_RATE_RESET_MS = 10_000;
/** Longest Baton will wait for a rate limit before giving up on a file (second chance). */
const maxRateWaitMs = () => Number(process.env.BATON_MAX_RATE_WAIT_MS ?? 20_000);
/** Rate limits resetting within this are waited out immediately, before trying other providers. */
const shortRateWaitMs = () => Number(process.env.BATON_SHORT_RATE_WAIT_MS ?? 8_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google AI Studio",
  groq: "Groq",
  nvidia: "NVIDIA NIM",
  openrouter: "OpenRouter",
  openai: "OpenAI",
};

const ROLE_BY_TYPE: Record<BatonWorkspace["taskType"], string> = {
  code: "a senior software engineer. Write complete, runnable source code",
  document: "a meticulous technical writer. Write complete, well-structured Markdown prose",
  analysis: "a rigorous data analyst. Write complete, reproducible analysis artifacts",
};

export function buildTaskPrompt(ws: BatonWorkspace, task: BatonTask): { messages: ChatMessage[]; sections: TaskPromptSections } {
  const decisions = Object.entries(ws.metadata)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const planned = new Set(ws.tasks.map((t) => t.targetArtifact));
  const untouched = Object.keys(ws.artifacts).filter((p) => !planned.has(p));
  const manifest = [
    ...ws.tasks.map((t) => `- [${t.status === "completed" ? "x" : t.id === task.id ? ">" : " "}] ${t.targetArtifact} — ${t.title}`),
    ...untouched.map((p) => `- [=] ${p} — existing file, unchanged`),
  ].join("\n");

  // Every file in the shared workspace except the one being written, labelled with who wrote it.
  const shared = sharedFiles(ws, task)
    .map((p) => {
      const by = originLabel(ws, p);
      return `=== ${p} ===${by ? ` (written by ${by})` : ""}\n${ws.artifacts[p]}`;
    })
    .join("\n");
  const current = ws.artifacts[task.targetArtifact];
  const isFollowUp = Boolean(ws.conversation?.length);

  // Each section is tagged with its purpose so token use can be broken down later.
  const parts: Array<[keyof TaskPromptSections, string | false]> = [
    [
      "request",
      isFollowUp
        ? `## Earlier requests (oldest first)\n${ws.conversation!.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n## Current request\n${ws.userPrompt}`
        : `## Project goal\n${ws.userPrompt}`,
    ],
    ["context", Boolean(decisions) && `## Architectural decisions (binding)\n${decisions}`],
    ["context", `## Artifact manifest ([x] done, [>] current, [=] existing)\n${manifest}`],
    ["context", Boolean(shared) && `## Project files so far (stay consistent with these)\n${shared}`],
    [
      "context",
      current !== undefined &&
        `## Current contents of \`${task.targetArtifact}\` (rewrite the WHOLE file, applying the change)\n${current}`,
    ],
    ["instructions", `## Your assignment\nProduce the full contents of \`${task.targetArtifact}\`: ${task.title}`],
  ];
  const system =
    `You are ${ROLE_BY_TYPE[ws.taskType]}. You are one stage in a relay: earlier artifacts were written by other ` +
    "models and are authoritative. Output ONLY the complete contents of the requested artifact inside a single " +
    "fenced code block. No explanations before or after it, no placeholders, no ellipses.";
  const used = parts.filter((p): p is [keyof TaskPromptSections, string] => Boolean(p[1]));
  const sections: TaskPromptSections = { instructions: system.length, request: 0, context: 0 };
  for (const [kind, text] of used) sections[kind] += text.length;
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: used.map((p) => p[1]).join("\n\n") },
    ],
    sections,
  };
}

/** Characters of each kind of text in a build prompt (for the token breakdown). */
export interface TaskPromptSections {
  instructions: number;
  request: number;
  context: number;
}

export function buildTaskMessages(ws: BatonWorkspace, task: BatonTask): ChatMessage[] {
  return buildTaskPrompt(ws, task).messages;
}

/** Paths whose full text goes into a task's prompt: everything in the workspace except the target. */
function sharedFiles(ws: BatonWorkspace, task: BatonTask): string[] {
  return Object.keys(ws.artifacts).filter((p) => p !== task.targetArtifact);
}

export interface RelayOptions {
  /** Ordered waterfall: index 0 is the sprint tier, later entries are fallbacks. */
  targets: ProviderTarget[];
  /** Shared across one orchestration so a rate-limited tier isn't hammered on every task. */
  cooldowns?: Map<string, number>;
  now?: () => number;
}

/** Runs every pending task. Returns true when all tasks completed. */
export async function runRelay(ws: BatonWorkspace, opts: RelayOptions): Promise<boolean> {
  const cooldowns = opts.cooldowns ?? new Map<string, number>();
  const now = opts.now ?? Date.now;
  const keyOf = (t: ProviderTarget) => `${t.provider}:${t.model}`;
  const busyLogged = new Set<string>(); // log each busy-skip once per run, not once per task

  for (const task of ws.tasks) {
    if (task.status === "completed") continue;
    task.status = "in_progress";
    const { messages, sections } = buildTaskPrompt(ws, task);
    recordContext(
      ws,
      {
        step: task.id,
        kind: "task",
        target: task.targetArtifact,
        targetExisted: ws.artifacts[task.targetArtifact] !== undefined,
        manifest: [...new Set([...ws.tasks.map((t) => t.targetArtifact), ...Object.keys(ws.artifacts)])],
        files: sharedFiles(ws, task).map((p) => contextFile(ws, p)),
      },
      messages,
    );

    // Respect cooldowns, but never leave a task with zero candidates: if every
    // tier is cooling down, try them all anyway in waterfall order.
    const ready = opts.targets.filter((t) => (cooldowns.get(keyOf(t)) ?? 0) <= now());
    // Also skip providers that were busy (503) moments ago, in this run or an earlier one.
    const { ready: notBusy, skipped } = splitBusy(ready.length > 0 ? ready : opts.targets);
    const newlySkipped = skipped.filter((s) => !busyLogged.has(keyOf(s.target)));
    newlySkipped.forEach((s) => busyLogged.add(keyOf(s.target)));
    logBusySkips(ws, task.id, newlySkipped);
    const candidates = notBusy;

    /** One attempt on one provider. Returns the error on failure, undefined on success. */
    const attempt = async (target: ProviderTarget, isLast: boolean, nextLabel: string | undefined, mayWaitShort = false) => {
      try {
        const result = await chatCompletion(target, messages, {
          retryOverloaded: isLast, // last resort: a short wait beats failing the task
          ...traceFor(ws, task.id),
        });
        logModelSwaps(ws, task.id, target.provider, result.skippedModels);
        ws.artifacts[task.targetArtifact] = extractArtifactBody(result.content, task.targetArtifact);
        attachBreakdown(ws, task.id, result.model, buildCallBreakdown(result.usage, sections, ws.artifacts[task.targetArtifact].length, result.content.length));
        task.status = "completed";
        task.assignedProvider = target.provider;
        task.assignedModel = result.model;
        (ws.artifactOrigins ??= {})[task.targetArtifact] = {
          provider: target.provider,
          model: result.model,
          runId: ws.workspaceId,
          step: task.id,
        };
        log(ws, task.id, "execute", { ...target, model: result.model }, `Generated ${task.targetArtifact} successfully`, result.usage);
        return undefined;
      } catch (err) {
        const pe =
          err instanceof ProviderError ? err : new ProviderError((err as Error).message ?? String(err), "network");
        logModelSwaps(ws, task.id, target.provider, pe.skippedModels);
        if (pe.kind === "rate_limit" || pe.kind === "server" || pe.kind === "overloaded") {
          cooldowns.set(keyOf(target), now() + (pe.retryAfterMs ?? DEFAULT_COOLDOWN_MS));
        } else if (pe.kind === "billing" || pe.kind === "auth" || pe.kind === "model_unavailable") {
          // Won't fix itself mid-run: stop asking this provider for the rest of the request.
          cooldowns.set(keyOf(target), Number.POSITIVE_INFINITY);
        }
        // A rate limit that resets within seconds (e.g. Groq "try again in 2s") is cheaper to wait out
        // than a detour through slower, less reliable providers.
        const shortWait =
          mayWaitShort && pe.kind === "rate_limit" && pe.retryAfterMs !== undefined && pe.retryAfterMs <= shortRateWaitMs() && busyUntilFor(target) === undefined
            ? pe.retryAfterMs + 250
            : undefined;
        log(
          ws,
          task.id,
          "failover",
          { ...target, model: pe.model ?? pe.skippedModels.at(-1)?.model ?? target.model },
          shortWait !== undefined
            ? `${pe.reason}; waiting ${(shortWait / 1000).toFixed(1)}s for ${target.provider}'s rate limit to reset, then retrying`
            : nextLabel ? `${pe.reason}; passing baton to ${nextLabel}` : `${pe.reason}; no providers left for ${task.targetArtifact}`,
        );
        return { pe, at: now(), shortWait };
      }
    };

    const done = (): boolean => task.status === "completed"; // read fresh: attempt() mutates it
    const rateLimited: Array<{ target: ProviderTarget; readyAt: number }> = [];
    for (const [i, target] of candidates.entries()) {
      const next = candidates[i + 1];
      const nextLabel = next && (PROVIDER_NAMES[next.provider] ?? next.provider);
      let failure = await attempt(target, i === candidates.length - 1, nextLabel, true);
      if (failure?.shortWait !== undefined) {
        await sleep(failure.shortWait);
        cooldowns.delete(keyOf(target));
        failure = await attempt(target, i === candidates.length - 1, nextLabel);
      }
      if (!failure) break;
      if (failure.pe.kind === "rate_limit" && busyUntilFor(target) === undefined) {
        rateLimited.push({ target, readyAt: failure.at + (failure.pe.retryAfterMs ?? UNKNOWN_RATE_RESET_MS) });
      }
    }

    // Second chance: every provider failed, but some were only briefly rate limited
    // (e.g. Groq's per-minute token cap). Waiting a few seconds beats failing the file.
    if (!done()) {
      const maxWait = maxRateWaitMs();
      for (const { target, readyAt } of rateLimited.sort((a, b) => a.readyAt - b.readyAt)) {
        const wait = Math.max(0, readyAt - now()) + 250;
        if (wait > maxWait) continue;
        log(ws, task.id, "failover", target, `waiting ${(wait / 1000).toFixed(1)}s for ${target.provider}'s rate limit to reset, then retrying`);
        await sleep(wait);
        cooldowns.delete(keyOf(target));
        if (!(await attempt(target, true, undefined))) break;
      }
    }

    if (!done()) task.status = "failed";
  }

  return ws.tasks.every((t) => t.status === "completed");
}
