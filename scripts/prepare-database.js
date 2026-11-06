#!/usr/bin/env node
/*
 * Idempotent database preparation for a fresh host (e.g. Render). Runs before every start:
 *   1. connects as the schema owner (DATABASE_MIGRATION_URL — on Render: the database's own user);
 *   2. creates the application role APP_DB_ROLE if missing, with APP_DB_PASSWORD, and enforces
 *      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE (so Row Level Security always applies);
 *   3. lets it connect and use the public schema;
 *   4. runs pending migrations (which grant table privileges to APP_DB_ROLE).
 * Never prints passwords or connection strings.
 */
const knexFactory = require('knex');
const path = require('path');

(async () => {
  const url = process.env.DATABASE_MIGRATION_URL;
  const role = process.env.APP_DB_ROLE;
  const password = process.env.APP_DB_PASSWORD;
  if (!url || !role) { console.error('DATABASE_MIGRATION_URL and APP_DB_ROLE are required'); process.exit(1); }
  if (!/^[a-z_][a-z0-9_]{1,40}$/.test(role)) { console.error('APP_DB_ROLE must be a simple lowercase identifier'); process.exit(1); }
  const ssl = /sslmode=require|render\.com|neon\.tech|supabase/.test(url) ? { rejectUnauthorized: false } : undefined;
  const knex = knexFactory({ client: 'pg', connection: ssl ? { connectionString: url, ssl } : url, migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') } });
  try {
    const exists = (await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [role])).rows.length > 0;
    if (!exists) {
      if (!password || password.length < 16) throw new Error('APP_DB_PASSWORD (16+ characters) is required to create the application role');
      await knex.raw(`CREATE ROLE ?? LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, [role]);
      console.log(`Created application role ${role}.`);
    } else if (password) {
      await knex.raw(`ALTER ROLE ?? WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`, [role]);
    }
    const flags = (await knex.raw('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ?', [role])).rows[0];
    if (flags.rolsuper || flags.rolbypassrls) throw new Error(`Role ${role} must not be SUPERUSER or BYPASSRLS (Row Level Security would not apply)`);
    const db = (await knex.raw('SELECT current_database() AS d')).rows[0].d;
    await knex.raw('GRANT CONNECT ON DATABASE ?? TO ??', [db, role]);
    await knex.raw('GRANT USAGE ON SCHEMA public TO ??', [role]);
    process.env.APP_DB_ROLE = role;
    const [batch, list] = await knex.migrate.latest();
    console.log(list.length ? `Applied ${list.length} migration(s) (batch ${batch}).` : 'Database schema is up to date.');
  } catch (error) {
    console.error('Database preparation failed:', error.message.replace(/postgres(ql)?:\/\/\S+/g, '[url]'));
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
