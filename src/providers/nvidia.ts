// NVIDIA NIM (build.nvidia.com) — OpenAI-compatible hosted models with a free
// developer tier. Sits after Groq and Gemini, before paid OpenAI.
import type { ProviderTarget, TaskType } from "../types.js";

export const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";

const list = (env: string | undefined, fallback: string[]) => {
  const parsed = env?.split(",").map((m) => m.trim()).filter(Boolean);
  return parsed?.length ? parsed : fallback;
};

/**
 * Ordered preference per task type. NVIDIA rotates its catalogue, so a retired
 * ID (404) falls through to the next entry. Override with NVIDIA_CODE_MODELS /
 * NVIDIA_GENERAL_MODELS (comma-separated).
 */
export const NVIDIA_MODELS = {
  code: list(process.env.NVIDIA_CODE_MODELS, ["qwen/qwen2.5-coder-32b-instruct", "meta/llama-3.3-70b-instruct"]),
  general: list(process.env.NVIDIA_GENERAL_MODELS, ["meta/llama-3.3-70b-instruct", "meta/llama-3.1-70b-instruct"]),
};

export function nvidiaTarget(apiKey: string, taskType: TaskType): ProviderTarget {
  const [model, ...fallbackModels] = taskType === "code" ? NVIDIA_MODELS.code : NVIDIA_MODELS.general;
  return {
    provider: "nvidia",
    model,
    fallbackModels,
    baseUrl: NVIDIA_BASE_URL,
    apiKey,
    // Not every NIM model accepts response_format; the planner prompt already demands JSON
    // and the plan parser tolerates prose around it.
    supportsJsonMode: false,
  };
}
