// Stage 1: deterministic zero-token gating (spec §3).
// Pure string/regex matching — no network, no state, no tokens.

import type { GatedResponse } from "../types.js";

const CHIT_CHAT_WORDS = ["hi", "hello", "hey", "greetings", "bye", "goodbye", "thanks", "thank you", "ok", "okay"];
const COMMAND_WORDS = ["cancel", "stop", "clear", "status", "reset", "help"];

// One or more chit-chat tokens, optionally addressed to "baton"/"there", e.g. "ok thanks", "hi there".
const CHIT_CHAT_RE = new RegExp(
  `^(?:(?:${CHIT_CHAT_WORDS.join("|")})(?:\\s+(?:there|baton))?\\s*)+$`,
);
// Exactly one command, optionally slash-prefixed: "status", "/help".
const COMMAND_RE = new RegExp(`^/?(${COMMAND_WORDS.join("|")})$`);

const CANNED_CHIT_CHAT: Record<"greeting" | "closing" | "ack", string> = {
  greeting: "Hi! Describe a project (code, a document, or an analysis) and Baton will plan and build it.",
  closing: "Anytime. Your generated artifacts stay downloadable until the workspace expires.",
  ack: "Got it. Send a project description whenever you're ready.",
};

const CANNED_COMMANDS: Record<string, string> = {
  cancel: "Nothing to cancel: each orchestration request runs to completion in a single call.",
  stop: "Nothing to stop: each orchestration request runs to completion in a single call.",
  clear: "Baton is stateless between requests; there is no conversation history to clear.",
  reset: "Baton is stateless between requests; there is nothing to reset.",
  status: "Baton is online. POST a project description to /api/orchestrate to begin.",
  help:
    'Send {"userPrompt": "...", "taskType": "code" | "document" | "analysis", "keys": {"groqApiKey": "...", "geminiApiKey": "..."}} ' +
    "to POST /api/orchestrate. Baton plans 2-4 artifacts, builds them across providers with automatic failover, " +
    "and returns a downloadUrl for a .zip of the results.",
};

/** Lowercase, collapse whitespace, and drop surrounding/trailing punctuation & emoji. */
export function normalize(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function gate(prompt: string): GatedResponse | null {
  const text = normalize(prompt);
  if (!text) return null;

  const cmd = COMMAND_RE.exec(text);
  if (cmd) {
    return { status: "gated", kind: "command", match: cmd[1], response: CANNED_COMMANDS[cmd[1]] };
  }

  if (CHIT_CHAT_RE.test(text)) {
    const tone = /\b(bye|goodbye)\b/.test(text)
      ? "closing"
      : /^(hi|hello|hey|greetings)\b/.test(text)
        ? "greeting"
        : "ack";
    return { status: "gated", kind: "chit_chat", match: text, response: CANNED_CHIT_CHAT[tone] };
  }

  return null;
}
