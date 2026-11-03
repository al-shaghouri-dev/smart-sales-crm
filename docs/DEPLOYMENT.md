# Running Smart Sales CRM — local development, free tiers, and a later VPS

Everything below works **without paid services, accounts or a credit card**. The same code runs
unchanged on a laptop, on free hosting tiers and on a paid VPS — only environment variables differ.

## 1. What runs where

| Component | Technology | Notes |
|---|---|---|
| API + frontend | Node.js 22.12+ (required by pg-boss 12) / Express 5, React build served by Express | **One origin** for API, pages and Socket.IO (see §6) |
| Database | PostgreSQL 16 (14+ should work) | RLS-enforced app role + schema-owner role for migrations |
| Background jobs | pg-boss (tables in schema `pgboss`, same database) | No Redis or paid queue |
| Real-time | Socket.IO (same HTTP server) | Optional PostgreSQL adapter for several instances |
| Webhooks | `/webhooks/:provider` on the same server | Must be reachable over public HTTPS for real providers |

Process roles (`PROCESS_ROLE` or `--role=`):

- `all` — one process does everything. **Use this locally and on any single small server.**
- `web` — HTTP + frontend + Socket.IO; enqueues jobs but runs no workers.
- `worker` — job workers and schedules only; no HTTP listener.

## 2. Local development (free)

### 2.1 PostgreSQL

**Option A — Docker Desktop (free for personal use):**

```bash
docker compose up -d
```

`docker/postgres/init.sh` creates the `sscrm_owner` (schema owner) and `sscrm_app` (application,
`NOBYPASSRLS`) roles and the `sscrm` / `sscrm_test` databases.

**Option B — PostgreSQL installed natively (Windows installer / Homebrew / apt):** open `psql` as
the `postgres` superuser and run (choose your own passwords):

```sql
CREATE ROLE sscrm_owner LOGIN PASSWORD 'change-me-owner';
CREATE ROLE sscrm_app LOGIN PASSWORD 'change-me-app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE sscrm OWNER sscrm_owner;
CREATE DATABASE sscrm_test OWNER sscrm_owner;
```

### 2.2 Configure, migrate, start

```bash
cp .env.example .env
```

(PowerShell: `Copy-Item .env.example .env`). Then edit `.env`: `DATABASE_URL`, `DATABASE_MIGRATION_URL`,
`APP_DB_ROLE`, and one encryption key (`APP_ENCRYPTION_KEYS=k1:<base64>` with
`APP_ENCRYPTION_PRIMARY_KEY_ID=k1`).

```bash
npm install
```

```bash
npm run migrate
```

```bash
npm run platform:admin -- --email you@example.com --name "Your Name"
```

```bash
npm run build
```

```bash
npm start
```

Open `http://localhost:3000` (workspace) or `http://localhost:3000/admin/login` (Super Admin).

**Frontend hot reload:** run `npm run dev` (API, port 3000) and `npm run dev:web` (Vite, port 5173).
Vite proxies `/api`, `/uploads`, `/webhooks` and `/socket.io` (WebSocket) to port 3000. Add the Vite
origin to the socket allow-list: `REALTIME_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173`.

**Trying webhooks locally:** set `CHANNEL_PROVIDERS=fake` and `FAKE_PROVIDER_SECRET=<any string>`.
Deliveries to `POST /webhooks/fake` must carry `X-Fake-Signature: sha256=<HMAC-SHA256 hex of the raw body>`.
The fake provider is refused when `NODE_ENV=production`.

### 2.3 Tests

```bash
npm test
```

Database tests need `TEST_DATABASE_URL`, `TEST_DATABASE_MIGRATION_URL` and `TEST_APP_DB_ROLE`
pointing at a **throwaway** database (`sscrm_test`); they roll migrations back and forth and truncate tables.

## 3. Migrations

- `npm run migrate` applies pending migrations as the **schema owner** (`DATABASE_MIGRATION_URL`).
- `npm run migrate:rollback` undoes the last batch.
- Never run migrations as the application role. The app role can create objects **only** inside the
  `pgboss` schema (pg-boss installs/upgrades its own tables there at start-up).
- Migration filenames must not be dated in the future (enforced by `test/migrations.test.js`).

## 4. Health checks & shutdown

| Endpoint | Meaning |
|---|---|
| `GET /api/health` | Liveness — the process responds. |
| `GET /api/ready` | Readiness — database reachable, jobs started (when enabled), not shutting down. Returns 503 otherwise. Only booleans are exposed. |

On `SIGTERM` / `SIGINT` the server: marks itself not-ready → stops accepting HTTP and closes
sockets → lets running jobs finish (up to `SHUTDOWN_TIMEOUT_MS`) → closes database pools. A second
signal, or the timeout, forces exit.

## 5. Encryption keys

Keys live only in environment variables, never in the database or the repository.

1. Generate: `openssl rand -base64 32`
2. Add it to `APP_ENCRYPTION_KEYS` (keep the old one) and set `APP_ENCRYPTION_PRIMARY_KEY_ID` to it.
3. Restart. New values use the new key; old ones stay readable.
4. `npm run secrets:rotate` re-encrypts existing values (`--dry-run` to count first).
5. When it reports 0 remaining, remove the old key and restart.

Losing every key makes stored channel credentials unrecoverable (companies would reconnect their
channels). Back keys up separately from database backups.

## 6. Hosting constraints that the code relies on

- **Same origin.** Session cookies are `HttpOnly; SameSite=Lax` and writes require a CSRF token.
  A browser on `*.vercel.app` will not send that cookie to an API on another site. Serve the
  frontend **from the Node server** (it already does: `npm run build` → Express serves `dist/web`).
  Do **not** weaken cookies to `SameSite=None` to split hosting. If a static host is ever used in
  front, it must proxy `/api`, `/uploads`, `/webhooks` and `/socket.io` to the Node server under the
  same domain (WebSocket proxying is required for Socket.IO; long-polling works as a fallback).
- **Long-running process.** Jobs, schedules and Socket.IO need a process that stays up.
  Serverless/function platforms cannot host the backend.
- **Public HTTPS** is required for real provider webhooks and for OAuth redirects (Phase 3.3+).
- **Session-pinned database connections** for pg-boss and LISTEN/NOTIFY. If the provider gives a
  "pooled" (PgBouncer transaction mode) URL, put the **direct** URL in `DATABASE_DIRECT_URL`.
- **Persistent file storage** for uploads (`UPLOADS_DIR`). Ephemeral disks lose logos and, later,
  message media. An S3-compatible storage driver is planned before production.

## 7. Free tiers — what can and cannot work

Free-tier terms change often. The points below are **what to verify before relying on a service**,
not guarantees. No account has been created and nothing has been deployed.

| Need | Typical free-tier behaviour | Consequence |
|---|---|---|
| Web + worker on a free web-service tier (e.g. Render free) | Instance **sleeps after a period of inactivity** and takes time to wake; monthly hour caps; no persistent disk | While asleep **no jobs run** (subscription expiry, webhook retries) and the first webhook after sleep may time out. Providers retry, but repeated failures can get webhooks disabled. Uploads are lost on restart. **Acceptable for demos only.** |
| Frontend on Vercel free | Static hosting is fine; serverless functions are short-lived | Cannot host the backend, jobs or WebSockets. Splitting origins breaks cookie auth (§6) unless everything is proxied under one domain. |
| PostgreSQL on a free provider (e.g. Neon, Supabase, Render free) | Small storage limits; compute **auto-suspends** when idle; some free databases **expire or pause** after inactivity; pooled URLs use PgBouncer | Works for development and demos. Use the **direct** connection for `DATABASE_DIRECT_URL`. Watch storage (webhook payloads are kept `WEBHOOK_RETENTION_DAYS`). Expiring databases are **not** acceptable for real customer data. |
| Custom domain / HTTPS | Free subdomains include HTTPS | Fine for testing. Meta App Review needs a stable, public privacy-policy URL and redirect domain. |

**Bottom line:** free tiers are suitable for development, demos and Meta development-mode testing.
They are **not** reliable for paying customers: sleeping instances stop background processing and
delay webhooks. The first paid step that removes these limits is one small always-on server
(e.g. a VPS running `npm start` with `PROCESS_ROLE=all`, PostgreSQL alongside or managed).

## 8. Vercel (frontend only)

Vercel **cannot host this backend by itself**:

| Requirement | Why Vercel alone cannot provide it | Where it must run instead |
|---|---|---|
| PostgreSQL | Vercel has no built-in PostgreSQL in this setup | A PostgreSQL provider (free tier for demos) or the VPS |
| Background jobs (pg-boss workers + schedules) | Vercel functions are short-lived and stop between requests | An always-on Node.js process (`npm start` or `--role=worker`) |
| Socket.IO / WebSockets | Vercel functions do not keep WebSocket connections | The same always-on Node.js process |
| Webhook processing | Needs the job workers above | Node.js process (Vercel may forward the HTTP request) |
| Uploaded files (logos, later media) | No persistent disk | Node.js host disk now; S3-compatible storage before production |

What the repository is prepared for:

- `vercel.json` builds **only the frontend** (`npm run build` → `dist/web`) with `framework: null`,
  sends the same security headers as Express (CSP, HSTS, no-referrer, frame denial), and forwards
  `/api`, `/socket.io`, `/webhooks` and `/uploads` to the Node.js backend. The browser therefore sees
  **one origin** (the Vercel domain): session cookies and CSRF protection work unchanged.
- `.vercelignore` keeps backend code, tests, data and secrets out of the Vercel upload.
- `scripts/check-vercel-config.js` runs before the Vercel build and **blocks the deployment** while the
  backend origin is still the placeholder `BACKEND_ORIGIN_NOT_CONFIGURED.invalid`, if a destination is
  not `https`, if the rewrites point to different origins, or if security headers were removed.
- Socket.IO starts with HTTP long-polling and upgrades to WebSocket when possible. Through a Vercel
  rewrite it stays on long-polling (works, slightly higher latency/requests).

Steps (after a backend host is chosen — nothing has been created or deployed):

1. Run the Node.js backend somewhere always-on with PostgreSQL (see §2, §6, §7).
2. Replace `https://BACKEND_ORIGIN_NOT_CONFIGURED.invalid` in the four rewrites of `vercel.json` with the
   backend's https origin, commit.
3. Import the GitHub repository in Vercel (root directory = repository root; settings come from `vercel.json`).
4. On the **backend**, set:
   - `APP_URL=https://<your-vercel-domain>` (invitation/reset links and the default socket origin)
   - `REALTIME_ALLOWED_ORIGINS=https://<your-vercel-domain>`
   - `TRUST_PROXY=2` when traffic passes Vercel **and** the host's own load balancer (use the real count;
     too high lets clients spoof their IP, too low makes every user share one rate-limit bucket)
   - `NODE_ENV=production`, encryption keys, database URLs (see `.env.example`)
5. Point provider webhooks (Phase 3.3+) at the backend origin directly (preferred) or at the Vercel domain.

Limits of this split: every API call makes an extra hop through Vercel; long-polling uses more requests than
WebSockets; Vercel rewrite timeouts apply to slow API calls. A single always-on Node.js host serving
everything (§1) avoids all of these and is the simplest production setup.

## 9. Moving to a VPS later (no code changes)

1. Install Node.js 22 and PostgreSQL (or use a managed database); create the two roles as in §2.1.
2. Copy `.env` values (keep the same encryption keys!), set `NODE_ENV=production`, `APP_URL`,
   `TRUST_PROXY=true` behind a reverse proxy (Caddy/Nginx with HTTPS).
3. `npm ci`, `npm run migrate`, `npm run build`, then run `npm start` under a process manager
   (systemd, PM2 or Docker) that sends `SIGTERM` on stop.
4. To scale out: run several `--role=web` instances with `REALTIME_ADAPTER=postgres` behind a load
   balancer with sticky sessions or WebSocket-only transport, plus one or more `--role=worker` processes.
