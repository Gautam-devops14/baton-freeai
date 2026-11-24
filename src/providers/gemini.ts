// Google AI Studio (Gemini) via its OpenAI-compatible surface.
// Serves as Task Architect (planner) and as the relay fallback tier.
import type { ProviderTarget } from "../types.js";

export const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai";

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export function geminiTarget(apiKey: string): ProviderTarget {
  return { provider: "google", model: GEMINI_MODEL, baseUrl: GEMINI_BASE_URL, apiKey };
}
