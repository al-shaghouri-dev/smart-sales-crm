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
const { Client } = require('pg');
const { normalizePgUrl } = require('../server/db-url');

/** True when the application role can already sign in with this password. */
async function canLogin(ownerUrl, role, password, ssl) {
  const u = new URL(ownerUrl);
  u.username = role;
  u.password = password;
  const client = new Client(ssl ? { connectionString: u.toString(), ssl } : { connectionString: u.toString() });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => {}); }
}

/**
 * One-time Super Admin bootstrap for hosts without a shell (e.g. Render's free plan).
 * Runs only when BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are set AND no platform admin
 * exists yet; otherwise it does nothing (it never changes an existing account). After the first
 * sign-in, change the password in "My account" and delete both variables from the host.
 */
async function bootstrapPlatformAdmin(knex) {
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!email || !password) return;
  const { hashPassword, validatePassword, MIN_LENGTH } = require('../server/security/passwords');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email address');
  if (!validatePassword(password)) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD must be at least ${MIN_LENGTH} characters`);
  await knex.transaction(async trx => {
    await trx.raw("SELECT set_config('app.platform_admin', 'on', true)");
    const admins = await trx('users').where({ is_platform_admin: true }).count('* as n').first();
    if (Number(admins.n) > 0) { console.log('Bootstrap admin skipped: a platform admin already exists (remove the BOOTSTRAP_ADMIN_* variables).'); return; }
    const taken = await trx('users').where({ email }).first('id');
    if (taken) throw new Error('BOOTSTRAP_ADMIN_EMAIL belongs to an existing user; choose another address');
    await trx('users').insert({ id: require('crypto').randomUUID(), email, name: 'Platform Admin', password_hash: await hashPassword(password), password_changed_at: trx.fn.now(), is_platform_admin: true });
    console.log('Bootstrap admin created. Sign in at /admin/login, change the password, then remove the BOOTSTRAP_ADMIN_* variables.');
  });
}

(async () => {
  const url = normalizePgUrl(process.env.DATABASE_MIGRATION_URL);
  const role = process.env.APP_DB_ROLE;
  const password = process.env.APP_DB_PASSWORD;
  if (!url || !role) { console.error('DATABASE_MIGRATION_URL and APP_DB_ROLE are required'); process.exit(1); }
  if (!/^[a-z_][a-z0-9_]{1,40}$/.test(role)) { console.error('APP_DB_ROLE must be a simple lowercase identifier'); process.exit(1); }
  // URLs with sslmode (Neon, Supabase) are handled by node-postgres with certificate verification;
  // Render's external URLs carry no sslmode but require TLS.
  const ssl = !/sslmode=/.test(url) && /render\.com/.test(url) ? { rejectUnauthorized: false } : undefined;
  const knex = knexFactory({ client: 'pg', connection: ssl ? { connectionString: url, ssl } : url, migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') } });
  try {
    const exists = (await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [role])).rows.length > 0;
    if (!exists) {
      if (!password || password.length < 16) throw new Error('APP_DB_PASSWORD (16+ characters) is required to create the application role');
      await knex.raw(`CREATE ROLE ?? LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, [role]);
      console.log(`Created application role ${role}.`);
    } else if (password && !(await canLogin(url, role, password, ssl))) {
      // Only when the stored password no longer matches (e.g. it was regenerated in the dashboard).
      await knex.raw(`ALTER ROLE ?? WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`, [role]);
      console.log(`Updated the password of ${role}.`);
    }
    const flags = (await knex.raw('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ?', [role])).rows[0];
    if (flags.rolsuper || flags.rolbypassrls) throw new Error(`Role ${role} must not be SUPERUSER or BYPASSRLS (Row Level Security would not apply)`);
    const db = (await knex.raw('SELECT current_database() AS d')).rows[0].d;
    await knex.raw('GRANT CONNECT ON DATABASE ?? TO ??', [db, role]);
    await knex.raw('GRANT USAGE ON SCHEMA public TO ??', [role]);
    process.env.APP_DB_ROLE = role;
    const [batch, list] = await knex.migrate.latest();
    console.log(list.length ? `Applied ${list.length} migration(s) (batch ${batch}).` : 'Database schema is up to date.');
    await bootstrapPlatformAdmin(knex);
  } catch (error) {
    let message = String(error.message || error).replace(/postgres(ql)?:\/\/\S+/g, '[url]').replace(/PASSWORD\s+'(?:[^']|'')*'/gi, "PASSWORD '[redacted]'");
    if (password) message = message.split(password).join('[redacted]');
    if (process.env.BOOTSTRAP_ADMIN_PASSWORD) message = message.split(process.env.BOOTSTRAP_ADMIN_PASSWORD).join('[redacted]');
    console.error('Database preparation failed:', message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
