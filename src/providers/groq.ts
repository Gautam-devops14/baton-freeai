// Groq — the "sprint tier" (spec §3, Stage 3).
import type { ProviderTarget, TaskType } from "../types.js";

export const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";

export const GROQ_MODELS = {
  code: process.env.GROQ_CODE_MODEL ?? "qwen-2.5-coder-32b",
  general: process.env.GROQ_GENERAL_MODEL ?? "llama-3.3-70b-versatile",
};

export function groqModelFor(taskType: TaskType): string {
  return taskType === "code" ? GROQ_MODELS.code : GROQ_MODELS.general;
}

export function groqTarget(apiKey: string, taskType: TaskType): ProviderTarget {
  return { provider: "groq", model: groqModelFor(taskType), baseUrl: GROQ_BASE_URL, apiKey };
}
