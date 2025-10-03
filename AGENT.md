AGENT.md

Source of truth for automation and humans working in this repo.
When behavior changes, update this file together with public/index.html and public/openapi.json.

What this repo is
  • Cloudflare Worker (TypeScript, ESM) that powers MenuForge AI recipe utilities.
  • JSON API under /api/* protected by WORKER_API_KEY (X-API-Key or Bearer).
  • Static UI and docs in /public served via Assets binding (public/index.html tester, public/openapi.json schema).

⸻

Non-negotiables
  • Keep public/index.html and public/openapi.json in sync with the API in the same PR.
  • Run wrangler types --experimental-include-runtime before type checking.
  • npm run typecheck and npm test must pass locally and in CI before merge.
  • Preserve verbose structured logging (100% sampling) written to request_logs (queried via /api/logs).
  • Do not reduce observability bindings without approval.

⸻

Layout

/src/env.ts                # binding interfaces
/src/types.ts              # shared domain types
/src/utils.ts              # helpers
/src/auth.ts               # API-key auth enforcement
/src/ai.ts                 # Workers AI helpers (chat, embeddings, ASR, OCR, normalization)
/src/db.ts                 # D1 helpers for prefs, recipes, ingestions
/src/worker.ts             # main fetch() router
/migrations/*.sql          # D1 migrations
/public/index.html         # static tester (auth, chat, voice, ingestion, prefs, logs)
/public/openapi.json       # OpenAPI 3.0 schema
/tests/**/*.test.ts        # Vitest worker tests
/wrangler.toml             # Worker config (Assets, AI, Browser, Vectorize, Observability, D1)

⸻

Config: Wrangler, Assets, Observability, Cron

wrangler.toml must include

name = "colby-recipe-backend"
main = "src/worker.ts"
compatibility_date = "2025-01-01"

[assets]
directory = "./public"
binding = "ASSETS"

[observability]
enabled = true
head_sampling_rate = 1

[ai]
binding = "AI"

[browser]
binding = "BROWSER"

[[vectorize]]
binding = "VEC"
index_name = "recipes-index"

[[d1_databases]]
binding = "DB"
database_name = "DB"
database_id = "..."

# keep other bindings (cron, etc.) as required by production.

⸻

Environment & scripts
  • Generate runtime types before typecheck: npm run pretypecheck
  • Scripts defined in package.json:
    {
      "pretypecheck": "wrangler types --experimental-include-runtime",
      "typecheck": "npm run pretypecheck && tsc --noEmit",
      "test": "vitest run",
      "dev": "wrangler dev",
      "migrate:remote": "wrangler d1 migrations apply DB --remote",
      "deploy": "npm run migrate:remote && wrangler deploy"
    }
  • Secrets live in .dev.vars (WORKER_API_KEY) locally; do not commit secrets.

Binding interfaces (keep explicit)

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKER_API_KEY: string;
  AI: AiService;
  BROWSER: BrowserService;
  VEC: VectorizeIndex;
}

⸻

Auth & routing
  • All /api/* endpoints require X-API-Key or Authorization: Bearer WORKER_API_KEY.
  • On failure: 401 + WWW-Authenticate: Bearer realm="worker" + JSON { "error": "Unauthorized" }.
  • Static assets served via ASSETS binding for non-/api paths.

⸻

Endpoints (must update docs + UI + tests when changing)
  • POST /api/chat/ingredients → embed ingredients + prefs, query Vectorize, LLM summary, returns {suggestions,message}.
  • POST /api/transcribe → multipart audio to Whisper transcription.
  • POST /api/ingest/url → use Browser binding to crawl, normalize via AI, store ingestion + recipe + embedding.
  • POST /api/ingest/image → OCR + normalize from recipe photos.
  • GET /api/prefs → fetch personalization prefs from user_prefs.
  • PUT /api/prefs → upsert personalization prefs.
  • GET /api/themes/suggest → embed theme seed + SQL filter for tailored list.
  • GET /api/logs → fetch structured request logs (ts, level, route, method, status, ms, msg, meta JSON).

⸻

Database
  • user_prefs table stores cuisines/dislikes/tools/notes (JSON arrays as TEXT).
  • ingestions table stores raw source + normalized recipe JSON.
  • request_logs table stores structured logs for /api/logs.
  • Recipes table holds normalized recipes; embeddings stored in Vectorize index recipes-index.

⸻

Testing & quality
  • Vitest tests live in /tests, use worker pools/mocks for bindings.
  • npm run typecheck && npm test before opening PR.
  • Keep TS strict mode passing.
  • Avoid Node-only APIs (use Web APIs).

⸻

Operations
  • Deploy flow: npm run deploy → migrate:remote then wrangler deploy.
  • Cron cleanup for request_logs retention handled in scheduled worker (TBD).
  • Structured console.log allowed but avoid leaking PII.

⸻

Do / Don’t
  • Do keep docs, UI, schema, and implementation in lock step.
  • Do sanitize external data, guard against null/undefined.
  • Don’t commit secrets, don’t disable observability.
