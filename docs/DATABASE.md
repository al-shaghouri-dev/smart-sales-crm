# Database

PostgreSQL **16** (14+ works). One database holds the application schema (`public`) and the job queue
(`pgboss`). Schema changes are made only through **Knex migrations** in `db/migrations/`.

## 1. Roles

| Role | Purpose | Required attributes |
|---|---|---|
| schema owner (e.g. `sscrm_owner`) | owns tables, runs migrations, creates the `citext` extension | owner of the database; `CREATEROLE` only if `prepare-database.js` must create the app role |
| application role (`APP_DB_ROLE`, e.g. `sscrm_app`) | every request of the running app | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` |

The application role receives table privileges from the migrations (`APP_DB_ROLE` must be set when they
run) and `USAGE, CREATE` on schema `pgboss` only (pg-boss installs its own tables at start-up).
`scripts/prepare-database.js` refuses to continue if the app role is SUPERUSER or BYPASSRLS.

## 2. Creating a database

**With the bundled Docker Compose** (`infrastructure/docker`): the PostgreSQL container runs
`postgres-init.sh` on first start and creates both roles and the database; the `migrate` service applies
migrations. Nothing else is needed.

**On any PostgreSQL server** (as a superuser / admin):

```sql
CREATE ROLE sscrm_owner LOGIN PASSWORD '<owner-password>';
CREATE ROLE sscrm_app   LOGIN PASSWORD '<app-password>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE sscrm OWNER sscrm_owner;
REVOKE ALL ON DATABASE sscrm FROM PUBLIC;
GRANT CONNECT ON DATABASE sscrm TO sscrm_app;
```

**Managed PostgreSQL** (RDS, Cloud SQL, Azure, Neon, Render, …): use the provider's admin user as the
schema owner (`DATABASE_MIGRATION_URL`) and let `prepare-database.js` create `sscrm_app` (the admin user
needs `CREATEROLE`, which managed providers normally grant). Use the direct (non-pooled) endpoint.

## 3. Migrations

| Command | Effect |
|---|---|
| `npm run db:prepare` | create/verify the app role (with `APP_DB_PASSWORD`), grant CONNECT/USAGE, apply pending migrations, optional bootstrap admin. Idempotent; also run on every start by `npm run start:render`, the Docker `migrate` service and the systemd unit. |
| `npm run migrate` | apply pending migrations only (`knexfile.js`, uses `DATABASE_MIGRATION_URL`; set `APP_DB_ROLE`) |
| `npm run migrate:rollback` | undo the last batch (development / emergency only — never on production data without a backup) |

Migrations in order:

| File | Adds |
|---|---|
| `20261103000001_foundation.js` | `citext` extension, tenant context functions, platform settings, users, companies, company settings/branding, permission catalog (seeded), roles, role permissions, memberships, sessions, audit log, RLS policies, auth helper functions |
| `20261103000002_phase2_platform.js` | plans, subscriptions, payments, registration requests, auth tokens (invitations/reset), notifications, platform guards |
| `20261103095500_phase3_1_infrastructure.js` | `pgboss` schema + grants, `webhook_events`, `socket_io_attachments`, system context |
| `20261103132820_phase3_2_messaging.js` | channels, channel credentials, contacts, contact identities, conversations, assignment history, messages, outbox helpers, plan `allowed_providers`, company outbound controls |
| `20261106050814_phase3_4_meta.js` | OAuth sessions, Meta data-deletion log, `messages.template`, Meta user lookup |
| `20261106051818_phase3_7_channel_ops.js` | channel maintenance lookup, system channel-alert notification policy |

Migration filenames are validated by `test/migrations.test.js` (no future dates). Never edit a migration
that has been applied anywhere; add a new one.

## 4. Tables

| Table | RLS | Description |
|---|---|---|
| `platform_settings` | ✓ | single row: platform branding, registration, expired-subscription policy |
| `users` | ✓ | accounts (email `citext`, scrypt hash, `is_platform_admin`, locale/theme) |
| `companies` | ✓ | tenants (status active/pending/suspended, outbound kill switch, daily cap) |
| `company_settings`, `company_branding` | ✓ | per-company settings (quick replies, tax…), branding |
| `permissions` | — | permission catalog (22 keys, seeded) |
| `roles`, `role_permissions` | ✓ | per-company roles (system roles owner/admin/manager/supervisor/employee + custom) |
| `company_memberships` | ✓ | user ↔ company with role and status |
| `sessions` | — | hashed session tokens (accessed only by hash) |
| `auth_tokens` | — | hashed invitation / password-reset tokens |
| `audit_logs` | ✓ | security-relevant actions (secrets scrubbed) |
| `plans`, `subscriptions`, `payments` | ✓ | plans with limits/features, one subscription per company, manual payments |
| `registration_requests` | ✓ | self-registration awaiting Super Admin approval |
| `notifications` | ✓ | in-app notifications (subscription, channel alerts) |
| `webhook_events` | ✓ | raw provider events (dedupe, attempts, status) |
| `socket_io_attachments` | — | Socket.IO Postgres adapter payloads (multi-instance only) |
| `channels`, `channel_credentials` | ✓ | connected accounts; credentials encrypted (AES-256-GCM) |
| `contacts`, `contact_identities` | ✓ | customers and their per-channel identities (no automatic merging) |
| `conversations`, `conversation_assignments` | ✓ | inbox threads and assignment history |
| `messages` | ✓ | inbound/outbound messages, attachments (metadata + storage key), status, template |
| `channel_oauth_sessions` | ✓ | short-lived encrypted OAuth results (visible to the starting user only) |
| `meta_data_deletions` | ✓ | Meta data-deletion confirmation codes |
| `knex_migrations*` | — | migration bookkeeping |

30 tables, 24 with `FORCE ROW LEVEL SECURITY`, 45 policies. Full DDL with indexes, constraints and
foreign keys: `db/schema.sql` (generated; contains no data).

## 5. Required extension

`citext` (trusted extension; created by the first migration as the database owner). UUIDs use the
built-in `gen_random_uuid()` (PostgreSQL 13+).

## 6. Connections

- `DATABASE_MIGRATION_URL` — owner, migrations only.
- `DATABASE_URL` — app role; if unset it is derived from the owner URL + `APP_DB_ROLE`/`APP_DB_PASSWORD`.
- `DATABASE_DIRECT_URL` — session-pinned connection for pg-boss and LISTEN/NOTIFY when `DATABASE_URL`
  is a transaction-mode pooler (PgBouncer). Managed TLS: append `?sslmode=require`.
- Pool sizes: `DB_POOL_MAX` (app, default 10) + `JOBS_POOL_MAX` (pg-boss, default 4) per process.

## 7. Backup and restore

FORCE RLS binds even the table owner, so a plain `pg_dump` as the owner fails. Options:

1. **Superuser / provider snapshots** (simplest): managed snapshots, or `pg_dump` as a superuser
   (superusers bypass RLS). Docker Compose:
   `docker compose -f infrastructure/docker/docker-compose.production.yml exec -T db pg_dump -U postgres -d sscrm --format=custom --exclude-schema=pgboss -f /backups/sscrm-$(date +%F).dump`
   (files appear in `./backups` on the host).
2. **Without superuser**: `DATABASE_MIGRATION_URL=… npm run db:backup -- file.dump` (dumps with the
   platform-admin context that the policies allow).

Restore into an **empty** database:
- as superuser: `pg_restore -U postgres -d <newdb> --exit-on-error file.dump`, then
  `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION sscrm_owner; GRANT USAGE, CREATE ON SCHEMA pgboss TO sscrm_app;`
- without superuser: `DATABASE_MIGRATION_URL=<new db> APP_DB_ROLE=sscrm_app npm run db:restore -- file.dump`.

Then start the app (pg-boss recreates its tables) and run `npm run migrate` — it must report "Already up
to date". Both paths were tested (identical row counts, login, inbox, credential decryption).
**Encryption keys are not in the database**: keep `APP_ENCRYPTION_KEYS` with the backups' secrets, separately.

## 8. Data protection

No customer data is shipped with this project. Personal data stored: account names/emails/phones,
customer names and channel identifiers, message contents and attachments. Retention: processed webhook
payloads are deleted after `WEBHOOK_RETENTION_DAYS` (30); other data is kept until deleted by the company
or the platform operator.
