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
const { createMailer } = require('../../server/services/mailer');
const { createKeyRing } = require('../../server/security/secrets');

/** Test-only encryption keys (random per run; never used outside tests). */
const TEST_KEY = crypto.randomBytes(32).toString('base64');
const TEST_KEY_RING = createKeyRing({ keys: { t1: TEST_KEY }, primaryKeyId: 't1' });

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
  await owner.raw('TRUNCATE messages, conversation_assignments, conversations, contact_identities, contacts, channel_credentials, channels, webhook_events, socket_io_attachments, notifications, auth_tokens, payments, subscriptions, registration_requests, plans, audit_logs, sessions, company_memberships, role_permissions, roles, company_settings, company_branding, companies, users RESTART IDENTITY CASCADE');
  // pg-boss tables are owned by the application role (it installs them at start-up).
  await db.knex.raw(`DO $$ BEGIN IF to_regclass('pgboss.job') IS NOT NULL THEN DELETE FROM pgboss.job; END IF; END $$`);
  await owner.transaction(async trx => {
    await trx.raw("SELECT set_config('app.platform_admin', 'on', true)");
    await trx('platform_settings').where({ id: 1 }).update({ app_name: 'Smart Sales CRM', logo_url: null, primary_color: '#4f46e5', expired_access_policy: 'read_only', registration_enabled: true });
  });
}

async function teardown() {
  await db?.knex.destroy();
  await owner?.destroy();
}

/** extra.mail: 'none' (default) or 'memory' (captures sent emails in app.locals.mailer.outbox). */
function makeApp(extra = {}) {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-up-'));
  const config = {
    env: 'test', isProd: false, uploadsDir, sessionTtlHours: 1, platformSessionTtlHours: 1, appUrl: 'https://app.example.test',
    loginRateLimit: extra.loginRateLimit || 1000, recoveryRateLimit: extra.recoveryRateLimit || 1000, tokenRateLimit: 1000,
    registrationRateLimit: extra.registrationRateLimit || 1000, databaseUrl: APP_URL, mail: { driver: extra.mail || 'none' },
    keyRing: TEST_KEY_RING, messaging: { sendMaxAttempts: 3, sendRetryDelaySeconds: 0, maxMediaBytes: 1024 * 1024 },
    channelProviders: extra.channelProviders || [], fakeProviderSecret: 'fake-test-secret'
  };
  return createApp(config, { db, apiRateLimit: 100000, mailer: createMailer({ driver: extra.mail || 'none' }) });
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

async function login(app, email, password = PASSWORD, endpoint = '/api/auth/login') {
  const agent = request.agent(app);
  const res = await agent.post(endpoint).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await agent.get('/api/auth/me');
  return { agent, csrf: me.body.csrfToken, me: me.body };
}

const platformLogin = (app, email, password = PASSWORD) => login(app, email, password, '/api/auth/platform-login');

/** Full config for runtime tests (jobs, realtime, webhooks, fake provider). */
function runtimeConfig(overrides = {}) {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-up-'));
  const base = {
    env: 'test', isProd: false, port: 0, uploadsDir, sessionTtlHours: 1, platformSessionTtlHours: 1,
    appUrl: 'http://localhost', loginRateLimit: 1000, recoveryRateLimit: 1000, tokenRateLimit: 1000, registrationRateLimit: 1000,
    databaseUrl: APP_URL, databaseDirectUrl: APP_URL, mail: { driver: 'none' },
    processRole: 'all', jobsEnabled: true, shutdownTimeoutMs: 15000,
    jobs: { schema: 'pgboss', pollingIntervalSeconds: 0.5, poolMax: 3 },
    realtime: { enabled: true, adapter: 'none', allowedOrigins: ['http://localhost'], revalidateSeconds: 3600 },
    webhooks: { bodyLimit: '64kb', maxAttempts: 3, retryDelaySeconds: 0, retentionDays: 30, rateLimitPerMinute: 100000 },
    channelProviders: ['fake'], fakeProviderSecret: 'fake-test-secret',
    keyRing: TEST_KEY_RING, messaging: { sendMaxAttempts: 3, sendRetryDelaySeconds: 0, maxMediaBytes: 1024 * 1024 }
  };
  const merged = { ...base, ...overrides };
  for (const k of ['jobs', 'realtime', 'webhooks', 'messaging']) merged[k] = { ...base[k], ...(overrides[k] || {}) };
  return merged;
}

/** Log in and return the raw session cookie (for Socket.IO clients). */
async function sessionCookie(app, email, password = PASSWORD, endpoint = '/api/auth/login') {
  const res = await request(app).post(endpoint).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
}

module.exports = {
  enabled, PASSWORD, TEST_KEY_RING, TEST_KEY, platformLogin, runtimeConfig, sessionCookie, setupDatabase, resetDatabase, teardown, makeApp, createCompanyFixture, addMember, createPlatformAdmin, login,
  getDb: () => db, getOwner: () => owner
};
