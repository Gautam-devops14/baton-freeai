// OpenRouter — one key for many hosted models, some free (IDs ending in ":free").
// Free use is capped (about 50 requests/day), so it sits after the other free
// tiers and before paid OpenAI. Baton only ever picks ":free" models here, so it
// never spends credits by accident.
import type { ProviderTarget, TaskType } from "../types.js";

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

const list = (env: string | undefined, fallback: string[]) => {
  const parsed = env?.split(",").map((m) => m.trim()).filter(Boolean);
  return parsed?.length ? parsed : fallback;
};

/**
 * Ordered preference per task type. OpenRouter's free catalogue changes often;
 * if these are gone, Baton discovers a current ":free" model from /models.
 * Override with OPENROUTER_CODE_MODELS / OPENROUTER_GENERAL_MODELS.
 */
export const OPENROUTER_MODELS = {
  // "openrouter/free" is OpenRouter's own router: it always sends the request to a
  // model that is free right now, so it survives the free catalogue changing
  // (fixed ":free" IDs like qwen3-coder:free were withdrawn).
  code: list(process.env.OPENROUTER_CODE_MODELS, ["openrouter/free"]),
  general: list(process.env.OPENROUTER_GENERAL_MODELS, ["openrouter/free"]),
};

export function openrouterTarget(apiKey: string, taskType: TaskType): ProviderTarget {
  const [model, ...fallbackModels] = taskType === "code" ? OPENROUTER_MODELS.code : OPENROUTER_MODELS.general;
  return {
    provider: "openrouter",
    model,
    fallbackModels,
    baseUrl: OPENROUTER_BASE_URL,
    apiKey,
    // JSON mode support varies by underlying model; the planner prompt + tolerant parser cover it.
    supportsJsonMode: false,
    // Discovery may only choose free models.
    modelFilter: /:free$/,
    modelHints:
      taskType === "code"
        ? ["coder", "deepseek-chat", "deepseek-v3", "llama-3.3-70b", "70b", "qwen", "instruct"]
        : ["llama-3.3-70b", "deepseek-chat", "deepseek-v3", "70b", "qwen", "instruct"],
    // Optional attribution header OpenRouter shows in its dashboard.
    extraHeaders: { "X-Title": "Baton" },
  };
}
