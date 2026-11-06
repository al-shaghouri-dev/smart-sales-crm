# Deployment checklist

Tick each item during the deployment. References point to the documentation set.

## 1. Preparation
- [ ] Source checked out at branch `saas/phase-0-1-clean` (or the agreed tag); commit hash recorded: ________
- [ ] Domain chosen: ________ ; DNS A/AAAA record points to the server / load balancer
- [ ] TLS certificate available (certbot / provider) — HTTPS is mandatory
- [ ] Host: Docker Engine + Compose v2 (Docker path) **or** Node.js 22.12+ (systemd path)
- [ ] PostgreSQL 16 available (bundled container, own server or managed) with backups planned
- [ ] Persistent storage for `/data` (volume) or S3 bucket for attachments decided

## 2. Secrets (generate yourself; never reuse examples) — ENVIRONMENT.md
- [ ] `POSTGRES_SUPERUSER_PASSWORD`, `SSCRM_OWNER_PASSWORD`, `SSCRM_APP_PASSWORD` (`openssl rand -hex 24`) — Docker path
- [ ] or `DATABASE_MIGRATION_URL`, `APP_DB_ROLE`, `APP_DB_PASSWORD` — external PostgreSQL
- [ ] `APP_ENCRYPTION_KEYS=k1:<openssl rand -base64 32>` and `APP_ENCRYPTION_PRIMARY_KEY_ID=k1`
- [ ] Encryption key stored in the company password manager (offline copy)
- [ ] `WEBHOOK_SECRET_KEY` (`openssl rand -base64 32`)
- [ ] `.env` created from `.env.example`, `chmod 600`, not committed

## 3. Configuration
- [ ] `NODE_ENV=production`
- [ ] `APP_URL=https://<domain>` (and `PUBLIC_URL` only if different)
- [ ] `TRUST_PROXY` = number of proxies in front (1 with the bundled Nginx)
- [ ] `UPLOADS_DIR` / `MEDIA_DIR` on persistent storage, or `MEDIA_DRIVER=s3` + `MEDIA_S3_*`
- [ ] SMTP (`SMTP_*`, `MAIL_FROM`) configured, or admins informed that links are shown on screen
- [ ] `CHANNEL_PROVIDERS` lists only channels whose external setup is complete (can be empty at first)
- [ ] First admin: `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` **or** plan to run the CLI

## 4. Deploy — DEPLOYMENT.md Part A
- [ ] Docker: `docker compose -f infrastructure/docker/docker-compose.production.yml --env-file .env up -d --build`
- [ ] `migrate` service exited with code 0 ("Applied N migration(s)" or "up to date")
- [ ] `app` container is `healthy`
- [ ] Reverse proxy / Nginx profile running with TLS; HTTP redirects to HTTPS
- [ ] WebSocket upgrade enabled for `/socket.io/`; request body limit ≥ 12 MB
- [ ] PostgreSQL port **not** exposed publicly; app bound to localhost behind the proxy

## 5. Verify
- [ ] `https://<domain>/api/health` → `{"ok":true}`
- [ ] `https://<domain>/api/ready` → `"database":true,"jobs":true`
- [ ] Browser shows HSTS + CSP headers; no mixed-content warnings
- [ ] Super Admin sign-in at `/admin/login`; password changed in "My account"
- [ ] `BOOTSTRAP_ADMIN_*` removed and the app restarted
- [ ] Create a test company → owner invitation link works → owner signs in
- [ ] Add an employee; employee signs in and cannot open Team management
- [ ] Inbox page loads; the browser's real-time indicator connects (`html[data-realtime="connected"]`)
- [ ] Upload a company logo; it survives `docker compose restart app`
- [ ] Delete or suspend the test company when done

## 6. Operations — MAINTENANCE.md
- [ ] Daily database backup scheduled and copied off-server
- [ ] Files volume / bucket backup scheduled
- [ ] Restore tested once into a scratch database
- [ ] Uptime monitor on `/api/ready`; alerts to the operator
- [ ] Log retention confirmed (Docker rotation or journald)
- [ ] OS and Docker image update routine agreed

## 7. Channels (when credentials are available) — HANDOVER.md §5, META_APP_REVIEW.md
- [ ] Telegram: test bot connected from Company → Channels; message in/out verified
- [ ] Meta app: webhook callback `https://<domain>/webhooks/{messenger,instagram,whatsapp}` verified with `META_VERIFY_TOKEN`
- [ ] OAuth redirect URIs registered; Deauthorize / Data Deletion callbacks set
- [ ] Messenger / Instagram / WhatsApp each verified with a real test account before customers use them
