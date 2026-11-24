// Groq — the "sprint tier" (spec §3, Stage 3).
import type { ProviderTarget, TaskType } from "../types.js";

export const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";

const list = (env: string | undefined, fallback: string[]) => {
  const parsed = env?.split(",").map((m) => m.trim()).filter(Boolean);
  return parsed?.length ? parsed : fallback;
};

/**
 * Ordered preference per task type. The spec's qwen-2.5-coder-32b has been
 * decommissioned by Groq, so defaults use current general models; if these are
 * retired too, Baton discovers a replacement from Groq's live model list.
 * Override with GROQ_CODE_MODELS / GROQ_GENERAL_MODELS (comma-separated).
 */
export const GROQ_MODELS = {
  code: list(process.env.GROQ_CODE_MODELS ?? process.env.GROQ_CODE_MODEL, ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"]),
  general: list(process.env.GROQ_GENERAL_MODELS ?? process.env.GROQ_GENERAL_MODEL, ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]),
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
        ? ["coder", "gpt-oss-120b", "llama-3.3-70b", "kimi", "70b", "qwen", "gpt-oss"]
        : ["llama-3.3-70b", "gpt-oss-120b", "kimi", "70b", "qwen", "gpt-oss"],
  };
}
