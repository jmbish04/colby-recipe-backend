AGENT.md

Source of truth for both humans and automation working on this codebase.
If you change behavior, you must update this file, public/index.html, and public/openapi.json in the same PR.

What this repo is
	•	Backend only: a Cloudflare Worker (TypeScript, ESM).
	•	JSON API under /api/*.
	•	Static assets from /public/ via Assets binding:
	•	public/index.html → help/docs + API tester + logs viewer (when an API key is entered).
	•	public/openapi.json → static OpenAPI schema.
	•	All API routes are protected by WORKER_API_KEY (secret).

⸻

Non-negotiables
	•	Keep public/index.html (help + tester + logs viewer) and public/openapi.json in sync with the API in the same PR.
	•	All tests must pass locally and in CI before merging.
	•	Use wrangler types for runtime/binding types. Do not use @cloudflare/workers-types.
	•	Observability enabled and verbose logging (100% sampling) unless directed otherwise.
	•	D1 logs retention: keep 14 days via a daily cron cleanup.

⸻

Layout

/src/worker.ts             # main fetch(), routing, scheduled()
/migrations/               # D1 migrations (SQL)
/public/index.html         # static landing + API tester + logs viewer (vanilla HTML/JS)
/public/openapi.json       # static OpenAPI v3 schema
/wrangler.toml             # Worker + Assets + Observability + Cron
/tests/**                  # unit/integration tests (Vitest)


⸻

Config: Wrangler, Assets, Observability, Cron

wrangler.toml

name = "colby-recipe-backend"
main = "src/worker.ts"
compatibility_date = "2025-01-01"

[assets]
directory = "./public"
binding = "ASSETS"

[observability]
enabled = true
head_sampling_rate = 1     # verbose logs: sample 100% of requests

[triggers]
crons = ["0 3 * * *"]      # daily 03:00 UTC cleanup of D1 logs

# Bindings (example)
[[d1_databases]]
binding = "DB"
database_name = "DB"
database_id = "YOUR_DB_ID"

Assets-first routing serves files under /public. API routes live under /api/* and are handled by the Worker.

⸻

Environment, Types, and Secrets

Types (replace workers-types with wrangler types)

Generate types before type-check/build:

npx wrangler types --experimental-include-runtime

Recommended scripts:

{
  "scripts": {
    "pretypecheck": "wrangler types --experimental-include-runtime",
    "typecheck": "npm run pretypecheck && tsc --noEmit",
    "dev": "wrangler dev",
    "migrate:remote": "wrangler d1 migrations apply DB --remote",
    "deploy": "npm run migrate:remote && wrangler deploy"
  }
}

Secrets & env
	•	Local (not committed): .dev.vars

WORKER_API_KEY=dev-123


	•	Remote: wrangler secret put WORKER_API_KEY
	•	Bulk: prepare secrets.json like:

{ "WORKER_API_KEY": "prod-xyz" }

then wrangler secret bulk secrets.json.

Binding types (keep explicit)

interface Env {
  ASSETS: Fetcher;           // from [assets]
  DB: D1Database;            // D1 binding
  WORKER_API_KEY: string;    // secret
}


⸻

Auth & Routing (contract)
	•	All /api/* endpoints require either:
	•	Authorization: Bearer <WORKER_API_KEY> or
	•	X-API-Key: <WORKER_API_KEY>
	•	On failure: 401 + WWW-Authenticate: Bearer realm="worker" and JSON { "error": "Unauthorized" }.

Skeleton (keep shape):

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const route = url.pathname;

    if (route.startsWith("/api/")) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : request.headers.get("x-api-key");
      if (!token || token !== env.WORKER_API_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="worker"' }
        });
      }
      return handleApi(request, env, ctx); // implement below
    }

    // static
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // delete logs older than 14 days
    ctx.waitUntil(env.DB.prepare(
      "DELETE FROM logs WHERE ts < datetime('now', '-14 days')"
    ).run());
  }
} satisfies ExportedHandler<Env>;


⸻

Logging (verbose) + D1 retention

Table and migration

Create migrations/000X_create_logs.sql:

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  level TEXT NOT NULL,              -- INFO|WARN|ERROR
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,              -- latency in ms
  ip TEXT,                          -- optional: consider PII policy
  user_agent TEXT,
  msg TEXT,                         -- short message
  meta TEXT                         -- JSON string payload
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts);

Write logs

In your API handler, log both to Workers Logs (console) and (optionally) to D1:

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const route = url.pathname;

  // ... route to real handlers ...

  const response = await routeRequest(request, env, ctx); // your router

  const ms = Date.now() - started;

  // Workers Logs (structured JSON)
  console.log({
    level: "INFO",
    route,
    method: request.method,
    status: response.status,
    ms
  });

  // Persist a slim row to D1 (async)
  ctx.waitUntil(env.DB.prepare(
    "INSERT INTO logs (level, route, method, status, ms, msg, meta) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    "INFO",
    route,
    request.method,
    response.status,
    ms,
    "request_complete",
    JSON.stringify({ colo: (request as any).cf?.colo })
  ).run());

  return response;
}


⸻

Logs API (for index.html viewer)

Add a read-only endpoint to list recent logs (protected by the same API key):

GET /api/logs?limit=100&level=INFO|WARN|ERROR

Behavior:
	•	limit optional, default 100, clamp 10..500.
	•	level optional; when present, filter.
	•	Order: newest first.
	•	Response:

{
  "items": [{ "ts": "...", "level": "INFO", "route": "/api/...", "method": "GET", "status": 200, "ms": 12, "msg": "request_complete", "meta": { ... } }],
  "next": null
}



Implementation snippet:

async function listLogs(env: Env, limit: number, level?: string) {
  const n = Math.max(10, Math.min(500, Math.floor(limit || 100)));
  const stmt = level
    ? env.DB.prepare("SELECT ts, level, route, method, status, ms, msg, meta FROM logs WHERE level = ? ORDER BY ts DESC LIMIT ?").bind(level, n)
    : env.DB.prepare("SELECT ts, level, route, method, status, ms, msg, meta FROM logs ORDER BY ts DESC LIMIT ?").bind(n);
  const { results } = await stmt.all();
  return results?.map(r => ({ ...r, meta: safeJson(r.meta) })) ?? [];
}

function safeJson(s?: string | null) {
  try { return s ? JSON.parse(s) : undefined; } catch { return undefined; }
}

Router hook:

if (url.pathname === "/api/logs" && request.method === "GET") {
  const limit = Number(url.searchParams.get("limit") || "100");
  const level = url.searchParams.get("level") || undefined;
  return json({ items: await listLogs(env, limit, level) });
}

Utility:

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) }});
}


⸻

public/index.html: Help + API Tester + Logs Viewer

Requirements
	•	Plain HTML/CSS/JS (no build tools).
	•	Inputs:
	•	Base URL (readonly, default current origin)
	•	Path (default /api/...)
	•	Method selector
	•	Headers editor with preset Authorization: Bearer <token> or X-API-Key: <token>
	•	Request body textarea (JSON)
	•	Buttons: Send
	•	Output: status, headers, pretty JSON.
	•	API Key input persisted to localStorage.
	•	Logs panel (visible once API key is set):
	•	Shows the latest N log rows from /api/logs?limit=100.
	•	Refresh button; auto-refresh toggle (e.g., 10s).
	•	Columns: ts, level, route, method, status, ms, msg.
	•	A details expander to show meta.

JS sketch (logs panel):

<script>
  const keyInput = document.querySelector("#apiKey");
  const logsTbody = document.querySelector("#logs tbody");
  const refreshBtn = document.querySelector("#refreshLogs");

  async function fetchLogs() {
    const key = keyInput.value.trim();
    if (!key) return;
    const headers = { "X-API-Key": key, "Accept": "application/json" };
    const res = await fetch("/api/logs?limit=100", { headers });
    const data = await res.json();
    renderLogs(data.items || []);
  }

  function renderLogs(items) {
    logsTbody.innerHTML = "";
    for (const r of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.ts ?? ""}</td>
        <td>${r.level ?? ""}</td>
        <td>${r.route ?? ""}</td>
        <td>${r.method ?? ""}</td>
        <td>${r.status ?? ""}</td>
        <td>${r.ms ?? ""}</td>
        <td>${r.msg ?? ""}</td>
        <td><details><summary>meta</summary><pre>${JSON.stringify(r.meta, null, 2)}</pre></details></td>
      `;
      logsTbody.appendChild(tr);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    keyInput.value = localStorage.getItem("apiKey") || "";
    keyInput.addEventListener("input", e => localStorage.setItem("apiKey", e.target.value));
    refreshBtn.addEventListener("click", fetchLogs);
    if (keyInput.value) fetchLogs();
  });
</script>

UI Note: Keep CSS minimal; make tables scrollable on small screens. Provide a link to /openapi.json.

⸻

OpenAPI (public/openapi.json)—must include
	•	openapi: "3.0.3", info, servers.
	•	securitySchemes:
	•	apiKey in header X-API-Key
	•	http bearer
	•	Global security: require at least one scheme.
	•	Paths for all endpoints, including:
	•	GET /api/logs with limit/level parameters and response schema.

⸻

Deploy flow (mandatory order)

npm run deploy must start with remote D1 migrations:

{
  "scripts": {
    "migrate:remote": "wrangler d1 migrations apply DB --remote",
    "deploy": "npm run migrate:remote && wrangler deploy"
  }
}


⸻

Code quality gates
	•	npm run typecheck passes; no TS errors.
	•	npm test green (Vitest).
	•	Lint/format clean.
	•	Bundle free of Node-only APIs (use Web APIs).
	•	If changing ranking logic or batch scan, include regression tests (esp. the earlier created_at fix and duplicate results var fix).

⸻

When adding/changing an endpoint (checklist)
	•	Implement under /api/* and keep auth check first.
	•	Validate input; return typed JSON with content-type.
	•	Update public/openapi.json (paths/schemas/examples/errors).
	•	Update public/index.html tester presets and, if relevant, the logs viewer.
	•	Add/adjust tests.
	•	Run npm run typecheck && npm test && wrangler dev.
	•	One PR updating code + docs + schema together.

⸻

Operations
	•	Secrets
	•	One: wrangler secret put WORKER_API_KEY
	•	Bulk: wrangler secret bulk secrets.json
	•	Logs
	•	Structured console logs visible via Workers Logs (observability enabled).
	•	Lightweight request summary rows in D1 (query via /api/logs).
	•	Rollback
	•	wrangler versions list → wrangler versions rollback <id>
	•	Privacy
	•	Be cautious logging PII (e.g., IP). If not required, omit or hash.

⸻

Do / Don’t

Do
	•	Keep API, docs, tester, and logs viewer in lock-step.
	•	Use wrangler types before typechecking/building and anytime wrangler.toml or wrangler.jsonc is updated  
	•	Guard nulls from external data (e.g., created_at).

Don’t
	•	Route static docs through dynamic code (serve via Assets).
	•	Commit .dev.vars or secrets to github (gitignore .dev.vars, .env, node_modules, etc)
	•	Reduce observability without a reason—verbose is the default here.

⸻

Owner: Repo owner in GitHub. Changes to auth, routing, observability, or logging policy require sign-off.