const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('./helpers');
const { redactUrl } = require('../../server/app');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';
const tokenFrom = link => link.split('#')[1];

describe('Phase 2 hardening: seats, plan features, recovery tokens', { skip }, () => {
  let app;
  before(async () => { await h.setupDatabase(); app = h.makeApp(); });
  beforeEach(() => h.resetDatabase());
  after(() => h.teardown());

  async function admin(appInstance = app) {
    await h.createPlatformAdmin('root@platform.test');
    const s = await h.platformLogin(appInstance, 'root@platform.test');
    return { ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  async function planWith(a, body) {
    const r = await a.call('post', '/api/platform/plans', { name: { en: 'P' }, interval: 'month', price: 10, isActive: true, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.plan;
  }
  const activeCount = companyId => h.getDb().withContext({ platformAdmin: true }, trx =>
    trx('company_memberships').where({ company_id: companyId, status: 'active' }).count('* as n').first()).then(r => Number(r.n));

  // ---------------------------------------------------------------- seats
  describe('seat limit under concurrency', () => {
    test('10 simultaneous invitations against a 3-seat plan: exactly 2 succeed, never more than 3 active', async () => {
      const a = await admin();
      const plan = await planWith(a, { maxEmployees: 3 });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all([...Array(10)].map((_, i) => o.agent.post('/api/team').set('X-CSRF-Token', o.csrf)
          .send({ name: `P${i}`, email: `r${round}p${i}@alpha.test`, roleId: c.roles.employee })));
        const created = results.filter(r => r.status === 201);
        assert.ok(results.every(r => r.status === 201 || (r.status === 409 && r.body.code === 'team.plan_limit')), results.map(r => r.status).join(','));
        assert.equal(created.length, round === 0 ? 2 : 0, `round ${round}`);
        assert.equal(await activeCount(c.companyId), 3);
        if (round === 0) {
          // free one seat for the next round, then expect exactly one success
          await o.agent.patch(`/api/team/${created[0].body.member.id}`).set('X-CSRF-Token', o.csrf).send({ status: 'inactive' });
          const again = await Promise.all([...Array(8)].map((_, i) => o.agent.post('/api/team').set('X-CSRF-Token', o.csrf)
            .send({ name: 'Q', email: `q${i}@alpha.test`, roleId: c.roles.employee })));
          assert.equal(again.filter(r => r.status === 201).length, 1);
          assert.equal(await activeCount(c.companyId), 3);
        }
      }
    });

    test('simultaneous reactivations cannot exceed the limit', async () => {
      const a = await admin();
      const plan = await planWith(a, { maxEmployees: 2 });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await h.addMember(c.companyId, 'employee', `m${i}@alpha.test`)).membershipId);
      await h.getDb().withContext({ companyId: c.companyId }, trx => trx('company_memberships').whereIn('id', ids).update({ status: 'inactive' }));
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      const results = await Promise.all(ids.map(id => o.agent.patch(`/api/team/${id}`).set('X-CSRF-Token', o.csrf).send({ status: 'active' })));
      assert.equal(results.filter(r => r.status === 200).length, 1, results.map(r => r.status).join(','));
      assert.ok(results.filter(r => r.status !== 200).every(r => r.body.code === 'team.plan_limit'));
      assert.equal(await activeCount(c.companyId), 2);
    });

    test('mixed simultaneous invites and reactivations stay within the limit', async () => {
      const a = await admin();
      const plan = await planWith(a, { maxEmployees: 4 });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await h.addMember(c.companyId, 'employee', `m${i}@alpha.test`)).membershipId);
      await h.getDb().withContext({ companyId: c.companyId }, trx => trx('company_memberships').whereIn('id', ids).update({ status: 'inactive' }));
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      const ops = [
        ...ids.map(id => o.agent.patch(`/api/team/${id}`).set('X-CSRF-Token', o.csrf).send({ status: 'active' })),
        ...[...Array(6)].map((_, i) => o.agent.post('/api/team').set('X-CSRF-Token', o.csrf).send({ name: 'N', email: `n${i}@alpha.test`, roleId: c.roles.employee }))
      ];
      const results = await Promise.all(ops);
      const ok = results.filter(r => r.status === 200 || r.status === 201).length;
      assert.equal(ok, 3, 'owner + 3 = 4 seats');
      assert.equal(await activeCount(c.companyId), 4);
    });

    test('inactive members do not use a seat; the limit is read from the database, not the request', async () => {
      const a = await admin();
      const plan = await planWith(a, { maxEmployees: 1 });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      const inactive = await o.agent.post('/api/team').set('X-CSRF-Token', o.csrf).send({ name: 'I', email: 'i@alpha.test', roleId: c.roles.employee, status: 'inactive' });
      assert.equal(inactive.status, 201);
      assert.equal((await o.agent.patch(`/api/team/${inactive.body.member.id}`).set('X-CSRF-Token', o.csrf).send({ status: 'active' })).body.code, 'team.plan_limit');
      // Raise the limit in the console: the very next request sees it (same session).
      await a.call('patch', `/api/platform/plans/${plan.id}`, { maxEmployees: 2 });
      assert.equal((await o.agent.patch(`/api/team/${inactive.body.member.id}`).set('X-CSRF-Token', o.csrf).send({ status: 'active' })).status, 200);
    });
  });

  // ---------------------------------------------------------------- branding.custom
  describe('branding.custom plan feature', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

    test('denied on every branding endpoint when the plan lacks it (direct API calls)', async () => {
      const a = await admin();
      const plan = await planWith(a, { features: ['export.excel'] });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      assert.deepEqual(o.me.planFeatures, ['export.excel']);
      const patch = await o.agent.patch('/api/company/branding').set('X-CSRF-Token', o.csrf).send({ primaryColor: '#123456' });
      assert.equal(patch.status, 403);
      assert.equal(patch.body.code, 'plan.feature_unavailable');
      const logo = await o.agent.post('/api/company/branding/logo').set('X-CSRF-Token', o.csrf).attach('file', png, { filename: 'l.png', contentType: 'image/png' });
      assert.equal(logo.status, 403);
      assert.equal(logo.body.code, 'plan.feature_unavailable');
      const stored = await h.getDb().withContext({ companyId: c.companyId }, trx => trx('company_branding').where({ company_id: c.companyId }).first());
      assert.equal(stored.primary_color, null);
      assert.equal(stored.logo_url, null);
      // Other company settings are unaffected; reading branding still works.
      assert.equal((await o.agent.patch('/api/company').set('X-CSRF-Token', o.csrf).send({ businessType: 'Books' })).status, 200);
      assert.equal((await o.agent.get('/api/company')).status, 200);
    });

    test('allowed when the plan includes it, and when there is no subscription', async () => {
      const a = await admin();
      const plan = await planWith(a, { features: ['branding.custom'] });
      const withPlan = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.createCompanyFixture('NoSub', 'n@nosub.test');
      await a.call('put', `/api/platform/companies/${withPlan.companyId}/subscription`, { planId: plan.id });
      for (const email of ['a@alpha.test', 'n@nosub.test']) {
        const o = await h.login(app, email);
        assert.equal((await o.agent.patch('/api/company/branding').set('X-CSRF-Token', o.csrf).send({ primaryColor: '#123456' })).status, 200, email);
        assert.equal((await o.agent.post('/api/company/branding/logo').set('X-CSRF-Token', o.csrf).attach('file', png, { filename: 'l.png', contentType: 'image/png' })).status, 200, email);
      }
      const noSub = await h.login(app, 'n@nosub.test');
      assert.equal(noSub.me.planFeatures, null);
    });

    test('removing the feature from the plan takes effect on the next request', async () => {
      const a = await admin();
      const plan = await planWith(a, { features: ['branding.custom'] });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      assert.equal((await o.agent.patch('/api/company/branding').set('X-CSRF-Token', o.csrf).send({ displayName: 'A' })).status, 200);
      await a.call('patch', `/api/platform/plans/${plan.id}`, { features: [] });
      assert.equal((await o.agent.patch('/api/company/branding').set('X-CSRF-Token', o.csrf).send({ displayName: 'B' })).body.code, 'plan.feature_unavailable');
    });
  });

  // ---------------------------------------------------------------- tokens
  describe('recovery & invitation token handling', () => {
    test('links carry the token in the fragment; path/query token endpoints do not exist', async () => {
      const a = await admin();
      const res = await a.call('post', '/api/platform/companies', { name: 'Delta', owner: { name: 'D', email: 'd@delta.test' } });
      const link = res.body.invitation.link;
      const url = new URL(link);
      assert.equal(url.pathname, '/invite');
      assert.equal(url.search, '');
      assert.match(url.hash, /^#[A-Za-z0-9_-]{40,}$/);
      const token = tokenFrom(link);
      assert.equal((await request(app).get(`/api/auth/token/${token}`)).status, 404);
      assert.equal((await request(app).post(`/api/auth/token/${token}/accept`).send({ password: 'Valid-Pass-123' })).status, 404);
      // Query-string tokens are ignored: only the POST body counts.
      assert.equal((await request(app).post(`/api/auth/token/inspect?token=${token}`).send({})).body.code, 'token.invalid');
      const info = await request(app).post('/api/auth/token/inspect').send({ token });
      assert.equal(info.status, 200);
      assert.match(info.headers['cache-control'], /no-store/);
      assert.doesNotMatch(JSON.stringify(info.body), new RegExp(token));
    });

    test('raw tokens never reach server logs, the audit log or unrelated responses', async () => {
      const logs = [];
      const originals = {};
      for (const k of ['log', 'error', 'warn', 'info']) { originals[k] = console[k]; console[k] = (...args) => logs.push(args.map(String).join(' ')); }
      try {
        const a = await admin();
        const created = await a.call('post', '/api/platform/companies', { name: 'Delta', owner: { name: 'D', email: 'd@delta.test' } });
        const token = tokenFrom(created.body.invitation.link);
        await request(app).post('/api/auth/token/inspect').send({ token });
        await request(app).post('/api/auth/token/accept').send({ token, password: 'Delta-Pass-1234' });
        await request(app).post('/api/auth/token/accept').send({ token, password: 'Delta-Pass-1234' }); // reuse → invalid
        await request(app).post('/api/auth/token/inspect').send({ token: 'x'.repeat(5000) }); // junk
        const details = await a.agent.get(`/api/platform/companies/${created.body.companyId}`);
        const auditRows = await h.getDb().withContext({ platformAdmin: true }, trx => trx('audit_logs').select('*'));
        const tokenRows = await h.getOwner()('auth_tokens').select('token_hash');
        assert.ok(!logs.some(l => l.includes(token)), 'token in server log');
        assert.ok(!JSON.stringify(auditRows).includes(token), 'token in audit log');
        assert.ok(!JSON.stringify(details.body).includes(token), 'token in company details');
        assert.ok(tokenRows.every(r => r.token_hash !== token));
      } finally {
        Object.assign(console, originals);
      }
    });

    test('logged URLs are redacted', () => {
      const tok = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo';
      assert.equal(redactUrl(`/api/auth/token/${tok}`), '/api/auth/token/[redacted]');
      assert.equal(redactUrl(`/invite/${tok}?a=1#x`), '/invite/[redacted]');
      assert.equal(redactUrl('/api/team/0f8fad5b-d9cb-469f-a165-70867728950e/link'), '/api/team/0f8fad5b-d9cb-469f-a165-70867728950e/link');
      assert.equal(redactUrl('/api/x?token=secret&a=b'), '/api/x');
    });
  });

  // ---------------------------------------------------------------- Super Admin member link
  describe('Super Admin member reset link', () => {
    async function sharedEmployeeSetup() {
      const a = await admin();
      const alpha = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const beta = await h.createCompanyFixture('Beta', 'b@beta.test');
      // e@shared.test is an employee in BOTH companies
      const { userId, membershipId } = await h.addMember(alpha.companyId, 'employee', 'e@shared.test');
      const betaMembership = await h.getDb().withContext({ companyId: beta.companyId }, async trx => {
        const role = await trx('roles').where({ company_id: beta.companyId, key: 'employee' }).first();
        const [row] = await trx('company_memberships').insert({ company_id: beta.companyId, user_id: userId, role_id: role.id }).returning('id');
        return row.id;
      });
      return { a, alpha, beta, membershipId, betaMembership };
    }

    test('recovers an employee who belongs to two companies; one-time, sessions ended, audited', async () => {
      const { a, alpha, membershipId } = await sharedEmployeeSetup();
      // Company admins are (still) not allowed to do this for shared accounts.
      const owner = await h.login(app, 'a@alpha.test');
      assert.equal((await owner.agent.post(`/api/team/${membershipId}/link`).set('X-CSRF-Token', owner.csrf)).body.code, 'team.shared_account');

      const employee = await h.login(app, 'e@shared.test');
      const r = await a.call('post', `/api/platform/companies/${alpha.companyId}/members/${membershipId}/link`, {});
      assert.equal(r.status, 200);
      assert.equal(r.body.purpose, 'password_reset');
      assert.match(r.body.link, /\/reset-password#[A-Za-z0-9_-]{40,}$/);
      assert.match(r.headers['cache-control'], /no-store/);
      const token = tokenFrom(r.body.link);
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token, password: 'Shared-New-Pass1' })).status, 200);
      assert.equal((await employee.agent.get('/api/auth/me')).status, 401, 'existing sessions ended immediately');
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token, password: 'Again-Pass-1234' })).body.code, 'token.invalid', 'one-time');
      const both = await h.login(app, 'e@shared.test', 'Shared-New-Pass1');
      assert.equal(both.me.companies.length, 2);

      const audit = await h.getDb().withContext({ platformAdmin: true }, trx => trx('audit_logs').where({ action: 'platform.member_reset_link' }).select('*'));
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_email, 'root@platform.test');
      assert.doesNotMatch(JSON.stringify(audit), new RegExp(token));
    });

    test('expired links are refused; invited members receive an invitation instead', async () => {
      const { a, alpha, membershipId } = await sharedEmployeeSetup();
      const r = await a.call('post', `/api/platform/companies/${alpha.companyId}/members/${membershipId}/link`, {});
      await h.getOwner().raw("UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token: tokenFrom(r.body.link), password: 'Late-Pass-12345' })).body.code, 'token.invalid');

      const o = await h.login(app, 'a@alpha.test');
      const invited = await o.agent.post('/api/team').set('X-CSRF-Token', o.csrf).send({ name: 'New', email: 'new@alpha.test', roleId: alpha.roles.employee });
      const inv = await a.call('post', `/api/platform/companies/${alpha.companyId}/members/${invited.body.member.id}/link`, {});
      assert.equal(inv.body.purpose, 'invite');
      assert.match(inv.body.link, /\/invite#/);
    });

    test('authorization: only Super Admins, only members of that company, never platform admins or disabled accounts', async () => {
      const { a, alpha, beta, membershipId } = await sharedEmployeeSetup();
      const owner = await h.login(app, 'a@alpha.test');
      assert.equal((await owner.agent.post(`/api/platform/companies/${alpha.companyId}/members/${membershipId}/link`).set('X-CSRF-Token', owner.csrf)).status, 403);
      assert.equal((await request(app).post(`/api/platform/companies/${alpha.companyId}/members/${membershipId}/link`)).status, 401);
      // membership of Alpha addressed through Beta → not found
      assert.equal((await a.call('post', `/api/platform/companies/${beta.companyId}/members/${membershipId}/link`, {})).status, 404);
      // platform admin who is also a member
      const rootMembership = await h.getDb().withContext({ companyId: alpha.companyId }, async trx => {
        const role = await trx('roles').where({ company_id: alpha.companyId, key: 'employee' }).first();
        const uid = (await trx.raw('SELECT app_user_id_by_email(?) AS id', ['root@platform.test'])).rows[0].id;
        const [row] = await trx('company_memberships').insert({ company_id: alpha.companyId, user_id: uid, role_id: role.id }).returning('id');
        return row.id;
      });
      assert.equal((await a.call('post', `/api/platform/companies/${alpha.companyId}/members/${rootMembership}/link`, {})).body.code, 'platform.admin_account');
      // disabled account
      await h.getDb().withContext({ platformAdmin: true }, trx => trx('users').where({ email: 'e@shared.test' }).update({ status: 'disabled' }));
      assert.equal((await a.call('post', `/api/platform/companies/${alpha.companyId}/members/${membershipId}/link`, {})).body.code, 'team.account_disabled');
    });

    test('with email configured the link is emailed and not returned', async () => {
      const mailApp = h.makeApp({ mail: 'memory' });
      const { alpha, membershipId } = await sharedEmployeeSetup();
      const s = await h.platformLogin(mailApp, 'root@platform.test');
      const r = await s.agent.post(`/api/platform/companies/${alpha.companyId}/members/${membershipId}/link`).set('X-CSRF-Token', s.csrf);
      assert.equal(r.body.emailSent, true);
      assert.equal(r.body.link, undefined);
      assert.equal(mailApp.locals.mailer.outbox[0].to, 'e@shared.test');
      assert.match(mailApp.locals.mailer.outbox[0].text, /\/reset-password#/);
    });
  });
});
