# Smart Sales CRM

Multi-tenant sales & customer-messaging CRM platform (Arabic / English) by **WASL Technologies**.

A Super Admin runs the platform (companies, plans, subscriptions, registrations, channel monitoring);
each company gets its own team, roles & permissions, branding, a unified inbox and messaging channels
(Telegram, Messenger, Instagram, WhatsApp Cloud API).

## Stack

Node.js 22 · Express 5 · PostgreSQL 16 (Row Level Security) · Knex migrations · pg-boss (jobs in PostgreSQL) ·
Socket.IO · React 18 + Vite · i18next (RTL/LTR)

```
server/            API, Socket.IO, background jobs, channel adapters, security
web/               React frontend (locales in web/src/locales/{ar,en}.json)
db/migrations/     Knex migrations (schema, RLS policies, seed rows); db/schema.sql = generated reference
scripts/           database preparation, admin/company CLI, backup/restore, key rotation, load test
infrastructure/    Docker Compose (production), PostgreSQL init, Nginx, systemd
Dockerfile         production image (API + frontend + jobs)
docs/              documentation (see below)
test/              integration tests (real PostgreSQL) + frontend unit tests
legacy/            original single-company prototype — reference only, not deployed
```

## Quick start (production, Docker)

```bash
cp .env.example .env            # fill in (docs/ENVIRONMENT.md)
docker compose -f infrastructure/docker/docker-compose.production.yml --env-file .env up -d --build
curl -fsS http://127.0.0.1:3000/api/ready
```

Then put TLS in front (Nginx profile or your proxy) and sign in at `/admin/login`.
Full instructions: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Development

```bash
npm install
docker compose up -d            # development PostgreSQL (roles sscrm_owner / sscrm_app)
cp .env.example .env            # set NODE_ENV=development, DATABASE_URL / DATABASE_MIGRATION_URL for localhost
npm run migrate
npm run platform:admin -- --email you@example.com --name "Your Name"
npm run dev                     # API on :3000
npm run dev:web                 # Vite on :5173
npm test                        # needs TEST_DATABASE_* (see .env.example)
```

## Documentation

| Document | Contents |
|---|---|
| [HANDOVER](docs/HANDOVER.md) | start here: status, requirements, external services |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | components, request flow, multi-tenancy, jobs, real-time |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Docker, systemd, container platforms, Render/Vercel |
| [DATABASE](docs/DATABASE.md) | roles, migrations, tables, backup & restore |
| [ENVIRONMENT](docs/ENVIRONMENT.md) | every environment variable |
| [API_DOCUMENTATION](docs/API_DOCUMENTATION.md) | REST endpoints, auth, errors |
| [MAINTENANCE](docs/MAINTENANCE.md) | updates, logs, backups, key rotation, troubleshooting |
| [SECURITY](docs/SECURITY.md) | OWASP review and controls |
| [META_APP_REVIEW](docs/META_APP_REVIEW.md) | Meta app and App Review preparation |

## Ownership

Owned by WASL Technologies. No open-source license is included; use is governed by the owner's agreements.
