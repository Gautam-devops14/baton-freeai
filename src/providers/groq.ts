// Groq — the "sprint tier" (spec §3, Stage 3).
import type { ProviderTarget, TaskType } from "../types.js";

export const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";

const list = (env: string | undefined, fallback: string[]) => {
  const parsed = env?.split(",").map((m) => m.trim()).filter(Boolean);
  return parsed?.length ? parsed : fallback;
};

/**
 * Ordered preference. The spec's qwen-2.5-coder-32b has been decommissioned by
 * Groq, and real runs showed the llama models answering 404 for some accounts,
 * so gpt-oss-120b goes first with the llamas as backups. If all are gone,
 * Baton discovers a replacement from Groq's live model list.
 * Override with GROQ_CODE_MODELS / GROQ_GENERAL_MODELS.
 */
export const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

export const GROQ_MODELS = {
  code: list(process.env.GROQ_CODE_MODELS ?? process.env.GROQ_CODE_MODEL, DEFAULT_GROQ_MODELS),
  general: list(process.env.GROQ_GENERAL_MODELS ?? process.env.GROQ_GENERAL_MODEL, DEFAULT_GROQ_MODELS),
};

export function groqModelFor(taskType: TaskType): string {
  return (taskType === "code" ? GROQ_MODELS.code : GROQ_MODELS.general)[0];
}

export function groqTarget(apiKey: string, taskType: TaskType): ProviderTarget {
  const [model, ...fallbackModels] = taskType === "code" ? GROQ_MODELS.code : GROQ_MODELS.general;
  return {
    provider: "groq",
    model,
    fallbackModels,
    baseUrl: GROQ_BASE_URL,
    apiKey,
    modelHints:
      taskType === "code"
        ? ["coder", "gpt-oss-120b", "llama-3.3-70b", "kimi", "llama-4", "70b", "qwen", "gpt-oss", "instruct"]
        : ["llama-3.3-70b", "gpt-oss-120b", "kimi", "llama-4", "70b", "qwen", "gpt-oss", "instruct"],
  };
}
