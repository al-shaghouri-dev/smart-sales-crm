const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('./helpers');
const { runSubscriptionMaintenance, addPeriod, monthlyValue } = require('../../server/services/subscriptions');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';
const tokenFrom = link => link.split('#')[1];
const DAY = 86400000;

describe('Phase 2: Super Admin, companies, subscriptions, onboarding', { skip }, () => {
  let app;
  before(async () => { await h.setupDatabase(); app = h.makeApp(); });
  beforeEach(() => h.resetDatabase());
  after(() => h.teardown());

  /** Platform admin agent with CSRF header pre-applied. */
  async function admin() {
    await h.createPlatformAdmin('root@platform.test');
    const s = await h.platformLogin(app, 'root@platform.test');
    const call = (method, url, body) => s.agent[method](url).set('X-CSRF-Token', s.csrf).send(body);
    return { ...s, call };
  }
  async function makePlan(a, body = {}) {
    const res = await a.call('post', '/api/platform/plans', {
      name: { en: 'Pro', ar: 'احترافية' }, interval: 'month', price: 49, currency: 'USD', maxEmployees: 3, isActive: true, ...body
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.plan;
  }
  async function createCompanyViaApi(a, extra = {}) {
    const res = await a.call('post', '/api/platform/companies', {
      name: 'Delta Trading', timezone: 'Asia/Dubai', currency: 'AED', defaultLocale: 'ar',
      owner: { name: 'Dana Owner', email: 'dana@delta.test' }, ...extra
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  describe('separate Super Admin authentication', () => {
    test('platform admins sign in through the admin console only; workspace sessions cannot reach platform APIs', async () => {
      const a = await admin();
      assert.equal(a.me.sessionKind, 'platform');
      assert.equal((await a.agent.get('/api/platform/overview')).status, 200);
      // Same account through the workspace sign-in is refused (no workspace) …
      const res = await request(app).post('/api/auth/login').send({ email: 'root@platform.test', password: h.PASSWORD });
      assert.equal(res.body.code, 'auth.use_platform_login');
      // … and a platform admin who is ALSO a company member gets a workspace session without platform rights.
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.getDb().withContext({ companyId: c.companyId }, async trx => {
        const role = await trx('roles').where({ company_id: c.companyId, key: 'employee' }).first();
        const uid = (await trx.raw('SELECT app_user_id_by_email(?) AS id', ['root@platform.test'])).rows[0].id;
        await trx('company_memberships').insert({ company_id: c.companyId, user_id: uid, role_id: role.id });
      });
      const ws = await h.login(app, 'root@platform.test');
      assert.equal(ws.me.sessionKind, 'company');
      assert.equal((await ws.agent.get('/api/platform/overview')).status, 403);
      assert.equal((await ws.agent.get('/api/platform/companies')).status, 403);
    });

    test('company owners cannot use the admin console sign-in or any platform API', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      assert.equal((await request(app).post('/api/auth/platform-login').send({ email: 'a@alpha.test', password: h.PASSWORD })).status, 401);
      const owner = await h.login(app, 'a@alpha.test');
      for (const url of ['/api/platform/overview', '/api/platform/companies', '/api/platform/plans', '/api/platform/registrations', '/api/platform/settings']) {
        assert.equal((await owner.agent.get(url)).status, 403, url);
      }
      assert.equal((await owner.agent.post('/api/platform/companies').set('X-CSRF-Token', owner.csrf).send({ name: 'x' })).status, 403);
    });

    test('platform sessions have no company context', async () => {
      const a = await admin();
      assert.equal((await a.agent.get('/api/team')).status, 403);
      assert.equal((await a.agent.get('/api/company')).status, 403);
    });
  });

  describe('plans', () => {
    test('create, validate, templates, edit, protect in-use plans', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      assert.equal(plan.price, 49);
      assert.equal((await a.call('post', '/api/platform/plans', { name: { en: 'X' }, interval: 'custom' })).status, 400, 'custom needs duration');
      assert.equal((await a.call('post', '/api/platform/plans', { name: { en: 'X' }, interval: 'month', features: ['root.shell'] })).status, 400);
      assert.equal((await a.call('post', '/api/platform/plans', { name: { en: 'X' }, interval: 'month', price: -1 })).status, 400);
      const custom = await makePlan(a, { name: { en: 'Quarter' }, interval: 'custom', durationDays: 90 });
      assert.equal(custom.durationDays, 90);

      const t = await a.call('post', '/api/platform/plans/templates', {});
      assert.deepEqual(t.body.created.map(p => p.key).sort(), ['basic', 'business', 'pro']);
      assert.ok(t.body.created.every(p => p.isActive === false && p.price === 0), 'templates are inactive drafts without prices');
      assert.equal((await a.call('post', '/api/platform/plans/templates', {})).body.created.length, 0, 'idempotent');

      const edited = await a.call('patch', `/api/platform/plans/${plan.id}`, { price: 59, features: ['reports.advanced'] });
      assert.equal(edited.body.plan.price, 59);

      await createCompanyViaApi(a, { subscription: { planId: plan.id } });
      assert.equal((await a.call('delete', `/api/platform/plans/${plan.id}`)).body.code, 'plans.in_use');
      assert.equal((await a.call('delete', `/api/platform/plans/${custom.id}`)).status, 200);

      // Public catalogue only lists active + public plans
      const pub = (await request(app).get('/api/public/plans')).body.plans;
      assert.deepEqual(pub.map(p => p.id), [plan.id]);
    });
  });

  describe('manual company creation & owner invitation', () => {
    test('creates company, roles, subscription and an invited owner without any password', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const res = await createCompanyViaApi(a, { subscription: { planId: plan.id, periods: 2 } });
      assert.equal(res.invitation.emailSent, false);
      assert.match(res.invitation.link, /^https:\/\/app\.example\.test\/invite#[A-Za-z0-9_-]{40,}$/);

      // Invited owner cannot log in before accepting.
      const blocked = await request(app).post('/api/auth/login').send({ email: 'dana@delta.test', password: 'anything-123' });
      assert.equal(blocked.status, 401);

      const detail = (await a.agent.get(`/api/platform/companies/${res.companyId}`)).body;
      assert.equal(detail.company.timezone, 'Asia/Dubai');
      assert.equal(detail.members[0].invitationPending, true);
      assert.equal(detail.subscription.status, 'active');
      const months = Math.round((new Date(detail.subscription.endsAt) - new Date(detail.subscription.startsAt)) / (30 * DAY));
      assert.equal(months, 2);

      // Accept the invitation → active owner of the company.
      const token = tokenFrom(res.invitation.link);
      const info = await request(app).post('/api/auth/token/inspect').send({ token: token });
      assert.equal(info.body.purpose, 'invite');
      assert.equal(info.body.companyName, 'Delta Trading');
      assert.equal(info.body.email, 'dana@delta.test');
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token: token, password: 'short' })).status, 400);
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token: token, password: 'Dana-Strong-Pass1' })).status, 200);
      // One-time use
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token: token, password: 'Another-Pass-123' })).body.code, 'token.invalid');
      assert.equal((await request(app).post('/api/auth/token/inspect').send({ token: token })).status, 400);
      const owner = await h.login(app, 'dana@delta.test', 'Dana-Strong-Pass1');
      assert.equal(owner.me.membership.roleKey, 'owner');
      assert.equal(owner.me.user.locale, null, 'no language is pre-set: device detection applies until the user chooses');
      assert.equal(owner.me.subscription.plan.id, plan.id);
    });

    test('invitations are emailed (and not returned) when email is configured', async () => {
      const mailApp = h.makeApp({ mail: 'memory' });
      await h.createPlatformAdmin('root@platform.test');
      const s = await h.platformLogin(mailApp, 'root@platform.test');
      const res = await s.agent.post('/api/platform/companies').set('X-CSRF-Token', s.csrf)
        .send({ name: 'Mail Co', owner: { name: 'M', email: 'm@mail.test' } });
      assert.equal(res.body.invitation.emailSent, true);
      assert.equal(res.body.invitation.link, undefined);
      const sent = mailApp.locals.mailer.outbox;
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'm@mail.test');
      assert.match(sent[0].text, /https:\/\/app\.example\.test\/invite#/);
    });

    test('expired, tampered or reused tokens are rejected; new link revokes the old one', async () => {
      const a = await admin();
      const { companyId, invitation } = await createCompanyViaApi(a);
      assert.equal((await request(app).post('/api/auth/token/inspect').send({ token: 'not-a-real-token-value-xxxxxxxxxx' })).status, 400);
      const second = await a.call('post', `/api/platform/companies/${companyId}/owner-link`, {});
      assert.equal(second.body.purpose, 'invite');
      assert.equal((await request(app).post('/api/auth/token/inspect').send({ token: tokenFrom(invitation.link) })).status, 400, 'old link revoked');
      // Expire the new token
      await h.getOwner().raw("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
      assert.equal((await request(app).post('/api/auth/token/accept').send({ token: tokenFrom(second.body.link), password: 'Valid-Pass-123' })).body.code, 'token.invalid');
    });

    test('tokens are stored hashed', async () => {
      const a = await admin();
      const { invitation } = await createCompanyViaApi(a);
      const raw = tokenFrom(invitation.link);
      const rows = await h.getOwner()('auth_tokens').select('token_hash');
      assert.ok(rows.every(r => r.token_hash !== raw && /^[0-9a-f]{64}$/.test(r.token_hash)));
    });
  });

  describe('company lifecycle', () => {
    test('suspend signs members out and blocks access; reactivate restores it; data preserved', async () => {
      const a = await admin();
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const owner = await h.login(app, 'a@alpha.test');
      await owner.agent.patch('/api/company').set('X-CSRF-Token', owner.csrf).send({ businessType: 'Books' });

      assert.equal((await a.call('post', `/api/platform/companies/${c.companyId}/suspend`, {})).status, 400, 'reason required');
      const s = await a.call('post', `/api/platform/companies/${c.companyId}/suspend`, { reason: 'Unpaid invoice' });
      assert.equal(s.body.company.status, 'suspended');
      assert.equal(s.body.company.suspensionReason, 'Unpaid invoice');
      assert.equal((await owner.agent.get('/api/auth/me')).status, 401, 'signed out');
      const again = await h.login(app, 'a@alpha.test');
      assert.equal(again.me.companyAccess, 'suspended');
      assert.equal((await again.agent.get('/api/company')).body.code, 'company.suspended');
      assert.equal((await a.call('post', `/api/platform/companies/${c.companyId}/activate`, {})).body.code, 'company.invalid_transition');

      assert.equal((await a.call('post', `/api/platform/companies/${c.companyId}/reactivate`, {})).body.company.status, 'active');
      const back = await h.login(app, 'a@alpha.test');
      const company = (await back.agent.get('/api/company')).body;
      assert.equal(company.profile.businessType, 'Books', 'data preserved');
      const actions = (await a.agent.get(`/api/platform/companies/${c.companyId}`)).body.activity.map(x => x.action);
      assert.ok(actions.includes('company.suspended') && actions.includes('company.reactivated'));
    });

    test('pending companies are activated explicitly; list filters work', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const { companyId } = await createCompanyViaApi(a, { status: 'pending', subscription: { planId: plan.id } });
      await h.createCompanyFixture('Zeta Books', 'z@zeta.test');
      let list = (await a.agent.get('/api/platform/companies?status=pending')).body.companies;
      assert.deepEqual(list.map(x => x.id), [companyId]);
      list = (await a.agent.get('/api/platform/companies?search=zeta')).body.companies;
      assert.equal(list.length, 1);
      list = (await a.agent.get('/api/platform/companies?subscription=none')).body.companies;
      assert.equal(list[0].name, 'Zeta Books');
      list = (await a.agent.get(`/api/platform/companies?plan=${plan.id}`)).body.companies;
      assert.equal(list[0].id, companyId);
      assert.equal((await a.agent.get('/api/platform/companies?status=evil')).status, 400);
      assert.equal((await a.call('post', `/api/platform/companies/${companyId}/activate`, {})).body.company.status, 'active');
      const edited = await a.call('patch', `/api/platform/companies/${companyId}`, { name: 'Delta Trading LLC', timezone: 'Nope/Zone' });
      assert.equal(edited.status, 400);
    });
  });

  describe('subscriptions & payments', () => {
    test('manual payment extends from the current end date and is visible to the company billing page', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id, status: 'active' });
      const before = (await a.agent.get(`/api/platform/companies/${c.companyId}`)).body.subscription.endsAt;
      assert.equal((await a.call('post', `/api/platform/companies/${c.companyId}/payments`, { amount: 0, method: 'cash' })).status, 400);
      assert.equal((await a.call('post', `/api/platform/companies/${c.companyId}/payments`, { amount: 10, method: 'bitcoin' })).status, 400);
      const pay = await a.call('post', `/api/platform/companies/${c.companyId}/payments`, {
        amount: 49, method: 'bank_transfer', reference: 'TRX-1', extend: { periods: 1 }
      });
      assert.equal(pay.status, 201);
      assert.equal(new Date(pay.body.payment.periodStart).toISOString(), new Date(before).toISOString());
      const sub = (await a.agent.get(`/api/platform/companies/${c.companyId}`)).body.subscription;
      assert.ok(new Date(sub.endsAt) > new Date(before));

      const owner = await h.login(app, 'a@alpha.test');
      const billing = (await owner.agent.get('/api/billing')).body;
      assert.equal(billing.payments.length, 1);
      assert.equal(billing.payments[0].reference, 'TRX-1');
      assert.equal(billing.subscription.plan.id, plan.id);

      // Employees cannot see billing.
      await h.addMember(c.companyId, 'employee', 'e@alpha.test');
      const emp = await h.login(app, 'e@alpha.test');
      assert.equal((await emp.agent.get('/api/billing')).status, 403);
      assert.equal(emp.me.subscription.plan, undefined, 'employees only see access state');
    });

    test('companies can read but never write subscriptions or payments (RLS)', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const x = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const y = await h.createCompanyFixture('Beta', 'b@beta.test');
      for (const c of [x, y]) {
        await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
        await a.call('post', `/api/platform/companies/${c.companyId}/payments`, { amount: 5, method: 'cash' });
      }
      const db = h.getDb();
      const seen = await db.withContext({ companyId: x.companyId }, async trx => ({
        subs: await trx('subscriptions').pluck('company_id'),
        pays: await trx('payments').pluck('company_id')
      }));
      assert.deepEqual(seen.subs, [x.companyId]);
      assert.deepEqual(seen.pays, [x.companyId]);
      const n = await db.withContext({ companyId: x.companyId }, trx => trx('subscriptions').update({ ends_at: new Date(Date.now() + 3650 * DAY) }));
      assert.equal(n, 0, 'cannot extend own subscription');
      await assert.rejects(db.withContext({ companyId: x.companyId }, trx => trx('payments').insert({ company_id: x.companyId, amount: 1, currency: 'USD', paid_at: new Date(), method: 'cash' })), /row-level security/);
      await assert.rejects(db.withContext({ platformAdmin: true }, trx => trx('payments').del()), /permission denied/, 'payments are append-only');
    });

    test('expiry job: marks expired, notifies once per stage, never deletes data; read-only policy enforced', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.addMember(c.companyId, 'employee', 'e@alpha.test');
      const now = Date.now();
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, {
        planId: plan.id, startsAt: new Date(now - 20 * DAY).toISOString(), endsAt: new Date(now + 5 * DAY).toISOString()
      });
      const db = h.getDb();
      let r = await runSubscriptionMaintenance(db, { now: new Date() });
      assert.equal(r.notified, 1, '7-day notice to the owner only (billing.view)');
      r = await runSubscriptionMaintenance(db, { now: new Date() });
      assert.equal(r.notified, 0, 'deduplicated');

      const owner = await h.login(app, 'a@alpha.test');
      const notes = (await owner.agent.get('/api/notifications')).body;
      assert.equal(notes.unread, 1);
      assert.equal(notes.notifications[0].type, 'subscription_expiring');
      const emp = await h.login(app, 'e@alpha.test');
      assert.equal((await emp.agent.get('/api/notifications')).body.notifications.length, 0);

      r = await runSubscriptionMaintenance(db, { now: new Date(now + 6 * DAY) });
      assert.equal(r.expired, 1);
      const sub = (await a.agent.get(`/api/platform/companies/${c.companyId}`)).body.subscription;
      assert.equal(sub.status, 'expired');

      // read_only policy: reads OK, writes refused with 402, data intact.
      const o2 = await h.login(app, 'a@alpha.test');
      assert.equal(o2.me.subscription.access, 'read_only');
      assert.equal((await o2.agent.get('/api/team')).status, 200);
      const write = await o2.agent.patch('/api/company').set('X-CSRF-Token', o2.csrf).send({ name: 'X' });
      assert.equal(write.status, 402);
      assert.equal(write.body.code, 'subscription.read_only');
      assert.equal((await o2.agent.get('/api/billing')).status, 200);
      const counts = await h.getDb().withContext({ platformAdmin: true }, trx => trx.raw('SELECT (SELECT count(*) FROM company_memberships)::int m, (SELECT count(*) FROM companies)::int c'));
      assert.deepEqual(counts.rows[0], { m: 2, c: 1 }, 'expiry never deletes company data');

      // block policy: only billing / notifications
      await a.call('patch', '/api/platform/settings', { expiredAccessPolicy: 'block' });
      const o3 = await h.login(app, 'a@alpha.test');
      assert.equal(o3.me.subscription.access, 'blocked');
      assert.equal((await o3.agent.get('/api/team')).body.code, 'subscription.blocked');
      assert.equal((await o3.agent.get('/api/billing')).status, 200);

      // Renewal restores full access.
      await a.call('post', `/api/platform/companies/${c.companyId}/subscription/extend`, { periods: 1 });
      const o4 = await h.login(app, 'a@alpha.test');
      assert.equal(o4.me.subscription.access, 'full');
      assert.equal((await o4.agent.patch('/api/company').set('X-CSRF-Token', o4.csrf).send({ name: 'Alpha 2' })).status, 200);
    });

    test('subscription status changes are validated', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id, status: 'pending' });
      assert.equal((await a.call('patch', `/api/platform/companies/${c.companyId}/subscription`, { status: 'active' })).body.code, 'subscription.needs_future_end');
      assert.equal((await a.call('patch', `/api/platform/companies/${c.companyId}/subscription`, { status: 'active', endsAt: new Date(Date.now() + 30 * DAY).toISOString() })).status, 200);
      assert.equal((await a.call('patch', `/api/platform/companies/${c.companyId}/subscription`, { status: 'cancelled' })).status, 200);
      assert.equal((await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id, startsAt: '2026-01-10', endsAt: '2026-01-01' })).body.code, 'subscription.invalid_dates');
    });

    test('plan seat limit applies to new members and invitations', async () => {
      const a = await admin();
      const plan = await makePlan(a, { maxEmployees: 2 });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await a.call('put', `/api/platform/companies/${c.companyId}/subscription`, { planId: plan.id });
      const o = await h.login(app, 'a@alpha.test');
      const add = email => o.agent.post('/api/team').set('X-CSRF-Token', o.csrf).send({ name: 'N', email, roleId: c.roles.employee });
      assert.equal((await add('one@alpha.test')).status, 201);
      const third = await add('two@alpha.test');
      assert.equal(third.status, 409);
      assert.equal(third.body.code, 'team.plan_limit');
    });

    test('date helpers: calendar months clamp; MRR normalisation', () => {
      assert.equal(addPeriod('2026-01-31T00:00:00Z', 'month').toISOString().slice(0, 10), '2026-02-28');
      assert.equal(addPeriod('2026-03-15T10:00:00Z', 'year', 2).toISOString().slice(0, 10), '2028-03-15');
      assert.equal(addPeriod('2026-03-01T00:00:00Z', 'custom', 1, 90).toISOString().slice(0, 10), '2026-05-30');
      assert.equal(monthlyValue({ price: 120, billing_interval: 'year' }), 10);
      assert.equal(monthlyValue({ price: 50, billing_interval: 'month', is_trial: true }), 0);
    });
  });

  describe('self-registration', () => {
    test('public request → review → approve creates a company and owner invitation; no access before approval', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const sub = await request(app).post('/api/public/register').send({
        companyName: 'Cedar Shop', ownerName: 'Lina', ownerEmail: 'lina@cedar.test', ownerPhone: '+961 1 000 000', planId: plan.id, locale: 'ar'
      });
      assert.equal(sub.status, 201);
      assert.equal(sub.body.id, undefined, 'no request id leaked');
      assert.equal((await request(app).post('/api/auth/login').send({ email: 'lina@cedar.test', password: 'whatever-1' })).status, 401);

      // The request is invisible without platform context.
      const hidden = await h.getDb().withContext({}, trx => trx('registration_requests').count('* as n').first());
      assert.equal(Number(hidden.n), 0);

      const list = (await a.agent.get('/api/platform/registrations?status=pending')).body.requests;
      assert.equal(list.length, 1);
      assert.equal(list[0].planId, plan.id);
      const stats = (await a.agent.get('/api/platform/overview')).body;
      assert.equal(stats.registrations.pending, 1);

      const ap = await a.call('post', `/api/platform/registrations/${list[0].id}/approve`, { timezone: 'Asia/Beirut' });
      assert.equal(ap.status, 200);
      assert.ok(ap.body.invitation.link);
      assert.equal((await a.call('post', `/api/platform/registrations/${list[0].id}/approve`, {})).body.code, 'registration.closed_request');
      const detail = (await a.agent.get(`/api/platform/companies/${ap.body.companyId}`)).body;
      assert.equal(detail.company.name, 'Cedar Shop');
      assert.equal(detail.company.defaultLocale, 'ar');
      assert.equal(detail.subscription.plan.id, plan.id);

      await request(app).post('/api/auth/token/accept').send({ token: tokenFrom(ap.body.invitation.link), password: 'Lina-Pass-1234' });
      const lina = await h.login(app, 'lina@cedar.test', 'Lina-Pass-1234');
      assert.equal(lina.me.company.name, 'Cedar Shop');
    });

    test('reject / request-info, validation, honeypot, closed registration, rate limit', async () => {
      const a = await admin();
      const submit = (body, agentApp = app) => request(agentApp).post('/api/public/register').send({ companyName: 'Co', ownerName: 'N', ownerEmail: 'n@co.test', ownerPhone: '123456', ...body });
      assert.equal((await submit({ ownerEmail: 'not-an-email' })).status, 400);
      assert.equal((await submit({ planId: '00000000-0000-0000-0000-000000000000' })).status, 400);
      assert.equal((await submit({ website: 'http://spam' })).status, 202);
      assert.equal((await submit({})).status, 201);
      assert.equal((await submit({ ownerEmail: 'b@co.test' })).status, 201);
      const [r1, r2] = (await a.agent.get('/api/platform/registrations')).body.requests;
      assert.equal((await a.call('post', `/api/platform/registrations/${r1.id}/request-info`, {})).status, 400, 'message required');
      assert.equal((await a.call('post', `/api/platform/registrations/${r1.id}/request-info`, { message: 'Please send your trade licence.' })).status, 200);
      assert.equal((await a.call('post', `/api/platform/registrations/${r2.id}/reject`, { message: 'Not eligible' })).status, 200);
      const statuses = (await a.agent.get('/api/platform/registrations')).body.requests.map(r => r.status).sort();
      assert.deepEqual(statuses, ['info_requested', 'rejected']);

      await a.call('patch', '/api/platform/settings', { registrationEnabled: false });
      assert.equal((await submit({ ownerEmail: 'c@co.test' })).body.code, 'registration.closed');

      const limited = h.makeApp({ registrationRateLimit: 1 });
      await a.call('patch', '/api/platform/settings', { registrationEnabled: true });
      await submit({ ownerEmail: 'd@co.test' }, limited);
      assert.equal((await submit({ ownerEmail: 'e@co.test' }, limited)).status, 429);
    });
  });

  describe('employee invitations & password reset', () => {
    test('invite without password; resend; reset link for active members; shared/owner protections still apply', async () => {
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const o = await h.login(app, 'a@alpha.test');
      const res = await o.agent.post('/api/team').set('X-CSRF-Token', o.csrf).send({ name: 'Sami', email: 'sami@alpha.test', roleId: c.roles.employee });
      assert.equal(res.status, 201);
      assert.equal(res.body.member.invitationPending, true);
      const first = res.body.link;
      const resend = await o.agent.post(`/api/team/${res.body.member.id}/link`).set('X-CSRF-Token', o.csrf);
      assert.equal(resend.body.purpose, 'invite');
      assert.equal((await request(app).post('/api/auth/token/inspect').send({ token: tokenFrom(first) })).status, 400, 'old invitation revoked');
      await request(app).post('/api/auth/token/accept').send({ token: tokenFrom(resend.body.link), password: 'Sami-Pass-1234', name: 'Sami Haddad' });
      const sami = await h.login(app, 'sami@alpha.test', 'Sami-Pass-1234');
      assert.equal(sami.me.user.locale, null);
      assert.equal(sami.me.user.name, 'Sami Haddad');

      const reset = await o.agent.post(`/api/team/${res.body.member.id}/link`).set('X-CSRF-Token', o.csrf);
      assert.equal(reset.body.purpose, 'password_reset');
      await request(app).post('/api/auth/token/accept').send({ token: tokenFrom(reset.body.link), password: 'Sami-New-Pass-99' });
      assert.equal((await sami.agent.get('/api/auth/me')).status, 401, 'reset signs out existing sessions');
      await h.login(app, 'sami@alpha.test', 'Sami-New-Pass-99');

      // Admins cannot create links for owners.
      await h.addMember(c.companyId, 'admin', 'adm@alpha.test');
      const adm = await h.login(app, 'adm@alpha.test');
      const ownerId = (await adm.agent.get('/api/team')).body.members.find(m => m.isOwner).id;
      assert.equal((await adm.agent.post(`/api/team/${ownerId}/link`).set('X-CSRF-Token', adm.csrf)).body.code, 'team.owner_only');
    });

    test('forgot password: same response for unknown emails; emails a working link when configured', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      assert.deepEqual((await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@x.test' })).body, { ok: true, emailEnabled: false });
      const mailApp = h.makeApp({ mail: 'memory' });
      const known = await request(mailApp).post('/api/auth/forgot-password').send({ email: 'a@alpha.test' });
      const unknown = await request(mailApp).post('/api/auth/forgot-password').send({ email: 'ghost@alpha.test' });
      assert.deepEqual(known.body, unknown.body);
      const outbox = mailApp.locals.mailer.outbox;
      assert.equal(outbox.length, 1);
      const link = outbox[0].text.match(/https:\/\/\S+/)[0];
      assert.match(link, /\/reset-password#/);
      assert.equal((await request(mailApp).post('/api/auth/token/inspect').send({ token: tokenFrom(link) })).body.purpose, 'password_reset');
      await request(mailApp).post('/api/auth/token/accept').send({ token: tokenFrom(link), password: 'Recovered-Pass-1' });
      await h.login(mailApp, 'a@alpha.test', 'Recovered-Pass-1');
      const limited = h.makeApp({ recoveryRateLimit: 1 });
      await request(limited).post('/api/auth/forgot-password').send({ email: 'x@x.test' });
      assert.equal((await request(limited).post('/api/auth/forgot-password').send({ email: 'x@x.test' })).status, 429);
    });
  });

  describe('platform statistics', () => {
    test('overview numbers come from real records', async () => {
      const a = await admin();
      const monthly = await makePlan(a, { price: 30 });
      const yearly = await makePlan(a, { name: { en: 'Y' }, interval: 'year', price: 240, currency: 'USD' });
      const sar = await makePlan(a, { name: { en: 'S' }, price: 100, currency: 'SAR' });
      const x = await h.createCompanyFixture('A', 'a@a.test');
      const y = await h.createCompanyFixture('B', 'b@b.test');
      const z = await h.createCompanyFixture('C', 'c@c.test', { status: 'pending' });
      await h.addMember(x.companyId, 'employee', 'e@a.test');
      await a.call('put', `/api/platform/companies/${x.companyId}/subscription`, { planId: monthly.id });
      await a.call('put', `/api/platform/companies/${y.companyId}/subscription`, { planId: yearly.id });
      await a.call('put', `/api/platform/companies/${z.companyId}/subscription`, { planId: sar.id });
      await a.call('post', `/api/platform/companies/${y.companyId}/suspend`, { reason: 'test' });
      const s = (await a.agent.get('/api/platform/overview')).body;
      assert.deepEqual(s.companies, { total: 3, active: 1, pending: 1, suspended: 1 });
      assert.equal(s.subscriptions.active, 3);
      assert.deepEqual(s.mrr, { USD: 50, SAR: 100 });
      assert.equal(s.users.employees, 4);
      assert.equal(s.users.platformAdmins, 1);
      assert.equal(s.channels, null);
    });
  });

  describe('audit trail', () => {
    test('sensitive platform actions are logged without secrets', async () => {
      const a = await admin();
      const plan = await makePlan(a);
      const { companyId } = await createCompanyViaApi(a, { subscription: { planId: plan.id } });
      await a.call('post', `/api/platform/companies/${companyId}/payments`, { amount: 10, method: 'cash' });
      await a.call('post', `/api/platform/companies/${companyId}/owner-link`, {});
      const rows = await h.getOwner().transaction(async trx => {
        await trx.raw("SELECT set_config('app.platform_admin','on',true)");
        return trx('audit_logs').select('action', 'before', 'after');
      });
      const actions = rows.map(r => r.action);
      for (const act of ['platform.login', 'plan.created', 'company.created', 'subscription.created', 'payment.recorded', 'company.owner_invite_resent']) {
        assert.ok(actions.includes(act), act);
      }
      assert.doesNotMatch(JSON.stringify(rows), /token_hash|password_hash|scrypt:/);
    });
  });
});
