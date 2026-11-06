#!/usr/bin/env bash
# Restore a db-backup.sh dump into an EMPTY database owned by the schema owner role.
#
#   DATABASE_MIGRATION_URL=postgres://<owner>:<pw>@<host>:5432/<new_db> APP_DB_ROLE=sscrm_app scripts/db-restore.sh backup.dump
#
# Steps: schema (pre-data) → FORCE RLS temporarily off so the owner can load rows → data →
# FORCE RLS back on → indexes/constraints/policies (post-data) → pgboss schema + grants for the app role.
# Verify afterwards with: npm run migrate (should report "Already up to date") and a login.
set -euo pipefail
IN="${1:?usage: db-restore.sh <backup.dump>}"
URL="${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (schema owner connection to the empty target database)}"
APP_ROLE="${APP_DB_ROLE:?set APP_DB_ROLE (application role, e.g. sscrm_app)}"
pg_restore --exit-on-error --no-owner --section=pre-data -d "$URL" "$IN"
FORCED=$(psql "$URL" -Atc "SELECT string_agg(format('%I.%I', n.nspname, c.relname), ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relforcerowsecurity")
for t in ${FORCED//,/ }; do psql "$URL" -qc "ALTER TABLE $t NO FORCE ROW LEVEL SECURITY"; done
pg_restore --exit-on-error --no-owner --section=data -d "$URL" "$IN"
for t in ${FORCED//,/ }; do psql "$URL" -qc "ALTER TABLE $t FORCE ROW LEVEL SECURITY"; done
pg_restore --exit-on-error --no-owner --section=post-data -d "$URL" "$IN"
psql "$URL" -v ON_ERROR_STOP=1 -q <<SQL
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO "$APP_ROLE";
GRANT USAGE ON SCHEMA public TO "$APP_ROLE";
SQL
echo "Restore complete. Tables with FORCE RLS restored: $(echo "$FORCED" | tr ',' '\n' | grep -c . || true)"
