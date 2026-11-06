# Maintenance and operations

Commands assume the Docker Compose stack (`C="docker compose -f infrastructure/docker/docker-compose.production.yml --env-file .env"`).
Without Docker, run the same `npm`/`node` commands in the application directory with the environment loaded.

## Updating the application

1. Back up the database (below).
2. `git pull` the release branch/tag (or unpack the new package).
3. `$C build` then `$C up -d` — the `migrate` service applies new migrations before `app` starts.
   Without Docker: `npm ci && npm run build && npm prune --omit=dev && npm run db:prepare`, then restart the service.
4. Check `curl -fsS https://<host>/api/ready` → `{"ok":true,…}` and sign in.

Migrations only move forward. Roll back by restoring the pre-update backup and the previous release.

## Health and monitoring

| Check | Meaning |
|---|---|
| `GET /api/health` | process alive (Docker HEALTHCHECK uses it) |
| `GET /api/ready` | database reachable, jobs started, not shutting down — use for load balancers/uptime monitors |
| Super Admin → Channels | channel status, errors, 24 h traffic, queue depth, token expiry |
| Super Admin → Webhook events (`/api/platform/webhook-events`) | failed provider events; retry button |

Alert on: `/api/ready` ≠ 200, disk usage of the uploads/media volume and PostgreSQL, growing `messages`
in status `queued`, channels in `needs_reconnect`.

## Logs

- The app logs to **stdout/stderr** only (no log files): start-up, job failures (`[jobs]`, `[messaging]`,
  `[webhooks]`, `[channels]`), unexpected errors (`[error] METHOD /path` with token-like URL segments redacted).
  Request bodies, passwords and tokens are never logged.
- Docker: `$C logs -f app` (rotation configured: 5 × 20 MB per container). systemd: `journalctl -u smart-sales-crm -f`.
- Security-relevant business events are in the database audit log (Company → Activity log, Super Admin → company Activity).

## Backups

| What | How | Frequency |
|---|---|---|
| PostgreSQL | `$C exec -T db pg_dump -U postgres -d sscrm --format=custom --exclude-schema=pgboss -f /backups/sscrm-$(date +%F).dump` (lands in `./backups`), or provider snapshots, or `npm run db:backup` (no superuser) | daily + before every update |
| Uploads + media | archive the `appdata` volume (`docker run --rm -v smart-sales-crm_appdata:/data -v $PWD/backups:/b alpine tar czf /b/files-$(date +%F).tgz -C /data .`) or rely on S3 versioning | daily |
| Secrets | `.env` / secret manager, especially `APP_ENCRYPTION_KEYS` | on every change, stored offline |

Copy backups off the server (object storage with lifecycle rules). Test a restore at least monthly —
procedure in DATABASE.md §7.

## Encryption key rotation

1. `openssl rand -base64 32` → add as a new id in front: `APP_ENCRYPTION_KEYS=k2:<new>,k1:<old>`,
   `APP_ENCRYPTION_PRIMARY_KEY_ID=k2`; restart.
2. `npm run secrets:rotate -- --dry-run` then `npm run secrets:rotate` (Docker: `$C run --rm migrate node scripts/rotate-encryption-keys.js`).
3. When it reports 0 remaining, remove `k1` and restart. Tested end-to-end.

## Routine tasks

| Task | Command |
|---|---|
| Create a Super Admin | `npm run platform:admin -- --email a@b.c --name "Name"` (Docker: `$C run --rm migrate node scripts/create-platform-admin.js --email … --name …`) |
| Create a company from the CLI | `npm run company:create -- --name "Co" --owner-email o@b.c --owner-name "Owner"` |
| Run subscription maintenance now | `npm run jobs:subscriptions` |
| Load test (staging only, fake provider) | `node scripts/load-test.js --help` (see the file header) |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| App exits at start with "… is required in production" | missing `APP_ENCRYPTION_KEYS`, `WEBHOOK_SECRET_KEY` (with channels), or non-https `PUBLIC_URL` with channels enabled |
| `Database preparation failed: … permission denied to create role` | owner lacks CREATEROLE: create `APP_DB_ROLE` manually (DATABASE.md §2) |
| `Role … must not be SUPERUSER or BYPASSRLS` | the app role is privileged — create a restricted role |
| `/api/ready` → `jobs:false` | pg-boss could not start: check `DATABASE_DIRECT_URL` (no transaction pooler), `pgboss` schema grants |
| Login works but every write returns 403 `auth.csrf` | proxy strips headers, or the frontend is served from another origin; keep one origin |
| Socket.IO keeps reconnecting | proxy lacks WebSocket upgrade (see Nginx config) or `REALTIME_ALLOWED_ORIGINS` misses the public origin |
| Wrong client IPs / everyone rate-limited together | `TRUST_PROXY` does not match the number of proxies |
| Attachments 404 after restart | uploads/media not on persistent storage — mount a volume or use `MEDIA_DRIVER=s3` |
| Channel shows `needs_reconnect` | token revoked/expired: Company → Channels → Reconnect |
| Webhooks rejected (401) | wrong `META_APP_SECRET` / `META_IG_APP_SECRET`, or `WEBHOOK_SECRET_KEY` changed (reconnect Telegram bots) |
| `pg_dump: … row-level security` | dump as superuser or use `npm run db:backup` (DATABASE.md §7) |
