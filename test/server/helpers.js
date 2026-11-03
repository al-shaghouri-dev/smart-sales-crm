const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knexFactory = require('knex');
const request = require('supertest');
const { createApp } = require('../../server/app');
const { createDb } = require('../../server/db');
const { createCompany } = require('../../server/services/companies');
const { hashPassword } = require('../../server/security/passwords');

/*
 * Integration tests need two connection strings to the same throwaway database:
 *   TEST_DATABASE_MIGRATION_URL – schema owner (runs migrations, truncates between tests)
 *   TEST_DATABASE_URL           – application role WITHOUT BYPASSRLS (what the app uses)
 * and TEST_APP_DB_ROLE = name of that application role.
 */
const OWNER_URL = process.env.TEST_DATABASE_MIGRATION_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const enabled = Boolean(OWNER_URL && APP_URL);
const PASSWORD = 'Correct-Horse-9';

let owner, db;

async function setupDatabase() {
  owner = knexFactory({ client: 'pg', connection: OWNER_URL, migrations: { directory: path.join(__dirname, '..', '..', 'db', 'migrations') } });
  process.env.APP_DB_ROLE = process.env.TEST_APP_DB_ROLE || 'sscrm_app';
  await owner.migrate.rollback(undefined, true);
  await owner.migrate.latest();
  db = createDb(APP_URL);
  return db;
}

async function resetDatabase() {
  await owner.raw('TRUNCATE audit_logs, sessions, company_memberships, role_permissions, roles, company_settings, company_branding, companies, users RESTART IDENTITY CASCADE');
  await owner.transaction(async trx => {
    await trx.raw("SELECT set_config('app.platform_admin', 'on', true)");
    await trx('platform_settings').where({ id: 1 }).update({ app_name: 'Smart Sales CRM', logo_url: null, primary_color: '#4f46e5' });
  });
}

async function teardown() {
  await db?.knex.destroy();
  await owner?.destroy();
}

function makeApp(extra = {}) {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-up-'));
  return createApp({ env: 'test', isProd: false, uploadsDir, sessionTtlHours: 1, loginRateLimit: extra.loginRateLimit || 1000, databaseUrl: APP_URL }, { db, apiRateLimit: 100000 });
}

async function createCompanyFixture(name, ownerEmail, opts = {}) {
  return db.withContext({ platformAdmin: true }, trx => createCompany(trx, null, {
    name, ownerEmail, ownerName: `${name} Owner`, ownerPassword: PASSWORD, status: opts.status || 'active'
  }));
}

/** Add a member with a given system role key directly (bypasses API checks — fixture only). */
async function addMember(companyId, roleKey, email) {
  return db.withContext({ companyId }, async trx => {
    const role = await trx('roles').where({ company_id: companyId, key: roleKey }).first();
    const userId = crypto.randomUUID();
    await trx('users').insert({ id: userId, email, name: email.split('@')[0], password_hash: await hashPassword(PASSWORD) });
    const id = crypto.randomUUID();
    await trx('company_memberships').insert({ id, company_id: companyId, user_id: userId, role_id: role.id });
    return { userId, membershipId: id };
  });
}

async function createPlatformAdmin(email) {
  const id = crypto.randomUUID();
  await db.withContext({ platformAdmin: true }, async trx => {
    await trx('users').insert({ id, email, name: 'Platform Admin', password_hash: await hashPassword(PASSWORD), is_platform_admin: true });
  });
  return id;
}

async function login(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await agent.get('/api/auth/me');
  return { agent, csrf: me.body.csrfToken, me: me.body };
}

module.exports = {
  enabled, PASSWORD, setupDatabase, resetDatabase, teardown, makeApp, createCompanyFixture, addMember, createPlatformAdmin, login,
  getDb: () => db, getOwner: () => owner
};
