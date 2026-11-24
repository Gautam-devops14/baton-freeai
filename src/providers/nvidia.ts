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
  // qwen3-coder-480b (EOL 2026-06-11) and gpt-oss-120b (EOL 2026-09-03) are retired on NVIDIA.
  code: list(process.env.NVIDIA_CODE_MODELS, ["moonshotai/kimi-k2-instruct", "deepseek-ai/deepseek-v3.1"]),
  general: list(process.env.NVIDIA_GENERAL_MODELS, ["deepseek-ai/deepseek-v3.1", "moonshotai/kimi-k2-instruct"]),
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
    // Discovery only considers chat/instruct models: NVIDIA also lists code-completion
    // models (e.g. starcoder2) that its chat endpoint answers with 404.
    modelFilter: /instruct|chat|kimi|deepseek|qwen3|gpt-oss|nemotron|mistral|mixtral|llama-4/i,
    modelHints:
      taskType === "code"
        ? [/qwen3?-coder.*instruct/, /deepseek-v3/, /kimi/, /gpt-oss/, /llama-4/, /nemotron.*(super|ultra)/, /70b.*instruct/, /instruct/]
        : [/deepseek-v3/, /kimi/, /gpt-oss/, /llama-4/, /nemotron.*(super|ultra)/, /70b.*instruct/, /instruct/],
  };
}
