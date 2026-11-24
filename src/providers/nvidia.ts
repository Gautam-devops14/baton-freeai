// NVIDIA NIM (build.nvidia.com) — OpenAI-compatible hosted models with a free
// developer tier. Sits after Groq and Gemini, before paid OpenAI.
import type { ProviderTarget, TaskType } from "../types.js";

export const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";

const list = (env: string | undefined, fallback: string[]) => {
  const parsed = env?.split(",").map((m) => m.trim()).filter(Boolean);
  return parsed?.length ? parsed : fallback;
};

/**
 * Ordered preference per task type. NVIDIA rotates its catalogue (older Qwen
 * 2.5 / Llama 3.3 IDs now answer 410 Gone), so a retired ID falls through to
 * the next entry and, failing that, to a model discovered from NVIDIA's live
 * list. Override with NVIDIA_CODE_MODELS / NVIDIA_GENERAL_MODELS.
 */
export const NVIDIA_MODELS = {
  code: list(process.env.NVIDIA_CODE_MODELS, ["qwen/qwen3-coder-480b-a35b-instruct", "openai/gpt-oss-120b"]),
  general: list(process.env.NVIDIA_GENERAL_MODELS, ["openai/gpt-oss-120b", "meta/llama-4-maverick-17b-128e-instruct"]),
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
    modelHints:
      taskType === "code"
        ? ["coder", "gpt-oss-120b", "deepseek-v3", "llama-4-maverick", "llama-3.3-70b", "70b", "instruct"]
        : ["gpt-oss-120b", "llama-4-maverick", "deepseek-v3", "llama-3.3-70b", "70b", "instruct"],
  };
}
