// OpenAI — optional, paid last-resort tier. OpenAI has no free API tier, so
// Baton only reaches it after the free providers have failed.
import type { ProviderTarget } from "../types.js";

export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

/** Ordered preference; a retired ID (404) falls through to the next one. Override with OPENAI_MODELS. */
export const DEFAULT_OPENAI_MODELS = ["gpt-5-mini", "gpt-4.1-mini"];

export const OPENAI_MODELS: string[] = (() => {
  const list = process.env.OPENAI_MODELS?.split(",").map((m) => m.trim()).filter(Boolean);
  return list?.length ? list : DEFAULT_OPENAI_MODELS;
})();

export function openaiTarget(apiKey: string): ProviderTarget {
  const [model, ...fallbackModels] = OPENAI_MODELS;
  return {
    provider: "openai",
    model,
    fallbackModels,
    baseUrl: OPENAI_BASE_URL,
    apiKey,
    // GPT-5 family (reasoning models) reject any non-default temperature.
    sendTemperature: false,
  };
}
