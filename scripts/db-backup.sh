#!/usr/bin/env bash
# Logical backup of the Smart Sales CRM database (no superuser needed).
#
#   DATABASE_MIGRATION_URL=postgres://<owner>:<pw>@<host>:5432/<db> scripts/db-backup.sh backup-2026-11-06.dump
#
# Why the options:
#  - Every tenant table uses FORCE ROW LEVEL SECURITY, which also binds the schema owner, so a plain
#    pg_dump would fail. The dump runs WITH row security and the platform-admin setting, which the
#    tenant policies allow to read every row (same rule the Super Admin API uses).
#  - The "pgboss" schema holds transient job rows owned by the application role; it is excluded.
#    pg-boss recreates its tables at start-up (db-restore.sh recreates the empty schema).
#  - Encryption keys are NOT in the database: back up APP_ENCRYPTION_KEYS separately and securely,
#    otherwise restored channel credentials cannot be decrypted (companies would reconnect channels).
set -euo pipefail
OUT="${1:?usage: db-backup.sh <output.dump>}"
URL="${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (schema owner connection)}"
PGOPTIONS="-c app.platform_admin=on" pg_dump --format=custom --enable-row-security --exclude-schema=pgboss --no-owner --file="$OUT" "$URL"
echo "Backup written to $OUT ($(du -h "$OUT" | cut -f1))."
