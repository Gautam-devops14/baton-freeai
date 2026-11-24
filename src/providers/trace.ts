// Provider call tracing: one entry per HTTP call to a model provider, for the
// debug panel. Never contains API keys or prompt text.

import type { CallTrace } from "../types.js";

const MAX_RECENT = 200;
const recent: CallTrace[] = [];

/** Keep finished calls in a ring buffer (newest last) for GET /api/debug. */
export function rememberCall(t: CallTrace): void {
  if (t.phase !== "end") return;
  recent.push(t);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

export function recentCalls(limit = 100): CallTrace[] {
  return recent.slice(-limit).reverse();
}

export function clearRecentCalls(): void {
  recent.length = 0;
}
