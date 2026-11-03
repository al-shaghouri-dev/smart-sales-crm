# Smart Sales CRM

Multi-tenant sales & customer-messaging CRM platform (Arabic / English).

**Status:** Phase 2 — Super Admin console, company management, plans & subscriptions (manual payments),
self-registration with approval, secure invitations & password reset — on top of the Phase 1 foundation
(multi-tenant PostgreSQL with Row Level Security, sessions, roles & permissions, branding, Arabic/English).
Inbox, customers, orders and messaging channels are being rebuilt in later phases; until then the
original prototype is kept runnable under `legacy/` (`npm run legacy`).

## Stack
Node.js + Express 5 · PostgreSQL 16 + Knex migrations · React 18 + Vite · i18next

```
server/        API (routes, session/permission middleware, services)
db/migrations/ Knex migrations (schema + RLS policies)
web/           React frontend (locales in web/src/locales/{ar,en}.json)
scripts/       CLI: create platform admin, create company
test/          API/RLS integration tests (real PostgreSQL) + frontend unit tests
legacy/        Original single-workspace prototype (Phase 0 hardened)
```

## Local setup

```bash
cp .env.example .env            # then edit passwords / keys
docker compose up -d            # PostgreSQL with owner + app roles (docker/postgres/init.sh)
npm install
npm run migrate                 # runs as DATABASE_MIGRATION_URL (schema owner)
npm run platform:admin -- --email you@example.com --name "Your Name"     # prompts for password
npm run company:create -- --name "Acme" --owner-email owner@acme.com --owner-name "Owner Name"   # optional; the admin console can do this
npm run dev                     # API on :3000
npm run dev:web                 # UI on :5173 (proxies /api)
```

Production: `npm run build && npm start` (Express serves `dist/web`). Set `NODE_ENV=production`,
`APP_ENCRYPTION_KEY`, and `TRUST_PROXY=true` behind a proxy. There are **no default accounts**.

## Areas
- `/admin/login` → **Super Admin console** (separate session; companies, registrations, plans, subscriptions, payments, platform settings)
- `/login` → **company workspace**; `/register` → self-service registration (approval required)
- `/invite/:token`, `/reset-password/:token` → one-time links (invitations expire after 7 days, resets after 1 hour)

## Subscriptions
Plans (monthly / yearly / custom days) are managed in the console. Payments are confirmed manually and can extend the
subscription. An hourly job (`npm run jobs:subscriptions` to run it once) expires overdue subscriptions and notifies
owners 7 and 1 days before expiry. Expired or suspended subscriptions switch the workspace to read-only or billing-only
(platform setting). **Company data is never deleted by subscription changes.**

## Security model
- **Two database roles.** Migrations run as the schema owner; the app connects as `APP_DB_ROLE`
  (no superuser, no BYPASSRLS). Every tenant table has `FORCE ROW LEVEL SECURITY`.
- **Tenant context per transaction** (`server/db.js → withContext`) sets `app.company_id` / `app.user_id`
  with `SET LOCAL` semantics; routes also filter by `company_id` explicitly (defence in depth).
- Platform-wide access (`app.platform_admin`) is enabled only inside `/api/platform` handlers.
- Sessions: random token in an httpOnly SameSite cookie, stored hashed in `sessions`; CSRF token required for writes.
- Permissions are checked server-side (`requirePermission`); members cannot grant permissions they lack,
  edit their own role, or manage owners; a company admin cannot change credentials of an account shared with another company.
- Audit log (`audit_logs`) records sensitive actions; secrets are redacted.

## Tests

```bash
# needs a throwaway database; see TEST_* in .env.example
npm test
```

## Localization
Language on first visit follows the device (`ar*` → Arabic RTL, `en*` → English LTR, otherwise the platform default).
A manual choice is saved on the device and on the account and is never overridden by detection.
Add a language: create `web/src/locales/<code>.json`, register it in `web/src/lib/i18n.js` and `SUPPORTED_LOCALES`.
