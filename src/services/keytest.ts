// "Test keys": check each API key with a free request (no tokens spent) and
// report which of Baton's configured models that account can actually use.

import type { OrchestrateRequest, ProviderTarget } from "../types.js";
import { buildTargets } from "./orchestrator.js";

export interface KeyTestResult {
  provider: string;
  ok: boolean;
  status?: number;
  message: string;
  /** Configured models (in order) the account's model list includes / doesn't include. */
  configuredAvailable?: string[];
  missing?: string[];
  modelCount?: number;
  /** OpenRouter only: key label and credit/limit info. */
  account?: Record<string, unknown>;
}

async function get(url: string, apiKey: string, timeoutMs = 10_000): Promise<{ status: number; body: any; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

const errMessage = (r: { body: any; text: string }) => {
  const o = Array.isArray(r.body) ? r.body[0] : r.body;
  return String(o?.error?.message ?? o?.detail ?? o?.message ?? r.text ?? "").slice(0, 200);
};

function availability(t: ProviderTarget, ids: string[]) {
  const have = new Set(ids.map((id) => id.replace(/^models\//, "")));
  const configured = [t.model, ...(t.fallbackModels ?? [])];
  return { configuredAvailable: configured.filter((m) => have.has(m)), missing: configured.filter((m) => !have.has(m)), modelCount: have.size };
}

async function testOne(t: ProviderTarget): Promise<KeyTestResult> {
  const base = t.baseUrl.replace(/\/+$/, "");
  try {
    if (t.provider === "openrouter") {
      // /models is public on OpenRouter, so /key is the real authentication check.
      const k = await get(`${base}/key`, t.apiKey);
      if (k.status !== 200) return { provider: t.provider, ok: false, status: k.status, message: `HTTP ${k.status}: ${errMessage(k)}` };
      const d = k.body?.data ?? {};
      let extra = {};
      try {
        const m = await get(`${base}/models`, t.apiKey);
        if (m.status === 200) extra = availability(t, (m.body?.data ?? []).map((x: any) => x.id));
      } catch {
        // availability is best-effort
      }
      return {
        provider: t.provider,
        ok: true,
        status: 200,
        message: "Key accepted",
        account: { label: d.label, freeTier: d.is_free_tier, usage: d.usage, limit: d.limit, rateLimit: d.rate_limit },
        ...extra,
      };
    }
    const r = await get(`${base}/models`, t.apiKey);
    if (r.status !== 200) return { provider: t.provider, ok: false, status: r.status, message: `HTTP ${r.status}: ${errMessage(r)}` };
    const ids = ((r.body?.data ?? r.body?.models ?? []) as any[]).map((x) => x.id ?? x.name).filter((x) => typeof x === "string");
    const a = availability(t, ids);
    return {
      provider: t.provider,
      ok: true,
      status: 200,
      message: a.configuredAvailable.length
        ? `Key accepted · ${a.configuredAvailable.length} of ${a.configuredAvailable.length + a.missing.length} configured models available`
        : "Key accepted, but none of the configured models are listed (Baton will discover replacements)",
      ...a,
    };
  } catch (e) {
    const err = e as Error;
    return { provider: t.provider, ok: false, message: err.name === "AbortError" ? "Timed out" : `Network error: ${err.message}` };
  }
}

export async function testKeys(keys: OrchestrateRequest["keys"]): Promise<KeyTestResult[]> {
  const trimmed = Object.fromEntries(Object.entries(keys ?? {}).map(([k, v]) => [k, typeof v === "string" ? v.trim() || undefined : undefined]));
  const targets = buildTargets(trimmed, "code").relay;
  return Promise.all(targets.map(testOne));
}
