// Model discovery: providers retire model IDs without notice (Gemini 2.5,
// Groq's qwen-2.5-coder, NVIDIA's llama-3.3 all went away). When every
// configured model is gone, ask the provider which chat models it serves now
// (`GET <baseUrl>/models`, part of the OpenAI-compatible API and free) and pick
// the best match for the task.

import type { ProviderTarget } from "../types.js";

/** Model families that are not general chat/code models. */
const NOT_CHAT =
  /embed|whisper|tts|audio|speech|asr|transcri|guard|safety|moderation|rerank|retriev|reward|vision|-vl\b|vlm|image|imagen|veo|dall-e|clip|ocr|parse|deplot|kosmos|neva|fuyu|paligemma|cosmos|robot|search|realtime|translat|live|aqa|computer-use|babbage|davinci|gpt-3\.5-turbo-instruct|tokenizer|pii|detector|nemoretriever|bge|e5-|nv-embed|arctic-embed|playai|orpheus|distil-whisper|sdxl|flux|stable-diffusion|starcoder|santacoder|codegemma|-base\b|\bbase\b|fim\b|completion/i;

export type ModelHint = string | RegExp;

const matches = (id: string, h: ModelHint) => (typeof h === "string" ? id.toLowerCase().includes(h.toLowerCase()) : h.test(id));

/**
 * Order candidate model IDs: drop non-chat models and ones already known to be
 * unavailable; rank by the first hint each matches (earlier hint = better),
 * then newest-looking ID first (gemini-3.8 before gemini-3.5). Models matching
 * no hint are never picked.
 */
export function rankModels(ids: string[], hints: ModelHint[], exclude: Set<string>, limit = 3): string[] {
  const clean = [...new Set(ids.map((id) => id.replace(/^models\//, "")))].filter(
    (id) => id && !NOT_CHAT.test(id) && !exclude.has(id),
  );
  const scored = clean.map((id) => {
    const i = hints.findIndex((h) => matches(id, h));
    return { id, score: i === -1 ? hints.length : i };
  });
  scored.sort((a, b) => a.score - b.score || b.id.localeCompare(a.id, undefined, { numeric: true }));
  // Only models that match a preference: an unknown model (e.g. "recursive/flint-v1.0")
  // is more likely to hang or misbehave than to help.
  return scored.filter((s) => s.score < hints.length).slice(0, limit).map((s) => s.id);
}

/** List model IDs from `<baseUrl>/models`. Returns [] on any failure: discovery is best-effort. */
export async function listModels(target: ProviderTarget, timeoutMs = 10_000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown; id?: unknown }> };
    const rows = body.data ?? body.models ?? [];
    return rows.map((m) => (m as { id?: unknown }).id ?? (m as { name?: unknown }).name).filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
