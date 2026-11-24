# Baton

A stateful relay orchestrator for free-tier LLM endpoints. Baton plans a project with Gemini 3.8 Flash, builds each artifact on Groq, and when Groq returns a 429 or times out it hands the work to Gemini. Supported providers: NVIDIA NIM, Groq, Gemini, OpenRouter (free `:free` models) and OpenAI (paid). Add any combination of keys; more keys mean more fallbacks. The task keeps going without restarting, because all context lives in a shared workspace rather than in any one model's chat history.

## Quick start

```bash
npm install
npm run dev          # open http://localhost:3000 for the web UI
npm test             # 22 tests, providers stubbed: no keys needed
npm run build && npm start
```

## Web UI

Open http://localhost:3000. It works like a typical AI chat app:

* **Sidebar:** **+ New chat**, your chats (a project plus its follow-ups), token usage, **Settings & API keys**, and the **Debug panel** toggle.
* **Thread:** your messages, and Baton's replies with status, files (click to view), **Download .zip**, tokens, and which providers did the work.
* **Provider order:** the **Order** button next to Send shows which AI Baton calls first (e.g. `Order: Groq → Gemini`). Click it to reorder providers (drag, or ↑/↓) and untick any you want skipped. The order is saved in your browser, sent with every message (`providerOrder`), used for both planning and building, and shown per run in the debug panel. Providers you switch off are never called.
* **Composer:** Enter sends, Shift+Enter adds a new line. In an open chat your message **continues that project** (a follow-up); **+ New chat** starts a fresh one.
* **Live progress:** while a run is going you see each step as it happens: planning, each provider call (✓ / ✗ with the reason, time and tokens), failovers and files written.
* **Debug panel:**
  * **This run:** overview, live event stream, every provider HTTP call (status, latency, tokens), tokens by model, the relay log, how context was shared (including the exact prompts) and the raw saved record.
  * **Server:** provider order, model lists, timeouts, what Baton remembers (retired models, discovered replacements, busy providers, with a **Forget all** button) and recent provider calls across all runs.

Keys are only stored in your browser if you tick "Remember keys".

API for the debug features: `GET /api/progress/:clientRunId` (Server-Sent Events; send the same `clientRunId` with the orchestrate request), `GET /api/debug`, `DELETE /api/debug/memory`. Runs also carry `chatId` and `calls`.

## Export (for review or sharing)

* **Export chat** (top bar, in an open chat) downloads a zip with:
  * `transcript.md`: a readable story of the chat. For each message: your prompt; the plan (decisions, files, which model planned it); then for every step, what the model was given, every attempt with its result (who failed and why, who succeeded, time, tokens), the **exact prompt sent** and the model's **raw reply**; the files changed or added; the relay log.
  * `chat.json`: the complete run records.
  * `project/`: the latest version of the files.
* **Export all chats** (sidebar) does the same for every chat, plus `index.md`, `usage.json` (tokens per model) and `server.json` (provider order, models, settings, what Baton remembers, recent calls).

Raw replies are stored for successful calls (up to `BATON_TRACE_REPLY_CHARS`, default 60,000 characters per call). They're stored with the run but not streamed live or listed in `/api/debug`. API keys are never stored, so they can't appear in an export. API: `GET /api/export/chat/:chatId`, `GET /api/export/all`.

## Follow-ups

Click **Continue this project** on any run with files, then type what to change (e.g. "add a delete button and a logo"). Baton:

* gives the planner your earlier requests and the current files, and plans only the files that must change or be added
* gives each build step the current version of the file it rewrites, plus every other project file
* returns the **whole project**: unchanged files are carried over, and the result lists what was changed and what was added
* stays in follow-up mode (even after a refresh), so the next prompt continues from the newest version. Use **Start a new project instead** to leave.

## OpenRouter

One key (from openrouter.ai/keys) gives access to many models. Baton uses **`openrouter/free`**, OpenRouter's own router, which always sends the request to a model that is free right now. That matters because individual `:free` models get withdrawn (they then answer 404 "use the paid slug instead"; Baton never follows that). If the router fails, discovery only considers `:free` models, so Baton never spends credits. Free use is capped at about 50 requests a day: when OpenRouter reports that daily cap, Baton skips it for an hour (`BATON_DAILY_LIMIT_SKIP_MS`) instead of retrying every run. Models: `OPENROUTER_CODE_MODELS` / `OPENROUTER_GENERAL_MODELS`.

## Text files only

Language models can only write text, so binary files are never planned. Images such as `logo.png` become `logo.svg`, which the model draws properly. Other binary files (PDF, fonts, zip…) are dropped from the plan.

## How context is shared

Each run shows a **How context was shared** panel. For every step it lists:

* who it was sent to, in order (e.g. `nvidia ✗ 429 → groq ✓`); a fallback provider gets exactly the same context
* what it received: the goal, earlier requests, decisions, the file list, and each file included in full, with who wrote it (`from Step 1, groq/openai/gpt-oss-120b` or `from earlier run`)
* the prompt size and the **exact prompt** sent

This is the core of Baton: context lives in the shared workspace, not in any model's chat memory.

## Test keys

**Settings → Test keys** checks each key with a free request (the provider's model list, or OpenRouter's key-info endpoint), so it spends no tokens. For each provider you get whether the key was accepted (or the exact error) and which of Baton's configured models that account can actually use. API: `POST /api/keys/test` with `{"keys": {...}}`.

## Streaming and timeouts

Every provider call streams its reply (`stream: true`, with `stream_options.include_usage` where supported, so token counts come from the final chunk). That lets timeouts tell "slow but working" apart from "stuck":

* no first chunk within `BATON_PROVIDER_TIMEOUT_MS` (30s), or `BATON_DISCOVERED_TIMEOUT_MS` (15s) for models found by discovery → timeout
* a gap longer than `BATON_STREAM_IDLE_TIMEOUT_MS` (20s) in the middle of a reply → timeout
* longer than `BATON_MAX_CALL_MS` (180s) overall → timeout

A model that is still writing a long file is never cut off at 30s. While a reply streams, the chat shows "… is writing… N chars received". Errors sent in the middle of a stream are classified like HTTP errors. Servers that reject `stream_options` are retried once without it, and servers that answer with plain JSON still work.

## Waiting out short rate limits

* If a provider's rate limit resets within `BATON_SHORT_RATE_WAIT_MS` (8s), e.g. Groq's "Please try again in 2s", Baton waits and retries it right away instead of detouring through slower providers.
* For longer limits:

  if every provider fails a file but one was only briefly rate limited, Baton waits for that reset and retries, up to `BATON_MAX_RATE_WAIT_MS` (20s), instead of giving up on the file. Partial runs also get a **Retry missing files** button.

## Memory between runs

While the server runs, Baton remembers per provider account (keyed by a hash of the API key, never the key itself):

* **retired models** (404/410/"decommissioned"): skipped for 24h (`BATON_DEAD_MODEL_TTL_MS`)
* **discovered replacements**: reused for 24h, so discovery doesn't repeat every run
* **skipped providers**, with the reason shown in the log (`skipped: <provider>: <why>`) and in the debug panel. None is skipped if it's the only provider left.
  * every model busy (503): 5 min (`BATON_BUSY_SKIP_MS`)
  * key rejected (401/403): 10 min (`BATON_KEY_REJECTED_SKIP_MS`); a different key isn't affected
  * no credit (e.g. OpenAI `insufficient_quota`): 1 h (`BATON_NO_CREDIT_SKIP_MS`)
  * free daily cap reached (OpenRouter): 1 h (`BATON_DAILY_LIMIT_SKIP_MS`)
  * no working models, including discovered ones: 1 h (`BATON_NO_MODELS_SKIP_MS`)
* Discovery on NVIDIA only considers chat/instruct models. NVIDIA also lists code-completion models such as `starcoder2`, which its chat endpoint answers with 404. Up to 5 candidates are tried.

## Questions get answers, not files

Before planning, the planner decides whether your message asks for **work** or is a **question**. Questions ("yes or no only", "explain this code", "what is RAG?") get a direct answer in the format and length you ask for, from one call. Nothing is built and the project's files stay as they were. In a follow-up the model can see the project's files, so it can explain them. Code requests are told to produce something that **runs**, not requirements or architecture documents (unless you ask for documents).

## Cost savers

* **Fewest files:** the planner uses 1–4 files, as few as the job needs (a simple page can be a single `index.html`).
* **Less context:** each file's plan entry lists which earlier files it `uses`. A build step gets those in full and every other file as a short **outline** (exports, functions, DOM ids, classes, CSS selectors, headings). Without a list, files go in full up to `BATON_CONTEXT_FULL_CHARS` (12k chars, newest first). Context views and exports mark outlined files.
* **Edit, don't rewrite:** in follow-ups, files of at least `BATON_EDIT_MIN_CHARS` (1,500 chars) are changed with small SEARCH/REPLACE edit blocks instead of a full rewrite, so the model only writes what changes. If a block doesn't match, Baton asks the same model for the full file once; the unusable reply counts as "wasted" in the token breakdown. `BATON_EDIT_MODE=off` turns this off.

## Every model before the next provider

Rate limits, overloads and timeouts are usually per model, so Baton tries **all of a provider's models** before moving to the next provider: first the configured list, then (once per run) models it discovers from the provider's live list. Only account-level problems skip a provider at once, because no other model would help: key rejected, no credit, a daily cap, or the host unreachable. The log shows each model tried (`HTTP 429 rate limit detected; retrying with llama-3.3-70b-versatile`). NVIDIA's defaults come from its current catalogue: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `deepseek-ai/deepseek-v4.1-flash`.

## Where the tokens went

Each run splits its tokens by purpose. It's shown in the debug panel ("This run" → *Where the tokens went*, plus *Tokens by step*), in the sidebar's token usage for today and all time, and in exports.

| Category | Meaning | How measured |
|---|---|---|
| Understanding | planning calls: reading the request, choosing files | measured |
| Instructions | Baton's rules and the assignment in each build prompt | estimated share of input |
| Your request | the goal and earlier requests | estimated share of input |
| Context | decisions, file list, files from earlier steps | estimated share of input |
| Code written | the file content that went into the project | measured share of output |
| Other reply text | explanations and fences around the file | measured share of output |
| Thinking | hidden reasoning | reported (`reasoning_tokens`), or estimated from reasoning text |
| Wasted | replies Baton couldn't use (e.g. a bad plan) | measured |

Providers only report a total for input tokens, so the input split is shared out by how much text each prompt section takes up.

## Token counter

Every provider call records the tokens it used, as reported by the provider (`usage` in the response). If a provider doesn't report usage, Baton estimates about 4 characters per token and marks it "estimated". The UI shows:

* tokens per relay-log step
* per run: total, input vs. output, and a table **per model** (calls, in, out, total)
* per history entry
* a **Token usage** panel in the sidebar, per model, for **Today** and **All time**. Free-tier limits are daily or per minute, so "Today" shows how close you are. Runs saved before per-model tracking are included, rebuilt from the tokens in their logs.

Failed calls (429, 503…) aren't counted, because providers don't bill them. Tokens spent on a reply Baton couldn't use (an unusable plan) are counted. The API returns `usage` in the orchestrate response, and each log entry carries `tokens`.

## History

Every prompt you send is saved, along with its result, relay log and generated files. That includes greetings, missing-key errors and failed runs. It's all in the **History** sidebar and survives page refreshes and server restarts. Click a run to see it again, re-download its files, reuse the prompt, or delete it.

* Stored as one JSON file per run in `data/runs/` (`BATON_DATA_DIR`, git-ignored). The oldest runs are dropped after `BATON_HISTORY_MAX` (default 500).
* **API keys are never stored.** Only the names of the providers used are recorded.
* Anyone who can open the page can see the history. Keep the server on `localhost` or a network you trust.
* API: `GET /api/history`, `GET /api/history/:id`, `DELETE /api/history/:id`, `DELETE /api/history`, and `GET /api/usage` (token totals per provider and per model, for today and all time).

## API

### `POST /api/orchestrate`

```bash
curl -s localhost:3000/api/orchestrate -H 'content-type: application/json' -d '{
  "userPrompt": "Create an Express.js authentication service with JWT and bcrypt",
  "taskType": "code",
  "keys": { "nvidiaApiKey": "nvapi-...", "groqApiKey": "gsk_...", "geminiApiKey": "AIza...", "openrouterApiKey": "sk-or-...", "openaiApiKey": "sk-..." }
}'
```

* `taskType`: `code` (default), `document`, or `analysis`.
* `keys`: at least one is required (BYOK). With only one key, Baton runs single-provider and loses failover.
  * Default order for both planning and building: **NVIDIA NIM → Groq → Gemini → OpenRouter → OpenAI**. Change it with `BATON_PROVIDER_ORDER=groq,nvidia,google,openai`, or for one stage only with `BATON_PLANNER_ORDER` / `BATON_RELAY_ORDER`.
  * `providerOrder` (optional): e.g. `["groq", "google", "openrouter"]`. Providers in this order for this request; providers not listed are not used. Overrides the env defaults.
  * `continueFrom` (optional): a history id. The run then **changes that project** instead of starting a new one (see Follow-ups).
  * Default models: see `.env.example`. Each provider has an ordered model list (`GROQ_*_MODELS`, `GEMINI_MODELS`, `NVIDIA_*_MODELS`, `OPENAI_MODELS`).
  * NVIDIA NIM uses `integrate.api.nvidia.com`, with keys from build.nvidia.com.
  * OpenAI has no free API tier, so its key needs billing. It is always tried last, so it only costs money when the free providers fail. Default models: `gpt-5-mini`, then `gpt-4.1-mini` (override with `OPENAI_MODELS`).
* Returns the spec §4.1 payload. `status` is `success`, `partial` (some tasks failed on every provider), or `failed`.
* Chit-chat and commands (`hi`, `thanks`, `help`, `status`, …) return `{"status":"gated", ...}` immediately. They need no keys and make no provider calls.
* Errors: `400 missing_keys` / schema violations, `502 planning_failed`.

### `GET /api/download/:workspaceId`

Streams a `.zip` of all artifacts. Workspaces expire after `BATON_WORKSPACE_TTL_SECONDS` (default 1h).

## How a request flows

| Stage | Module | Notes |
|---|---|---|
| 1. Gate | `services/gate.ts` | Regex only. Runs before any state allocation or network call. |
| 2. Plan | `services/planner.ts` | Gemini in JSON mode produces 2–4 tasks plus decisions. Paths are sanitised. Falls back to Groq if Gemini fails. |
| 3. Relay | `services/relay.ts` | Waterfall Groq → Gemini per task. Each prompt contains the goal, decisions, manifest and full completed artifacts. |
| 4. Bundle | `services/bundler.ts` | Streams the zip with archiver. |

Implementation choices that go beyond the spec:

* **Cooldown.** A provider that returns 429 or 5xx is skipped for later tasks in the same run, until its `Retry-After` passes (default 60s). This stops Baton from re-hitting an exhausted quota on every task. If every provider is cooling down, all are tried anyway.
* **Any provider error fails over** (auth, 4xx, malformed reply), not only 429 and timeouts. The log message records the actual reason.
* **Unguessable workspace IDs** (`ws_<ts>_<random>`). The ID is the download token, so a bare timestamp would let anyone fetch another user's artifacts.
* **Timeout covers the response body**, not just the headers. A provider that stalls mid-response still triggers failover after 30s.
* **Model discovery.** Providers retire model IDs without notice: Groq dropped the spec's `qwen-2.5-coder-32b`, and NVIDIA's older IDs answer `410 Gone`. When every configured model for a provider is gone, Baton calls the provider's free `GET /models` once per run and picks the best current chat model (coder models first for code). The log says `(picked from <provider>'s current model list)`. Errors such as 404, 410, and 400 "decommissioned" or "no longer supported" all count as "model gone".
* **Provider error text in the log.** For non-obvious failures, the log shows the provider's own message, e.g. `HTTP 400 model unavailable: The model … has been decommissioned`.
* **Gemini model fallback.** Google retires model IDs for new users without notice. Gemini is configured with a model list (`gemini-3.8-flash`, then `gemini-3.5-flash-lite`; override with `GEMINI_MODELS`). On HTTP 404 or a "no longer available" error, the next model is tried first, and only when every model is gone does Baton fail over to Groq. A retired model is remembered for the rest of the request, so it costs one extra call, not one per file. Each swap appears in the relay log.
* **Overloaded models (503 / "high demand").** Baton first tries the next model in the list, which often has separate capacity. Busy models aren't remembered as dead, because the spike is temporary. If another provider is available Baton switches right away. If it's the last provider, Baton waits `BATON_OVERLOAD_RETRY_MS` (default 2s) and tries once more. Planning errors list what each provider returned, plus a likely cause.
* **Keys are never logged or persisted.** The stored workspace holds no credentials.

## Storage

`InMemoryWorkspaceStore` is the default. For multiple instances, pass a `RedisWorkspaceStore` wrapping any ioredis or node-redis client:

```ts
import { buildServer } from "./src/index.js";
import { RedisWorkspaceStore } from "./src/services/storage.js";
buildServer({ store: new RedisWorkspaceStore(redisClient) });
```

## Troubleshooting

* **Open it at `http://localhost:3000`**, not your network IP (`http://192.168.x.x:3000`). Browsers treat plain-HTTP network addresses as insecure, so extensions such as Grammarly throw `crypto.randomUUID is not a function` and downloads show an "insecure connection" warning. Both are harmless, and neither comes from Baton.
* **`openai: HTTP 429 account has no credit`**: the OpenAI account has no billing credit. Add a payment method, or leave the OpenAI key empty.
* **`invalid plan`**: the model answered with a plan Baton couldn't use. Run again, or rephrase the request.

## Networking note

Node's built-in `fetch` ignores `HTTPS_PROXY`. Behind a corporate proxy, run with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
