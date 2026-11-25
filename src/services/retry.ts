// Full-jitter exponential backoff for the global cool-down loop.
// delay = floor(random * min(maxDelay, baseDelay * 2^attempt)), so many users who all hit
// the free-tier limits at once don't retry in lock-step (no "thundering herd").

import { sleepUnlessCancelled } from "../providers/client.js";

const envNum = (name: string, dflt: number) => {
  const v = process.env[name];
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const backoffBaseMs = () => envNum("BATON_BACKOFF_BASE_MS", 15_000);
export const backoffMaxMs = () => envNum("BATON_BACKOFF_MAX_MS", 60_000);
/** How many cool-down rounds before giving up (0 = none). */
export const backoffRounds = () => Math.floor(envNum("BATON_BACKOFF_ROUNDS", 3));

export function fullJitterDelay(attempt: number, baseDelay = backoffBaseMs(), maxDelay = backoffMaxMs(), random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(maxDelay, baseDelay * Math.pow(2, attempt)));
}

/** Sleep `ms`, calling `onTick(secondsLeft)` once a second so the UI can show a live countdown. Stop cancels it. */
export async function countdownSleep(ms: number, signal: AbortSignal | undefined, onTick: (secondsLeft: number) => void): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) break;
    onTick(Math.ceil(left / 1000));
    await sleepUnlessCancelled(Math.min(1000, left), signal);
  }
  onTick(0);
}
