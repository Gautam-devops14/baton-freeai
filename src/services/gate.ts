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
    'Send {"userPrompt": "...", "taskType": "code" | "document" | "analysis", "keys": {"groqApiKey": "...", "geminiApiKey": "...", "nvidiaApiKey": "...", "openrouterApiKey": "...", "openaiApiKey": "..."}} ' +
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

// A greeting in front of a real request ("Hi Baton, can you build...", "Hey, write a...").
// The greeting is dropped before planning so no tokens are spent on it.
const GREETING_PREFIX_RE =
  /^\s*(?:(?:hi|hello|hey|hiya|heya|yo|greetings|howdy|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|baton|team|buddy|friend|all))*\s*[,!.:;–—-]*\s+)+/i;

/**
 * Remove a leading greeting from a prompt that also contains a request. Returns
 * the prompt unchanged when there is no greeting, when nothing would be left, or
 * for phrases like "hello world app" where the greeting word is part of the request.
 */
export function stripGreeting(prompt: string): string {
  const m = GREETING_PREFIX_RE.exec(prompt);
  if (!m) return prompt;
  const rest = prompt.slice(m[0].length).trim();
  if (!rest) return prompt;
  if (/^hello\b/i.test(prompt.trim()) && /^world\b/i.test(rest) && !/^hello\s*[,!.]/i.test(prompt.trim())) return prompt;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
