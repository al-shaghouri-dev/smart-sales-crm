# Environment variables

All configuration is read in `server/config.js` (and `scripts/prepare-database.js`). Start from
`.env.example`. Never commit `.env`; keep production values in your secret manager / host settings.

**Legend:** **R** required in production · **C** conditionally required · **O** optional (default shown).

## Runtime

| Variable | Req. | Default | Purpose / how to obtain |
|---|---|---|---|
| `NODE_ENV` | R | `development` | Set `production` on servers: secure cookies, HSTS, strict validation (missing keys refuse to start). |
| `PORT` | O | `3000` | HTTP listen port. |
| `PROCESS_ROLE` | O | `all` | `all` \| `web` \| `worker` (see ARCHITECTURE.md › Process roles). `--role=` CLI flag overrides. |
| `TRUST_PROXY` | C | off | Number of proxies in front (1–9, or `true` = 1). Required behind Nginx/LB for correct client IPs and rate limits. Never higher than the real count. |
| `SHUTDOWN_TIMEOUT_MS` | O | `25000` | Time to let running jobs finish on SIGTERM. |

## Public URLs

| Variable | Req. | Default | Purpose |
|---|---|---|---|
| `APP_URL` | R | `RENDER_EXTERNAL_URL` or `http://localhost:PORT` | Public https URL of the app: invitation/reset links, default Socket.IO origin. |
| `PUBLIC_URL` | O | `APP_URL` | Origin providers call (webhooks, OAuth redirect URIs). Must be https in production when channels are enabled. |
| `REALTIME_ALLOWED_ORIGINS` | O | `APP_URL` | Comma-separated browser origins allowed to open Socket.IO. |

## Database

| Variable | Req. | Default | Purpose / how to obtain |
|---|---|---|---|
| `DATABASE_MIGRATION_URL` | R | — | Schema-owner connection string (`postgres://owner:pw@host:5432/db[?sslmode=require]`). Used by migrations and `prepare-database.js`. From your DB server or provider. |
| `APP_DB_ROLE` | R | — | Application role name (e.g. `sscrm_app`); must be NOBYPASSRLS. |
| `APP_DB_PASSWORD` | C | — | App role password (URL-safe: `openssl rand -hex 24`). Required unless `DATABASE_URL` is set; `prepare-database.js` creates the role with it if missing. |
| `DATABASE_URL` | O | derived | Explicit app-role connection string. |
| `DATABASE_DIRECT_URL` | O | `DATABASE_URL` | Non-pooled connection for pg-boss/LISTEN when `DATABASE_URL` is a PgBouncer pool. |
| `DB_POOL_MAX` | O | `10` | App connection pool size per process. |

Docker Compose (`infrastructure/docker`) additionally uses `POSTGRES_SUPERUSER_PASSWORD`,
`SSCRM_OWNER_PASSWORD`, `SSCRM_APP_PASSWORD` (URL-safe random values), `SSCRM_DB_NAME` (`sscrm`),
`APP_BIND` (`127.0.0.1`), `APP_PORT` (`3000`) and `TLS_CERT_DIR` (Nginx certificates); it builds the
database URLs itself.

## Secrets and encryption

| Variable | Req. | Purpose / how to generate |
|---|---|---|
| `APP_ENCRYPTION_KEYS` | R | Key ring for channel credentials: `k1:<openssl rand -base64 32>[,k0:<older key>]`. **Back it up outside the server.** Losing it makes stored channel tokens unreadable (companies reconnect channels; no other data is affected). |
| `APP_ENCRYPTION_PRIMARY_KEY_ID` | C | Id in the ring used for new values (e.g. `k1`). Defaults to the first id. |
| `APP_ENCRYPTION_KEY` | O | Single base64 key used as id `k1` when `APP_ENCRYPTION_KEYS` is empty (also reads legacy v1 values). |
| `WEBHOOK_SECRET_KEY` | C | Required in production when any channel provider is enabled; 32+ chars (`openssl rand -base64 32`). Derives per-channel Telegram webhook secrets and signs media links and OAuth state. Changing it invalidates Telegram webhooks until each bot is reconnected. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | O | Create the first Super Admin at start **only if none exists** (password ≥ 12 chars). Remove after first sign-in. Alternative: `npm run platform:admin -- --email … --name …`. |

## Sessions and rate limits

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_TTL_HOURS` | `12` | Workspace session lifetime. |
| `PLATFORM_SESSION_TTL_HOURS` | `4` | Super Admin session lifetime. |
| `LOGIN_RATE_LIMIT` | `10` | Failed sign-in attempts per 15 min. |
| `API_RATE_LIMIT_PER_MINUTE` | `600` | `/api` requests per minute per client IP. |

## Files

| Variable | Req. | Default | Purpose |
|---|---|---|---|
| `UPLOADS_DIR` | R* | `./uploads` | Logos/favicons (public at `/uploads`). *Must be on persistent storage. |
| `MEDIA_DRIVER` | O | `local` | `local` or `s3` for message attachments. |
| `MEDIA_DIR` | O | `<UPLOADS_DIR>-media` | Private attachment directory (persistent storage). |
| `MEDIA_MAX_BYTES` | O | `10485760` | Max attachment size. |
| `MEDIA_S3_BUCKET` | C | — | Required when `MEDIA_DRIVER=s3`. |
| `MEDIA_S3_REGION` | O | `auto` | Provider region. |
| `MEDIA_S3_ENDPOINT` | C | — | Endpoint for non-AWS providers (R2, B2, MinIO, Spaces…). |
| `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY` | C | — | Bucket-scoped credentials from the storage provider. |
| `MEDIA_S3_FORCE_PATH_STYLE` | O | `true` | Path-style addressing (most S3-compatible services). |

## Email

| Variable | Default | Purpose |
|---|---|---|
| `MAIL_DRIVER` | `smtp` if `SMTP_HOST` set, else `none` | Without email, invitation/reset links are shown once to the admin to share. |
| `MAIL_FROM` | — | Sender address. |
| `SMTP_HOST`, `SMTP_PORT` (`587`), `SMTP_SECURE` (`false`), `SMTP_USER`, `SMTP_PASSWORD` | — | From your email provider. |

## Background jobs and real-time

| Variable | Default | Purpose |
|---|---|---|
| `JOBS_ENABLED` | `true` | Disable only for debugging (webhooks/sends will then wait). |
| `JOBS_SCHEMA` | `pgboss` | Must match the migration-created schema. |
| `JOBS_POLLING_INTERVAL_SECONDS` | `2` | Worker polling interval. |
| `JOBS_POOL_MAX` | `4` | pg-boss connections. |
| `JOBS_BATCH_SIZE` | `10` | Jobs fetched per poll. |
| `MESSAGE_SEND_MAX_ATTEMPTS` | `5` | Attempts before an outbound message is marked failed. |
| `MESSAGE_SEND_RETRY_DELAY_SECONDS` | `10` | Base retry delay (exponential backoff, max 4 min). |
| `REALTIME_ENABLED` | `true` | Socket.IO on/off. |
| `REALTIME_ADAPTER` | `none` | `postgres` when running several web instances. |
| `REALTIME_REVALIDATE_SECONDS` | `60` | How often open sockets re-check their session. |

## Webhooks and channels

| Variable | Default | Purpose |
|---|---|---|
| `CHANNEL_PROVIDERS` | empty | `telegram,messenger,instagram,whatsapp` — enable only providers whose external setup is done. |
| `WEBHOOK_BODY_LIMIT` | `1mb` | Max webhook body. |
| `WEBHOOK_MAX_ATTEMPTS` | `5` | Processing attempts per event. |
| `WEBHOOK_RETRY_DELAY_SECONDS` | `30` | Base retry delay. |
| `WEBHOOK_RETENTION_DAYS` | `30` | Processed events kept this long. |
| `WEBHOOK_RATE_LIMIT_PER_MINUTE` | `1200` | Per-IP webhook rate limit. |
| `META_APP_ID`, `META_APP_SECRET` | — | Meta app (developers.facebook.com) — Messenger/WhatsApp, webhook signatures. |
| `META_VERIFY_TOKEN` | — | Random string you also enter in Meta's webhook settings. |
| `META_GRAPH_VERSION` | `v24.0` | Graph API version. |
| `META_IG_APP_ID`, `META_IG_APP_SECRET` | — | Instagram API with Instagram Login (Meta app → Instagram). |
| `META_WA_CONFIG_ID` | — | WhatsApp Embedded Signup config (Tech Provider only); empty keeps it disabled. |

Telegram needs no server variable: each company pastes its own bot token in the UI.

## Development / test only

`FAKE_PROVIDER_SECRET` (enables the `fake` provider; refused in production), `TELEGRAM_API_BASE`,
`META_GRAPH_BASE`, `META_IG_GRAPH_BASE`, `META_IG_API_BASE` (mock servers; ignored in production),
`TEST_DATABASE_URL`, `TEST_DATABASE_MIGRATION_URL`, `TEST_APP_DB_ROLE` (integration tests),
`PASSWORD` (non-interactive password for the CLI scripts), `RENDER_EXTERNAL_URL` (set by Render).
