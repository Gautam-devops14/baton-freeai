# Baton

A stateful relay orchestrator for free-tier LLM endpoints. Baton plans a project with Gemini 2.5 Flash, builds each artifact on Groq, and when Groq returns a 429 or times out it hands the work to Gemini. The task keeps going without restarting, because all context lives in a shared workspace rather than in any one model's chat history.

## Quick start

```bash
npm install
npm run dev          # tsx watch, http://localhost:3000
npm test             # 22 tests, providers stubbed: no keys needed
npm run build && npm start
```

## API

### `POST /api/orchestrate`

```bash
curl -s localhost:3000/api/orchestrate -H 'content-type: application/json' -d '{
  "userPrompt": "Create an Express.js authentication service with JWT and bcrypt",
  "taskType": "code",
  "keys": { "groqApiKey": "gsk_...", "geminiApiKey": "AIza..." }
}'
```

* `taskType`: `code` (default), `document`, or `analysis`.
* `keys`: at least one is required (BYOK). With only one key, Baton runs single-provider and loses failover.
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
* **Keys are never logged or persisted.** The stored workspace holds no credentials.

## Storage

`InMemoryWorkspaceStore` is the default. For multiple instances, pass a `RedisWorkspaceStore` wrapping any ioredis or node-redis client:

```ts
import { buildServer } from "./src/index.js";
import { RedisWorkspaceStore } from "./src/services/storage.js";
buildServer({ store: new RedisWorkspaceStore(redisClient) });
```

## Networking note

Node's built-in `fetch` ignores `HTTPS_PROXY`. Behind a corporate proxy, run with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
