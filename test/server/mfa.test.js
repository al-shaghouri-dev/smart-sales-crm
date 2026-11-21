const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('./helpers');
const totp = require('../../server/security/totp');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';

describe('Two-factor authentication and login throttling', { skip }, () => {
  let app;
  before(async () => { await h.setupDatabase(); app = h.makeApp(); });
  beforeEach(() => h.resetDatabase());
  after(() => h.teardown());

  const call = (s, m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b);

  async function turnOn(s) {
    const setup = await call(s, 'post', '/api/auth/mfa/setup');
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
    assert.match(setup.body.qrSvg, /^<svg/);
    assert.equal((await call(s, 'post', '/api/auth/mfa/enable', { code: '000000' })).status, 400);
    const step = totp.currentStep();
    const en = await call(s, 'post', '/api/auth/mfa/enable', { code: totp.codeAt(setup.body.secret, step) });
    assert.equal(en.status, 200, JSON.stringify(en.body));
    assert.equal(en.body.recoveryCodes.length, 10);
    return { secret: setup.body.secret, step, recovery: en.body.recoveryCodes };
  }

  test('workspace sign-in needs the code once enabled; tickets are single-use; replay refused', async () => {
    await h.createCompanyFixture('Acme', 'owner@acme.test');
    const s = await h.login(app, 'owner@acme.test');
    assert.equal((await s.agent.get('/api/auth/mfa')).body.enabled, false);
    const { secret, step, recovery } = await turnOn(s);
    assert.deepEqual({ ...(await s.agent.get('/api/auth/mfa')).body, enabledAt: null }, { enabled: true, enabledAt: null, recoveryCodesLeft: 10 });

    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ email: 'owner@acme.test', password: h.PASSWORD });
    assert.equal(first.status, 200);
    assert.equal(first.body.mfaRequired, true);
    assert.equal(first.headers['set-cookie'], undefined, 'no session before the second factor');
    assert.equal((await agent.get('/api/auth/me')).status, 401);

    // The code already used to enable (same time step) is refused: replay protection.
    assert.equal((await agent.post('/api/auth/login/mfa').send({ ticket: first.body.ticket, code: totp.codeAt(secret, step) })).status, 401);
    assert.equal((await agent.post('/api/auth/login/mfa').send({ ticket: first.body.ticket, code: '123456' })).status, 401);
    const ok = await agent.post('/api/auth/login/mfa').send({ ticket: first.body.ticket, code: totp.codeAt(secret, step + 1) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await agent.get('/api/auth/me')).status, 200);
    assert.equal((await request(app).post('/api/auth/login/mfa').send({ ticket: first.body.ticket, code: totp.codeAt(secret, step + 1) })).status, 401, 'ticket is single-use');
    assert.equal((await request(app).post('/api/auth/login/mfa').send({ ticket: 'garbage', code: '123456' })).status, 401);

    // Recovery code: works once.
    const a2 = request.agent(app);
    const t2 = (await a2.post('/api/auth/login').send({ email: 'owner@acme.test', password: h.PASSWORD })).body.ticket;
    assert.equal((await a2.post('/api/auth/login/mfa').send({ ticket: t2, code: recovery[0].toUpperCase() })).status, 200);
    const a3 = request.agent(app);
    const t3 = (await a3.post('/api/auth/login').send({ email: 'owner@acme.test', password: h.PASSWORD })).body.ticket;
    assert.equal((await a3.post('/api/auth/login/mfa').send({ ticket: t3, code: recovery[0] })).status, 401, 'recovery codes are single-use');
  });

  test('a ticket dies after 5 wrong codes; disabling needs password and a code', async () => {
    await h.createCompanyFixture('Acme', 'owner@acme.test');
    const s = await h.login(app, 'owner@acme.test');
    const { recovery } = await turnOn(s);
    const agent = request.agent(app);
    const ticket = (await agent.post('/api/auth/login').send({ email: 'owner@acme.test', password: h.PASSWORD })).body.ticket;
    for (let i = 0; i < 5; i++) assert.equal((await agent.post('/api/auth/login/mfa').send({ ticket, code: '000000' })).status, 401);
    const late = await agent.post('/api/auth/login/mfa').send({ ticket, code: recovery[1] });
    assert.equal(late.status, 401);
    assert.equal(late.body.code, 'auth.mfa_expired');

    // The enabling session survives; others were signed out when 2FA was turned on.
    assert.equal((await call(s, 'post', '/api/auth/mfa/disable', { password: 'wrong', code: recovery[2] })).status, 400);
    assert.equal((await call(s, 'post', '/api/auth/mfa/disable', { password: h.PASSWORD, code: '000000' })).status, 400);
    assert.equal((await call(s, 'post', '/api/auth/mfa/disable', { password: h.PASSWORD, code: recovery[2] })).status, 200);
    const plain = await request(app).post('/api/auth/login').send({ email: 'owner@acme.test', password: h.PASSWORD });
    assert.equal(plain.body.mfaRequired, undefined);
  });

  test('Super Admin console also asks for the code', async () => {
    await h.createPlatformAdmin('root@platform.test');
    const s = await h.platformLogin(app, 'root@platform.test');
    const { secret, step } = await turnOn(s);
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/platform-login').send({ email: 'root@platform.test', password: h.PASSWORD });
    assert.equal(r.body.mfaRequired, true);
    assert.equal((await agent.post('/api/auth/login/mfa').send({ ticket: r.body.ticket, code: totp.codeAt(secret, step + 1) })).status, 200);
    const me = await agent.get('/api/auth/me');
    assert.equal(me.body.sessionKind, 'platform');
  });

  test('2FA secrets are private to their owner (row-level security)', async () => {
    const a = await h.createCompanyFixture('Acme', 'owner@acme.test');
    await h.addMember(a.companyId, 'employee', 'emp@acme.test');
    const s = await h.login(app, 'owner@acme.test');
    await turnOn(s);
    const empId = (await h.login(app, 'emp@acme.test')).me.user.id;
    const seen = await h.getDb().withContext({ userId: empId, companyId: a.companyId }, trx => trx('user_mfa').select('user_id'));
    assert.deepEqual(seen, []);
  });

  test('per-account throttling: failed passwords for one account are limited even from many IPs', async () => {
    await h.createCompanyFixture('Acme', 'owner@acme.test');
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/api/auth/login').set('X-Forwarded-For', `10.0.0.${i}`).send({ email: 'owner@acme.test', password: 'wrong-password' });
      assert.equal(r.status, 401);
    }
    const blocked = await request(app).post('/api/auth/login').send({ email: 'OWNER@acme.test', password: h.PASSWORD });
    assert.equal(blocked.status, 429);
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'other@acme.test', password: 'x' })).status, 401, 'other accounts unaffected');
  });
});
