// Live progress hub. The browser picks a random clientRunId, subscribes to
// GET /api/progress/:id (Server-Sent Events), then POSTs the run with that id.
// Events are buffered, so a subscriber that connects late still sees everything.

import type { ProgressEvent } from "../types.js";

interface Channel {
  events: ProgressEvent[];
  listeners: Set<(e: ProgressEvent) => void>;
  done: boolean;
  timer?: NodeJS.Timeout;
}

const channels = new Map<string, Channel>();
const KEEP_AFTER_DONE_MS = 60_000;
const MAX_BUFFER = 500;

export const CLIENT_RUN_ID_RE = /^[a-f0-9]{8,64}$/;

function channel(id: string): Channel {
  let c = channels.get(id);
  if (!c) {
    c = { events: [], listeners: new Set(), done: false };
    channels.set(id, c);
    // Drop channels nobody ever used (e.g. the POST never arrived).
    c.timer = setTimeout(() => channels.delete(id), 15 * 60_000);
    c.timer.unref?.();
  }
  return c;
}

/** A function that publishes events for one run. */
export function progressEmitter(id: string): (e: ProgressEvent) => void {
  return (e) => {
    const c = channel(id);
    if (c.events.length < MAX_BUFFER) c.events.push(e);
    for (const l of c.listeners) l(e);
    if (e.type === "done") {
      c.done = true;
      clearTimeout(c.timer);
      c.timer = setTimeout(() => channels.delete(id), KEEP_AFTER_DONE_MS);
      c.timer.unref?.();
    }
  };
}

/** Replay buffered events, then stream new ones. Returns an unsubscribe function. */
export function subscribeProgress(id: string, fn: (e: ProgressEvent) => void): () => void {
  const c = channel(id);
  for (const e of c.events) fn(e);
  if (c.done) return () => {};
  c.listeners.add(fn);
  return () => c.listeners.delete(fn);
}
