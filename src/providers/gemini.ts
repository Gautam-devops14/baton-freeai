// Google AI Studio (Gemini) via its OpenAI-compatible surface.
// Serves as Task Architect (planner) and as the relay fallback tier.
import type { ProviderTarget } from "../types.js";

export const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Ordered model preference. Google retires model IDs for new users without
 * notice, so the client walks this list on 404 / "no longer available" before
 * Baton fails over to another provider. Override with a comma-separated
 * GEMINI_MODELS (GEMINI_MODEL alone replaces just the first entry).
 */
export const DEFAULT_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];

export const GEMINI_MODELS: string[] = (() => {
  const list = process.env.GEMINI_MODELS?.split(",").map((m) => m.trim()).filter(Boolean);
  if (list?.length) return list;
  const [first, ...rest] = DEFAULT_GEMINI_MODELS;
  return [process.env.GEMINI_MODEL?.trim() || first, ...rest];
})();

export const GEMINI_MODEL = GEMINI_MODELS[0];

export function geminiTarget(apiKey: string): ProviderTarget {
  const [model, ...fallbackModels] = GEMINI_MODELS;
  return { provider: "google", model, fallbackModels, baseUrl: GEMINI_BASE_URL, apiKey };
}
