# Architecture

Smart Sales CRM is a **multi-tenant SaaS** for sales teams that answer customers on messaging channels.
One Node.js application serves the API, the React frontend, real-time events and background jobs; all
state lives in **PostgreSQL** (plus a directory or S3 bucket for uploaded files).

```
                      Browser (React SPA, Arabic/English, RTL/LTR)
                         │  HTTPS: pages, /api (cookie session + CSRF header), /socket.io
                         ▼
        ┌────────────── reverse proxy (Nginx / load balancer / CDN rewrite) ───────────────┐
        │                                                                                  │
        ▼                                                                                  │
┌────────────────────────────── Node.js 22 process (server/index.js) ──────────────────────┴───┐
│ Express 5 app (server/app.js)                                                                │
│  ├─ /api/*            REST API (routes/), session + permission middleware, RLS context       │
│  ├─ /webhooks/:provider   raw-body webhook intake → webhook_events table → job queue         │
│  ├─ /media/:token     short-lived signed attachment links for providers                      │
│  ├─ /uploads/*        public logos/favicons (UPLOADS_DIR)                                    │
│  └─ /*                built React app (dist/web)                                             │
│ Socket.IO (server/realtime) — same HTTP server, cookie-authenticated, server-assigned rooms  │
│ pg-boss workers (server/jobs) — webhook processing, outbound sends, sweepers, maintenance    │
│ Channel adapters (server/channels/providers) — telegram, messenger, instagram, whatsapp, fake│
└───────────────┬─────────────────────────────────────────────┬────────────────────────────────┘
                │ SQL (app role, NO BYPASSRLS)                │ HTTPS (safeFetch, SSRF-guarded)
                ▼                                             ▼
   PostgreSQL 16: public schema (RLS on tenant tables)    Telegram Bot API, Meta Graph API,
                  pgboss schema (job queue)                S3-compatible storage, SMTP
```

## Repository layout

| Path | Contents |
|---|---|
| `server/index.js` | Entry point: loads config, starts the runtime, graceful shutdown on SIGTERM/SIGINT |
| `server/runtime.js` | Composes HTTP server, Socket.IO, job workers and schedules per `PROCESS_ROLE` |
| `server/app.js` | Express app: security headers, health/readiness, webhooks, rate limits, routes, SPA hosting, error handler |
| `server/config.js` | Every environment variable and its validation (see ENVIRONMENT.md) |
| `server/db.js` | Knex pool + `withContext()` which sets the tenant context per transaction |
| `server/routes/` | REST endpoints (see API_DOCUMENTATION.md) |
| `server/middleware/` | `session.js` (sessions, CSRF, permissions, subscription access), `plan.js` (plan features) |
| `server/services/` | companies, subscriptions, seats, channels, channel maintenance, audit, tokens, mailer |
| `server/messaging/` | inbound recording, outbound queue + sender, access rules, API serialisation |
| `server/channels/` | provider adapter contract, registry, providers, Meta shared core |
| `server/webhooks/` | ingestion router, async processor, signature helpers |
| `server/realtime/` | Socket.IO server |
| `server/jobs/` | pg-boss queues, retry policies, cron schedules |
| `server/security/` | password hashing (scrypt), credential encryption (AES-256-GCM key ring) |
| `server/media/storage.js` | private media storage (local / S3), content detection |
| `server/net/safe-fetch.js` | outbound HTTP with SSRF protection |
| `web/` | React 18 + Vite frontend (`web/src/pages`, `components`, `lib`, `locales/{ar,en}.json`) |
| `db/migrations/` | Knex migrations (schema, RLS policies, SECURITY DEFINER helpers, seed rows) |
| `db/schema.sql` | Generated reference schema (plain SQL) |
| `scripts/` | CLI tools: database preparation, admin/company creation, backup/restore, key rotation, load test |
| `infrastructure/` | Docker Compose (production), PostgreSQL init, Nginx, systemd |
| `test/` | Integration tests against a real PostgreSQL (API, RLS, jobs, realtime, providers via mock servers) |
| `legacy/` | Original single-workspace prototype, kept for reference only — **not deployed** |

## Request lifecycle (API)

1. `helmet` security headers; `/api` responses are `Cache-Control: no-store`; per-IP rate limit.
2. `loadSession` reads the httpOnly cookie `sscrm_session`, looks up `sessions` by SHA-256 of the token
   and loads user, company, membership, permissions and subscription.
3. Route guards: `requireAuth` (and the `X-CSRF-Token` header on every non-GET request), `requireCompany`,
   `requirePermission(...)`, `requirePlatformAdmin`, plan feature gates, subscription access policy.
4. Handlers run SQL inside `db.withContext({ companyId, userId })` which sets `app.company_id`,
   `app.user_id`, … with `SET LOCAL`. PostgreSQL **Row Level Security** limits every query to that company.
5. Errors are returned as `{ ok: false, code, error, details? }` — stable `code`s are translated by the UI.

## Multi-tenancy and security model

- Two database roles: the **schema owner** (migrations only) and the **application role** (`APP_DB_ROLE`,
  `NOBYPASSRLS`). Tenant tables use `FORCE ROW LEVEL SECURITY`, which also binds the owner.
- Policies allow a row when `company_id = app_current_company()`; Super Admin endpoints use a platform
  context; a few narrow `SECURITY DEFINER` functions handle lookups that happen before a tenant is known
  (login by email, webhook routing, outbox sweeper, maintenance lists).
- Super Admin uses a separate session kind (`/admin/login`); workspace sessions never reach `/api/platform`.
- Channel credentials are encrypted with AES-256-GCM, key ring from `APP_ENCRYPTION_KEYS`, bound to
  (purpose, company, channel). See `docs/SECURITY.md` for the full review.

## Messaging pipeline

**Inbound:** `POST /webhooks/<provider>[/<key>]` → adapter verifies the signature on the raw body →
events stored in `webhook_events` (`UNIQUE(provider, event_key)` de-duplicates) → `200` → job
`webhook.process` → adapter `processEvent` → `messaging.recordInbound` (identity/contact/conversation
upsert under an advisory lock, message insert de-duplicated by external id) → Socket.IO events.

**Outbound:** `POST /api/conversations/:id/messages` → policy checks (visibility, channel state, plan,
provider reply window, kill switch, daily cap) → `messages` row `queued` → job `message.send` → adapter
`sendMessage` → `sent` (or retry with backoff / `failed` / channel flagged `needs_reconnect`) → delivery
and read receipts arrive by webhook.

## Background jobs (pg-boss, schema `pgboss`)

| Queue | Trigger | Purpose |
|---|---|---|
| `webhook.process` | per stored event | run the provider adapter for one webhook event |
| `webhook.sweep` | `*/5 * * * *` | re-queue events whose job was lost |
| `webhook.cleanup` | `17 3 * * *` | delete processed events older than `WEBHOOK_RETENTION_DAYS` |
| `message.send` | per outbound message | send through the provider with retries |
| `message.sweep` | `*/2 * * * *` | re-queue lost sends; mark stuck sends as unknown outcome (never re-sent) |
| `channel.maintenance` | `41 * * * *` | refresh expiring tokens, flag expired ones, notify channel managers |
| `subscription.maintenance` | `7 * * * *` | expire subscriptions, send expiry notifications |

Schedules are stored in the database, so any number of worker processes never duplicates them.

## Real-time (Socket.IO at `/socket.io`)

- Handshake authenticated with the session cookie; browser `Origin` must be in `REALTIME_ALLOWED_ORIGINS`
  (default `APP_URL`).
- Rooms are assigned by the server: user, session, company, `company:<id>:perm:<permission>`, platform.
- Client may request `subscribe { room: "conversation", id }`; the server authorises it (view_all or assigned).
- Events: `ready`, `conversation:updated` (ids only), `message:new` / `message:updated` (conversation room),
  `session:changed`.
- Several web instances: `REALTIME_ADAPTER=postgres` (LISTEN/NOTIFY through table `socket_io_attachments`).

## Process roles and scaling

`PROCESS_ROLE=all` runs everything in one process (recommended for a single server). For scale-out, run N
× `web` (stateless HTTP + Socket.IO with `REALTIME_ADAPTER=postgres` and sticky sessions or WebSocket-only
transport) and M × `worker`. All share the same database and file storage (use S3 for several hosts).

## Frontend

React 18 SPA built by Vite into `dist/web` and served by Express (same origin as the API — required for
the `SameSite=Lax` session cookie and CSRF model). Routes: workspace (`/`, `/inbox`, `/channels`, `/team`,
`/roles`, `/settings`, `/audit`, `/billing`, `/account`) and Super Admin (`/admin/*`). i18next with Arabic
and English, automatic RTL/LTR, light/dark themes, company and platform branding.
