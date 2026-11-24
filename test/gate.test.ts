import { test } from "node:test";
import assert from "node:assert/strict";
import { gate } from "../src/services/gate.js";

test("gates every chit-chat phrase from the spec", () => {
  for (const p of ["hi", "Hello!", "hey there", "greetings", "bye", "Goodbye.", "thanks", "Thank you!!", "ok", "okay", "ok thanks"]) {
    assert.equal(gate(p)?.kind, "chit_chat", p);
  }
});

test("gates every system command from the spec", () => {
  for (const p of ["cancel", "STOP", "clear", "status", "reset", "/help", " help? "]) {
    assert.equal(gate(p)?.kind, "command", p);
  }
});

test("passes actionable prompts through", () => {
  for (const p of [
    "hi, build me an Express auth service",
    "help me write a README",
    "status page in React",
    "thanks! now add tests",
    "Create an Express.js authentication service with JWT and bcrypt",
  ]) {
    assert.equal(gate(p), null, p);
  }
});
