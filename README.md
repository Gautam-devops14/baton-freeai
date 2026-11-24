# Baton

A stateful relay orchestrator for free-tier LLM endpoints. Baton plans a project with Gemini 3.8 Flash, builds each artifact on Groq, and when Groq returns a 429 or times out it hands the work to Gemini. Optional NVIDIA NIM (free developer tier) and OpenAI (paid) keys add more fallback tiers. The task keeps going without restarting, because all context lives in a shared workspace rather than in any one model's chat history.

## Quick start

```bash
npm install
npm run dev          # open http://localhost:3000 for the web UI
npm test             # 22 tests, providers stubbed: no keys needed
npm run build && npm start
```

## Web UI

Open http://localhost:3000, paste any of your Groq, Gemini, NVIDIA NIM or OpenAI keys, describe a project and click **Run**. You'll see the relay log, each generated file, and a .zip download link. Keys are only stored in your browser if you tick "Remember keys".

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
  "keys": { "groqApiKey": "gsk_...", "geminiApiKey": "AIza...", "nvidiaApiKey": "nvapi-...", "openaiApiKey": "sk-..." }
}'
```

* `taskType`: `code` (default), `document`, or `analysis`.
* `keys`: at least one is required (BYOK). With only one key, Baton runs single-provider and loses failover.
  * Order for building files: Groq → Gemini → NVIDIA NIM → OpenAI. Order for planning: Gemini → Groq → NVIDIA NIM → OpenAI.
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
