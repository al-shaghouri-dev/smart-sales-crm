const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('./helpers');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';

describe('Phase 1 foundation', { skip }, () => {
  let app;
  before(async () => { await h.setupDatabase(); app = h.makeApp(); });
  beforeEach(() => h.resetDatabase());
  after(() => h.teardown());

  describe('migrations', () => {
    test('roll back and re-apply cleanly', async () => {
      const owner = h.getOwner();
      await owner.migrate.rollback(undefined, true);
      const [, pending] = await owner.migrate.list();
      assert.ok(pending.length >= 1);
      await owner.migrate.latest();
      const [done, stillPending] = await owner.migrate.list();
      assert.equal(stillPending.length, 0);
      assert.ok(done.length >= 1);
    });

    test('no users or companies exist after migration (no default accounts)', async () => {
      const owner = h.getOwner();
      const users = await owner.transaction(async trx => {
        await trx.raw("SELECT set_config('app.platform_admin','on',true)");
        return trx('users').count('* as n').first();
      });
      assert.equal(Number(users.n), 0);
    });
  });

  describe('row level security (database layer)', () => {
    test('a tenant context only sees its own rows', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      const db = h.getDb();
      const seen = await db.withContext({ companyId: a.companyId }, async trx => ({
        companies: await trx('companies').pluck('id'),
        roles: await trx('roles').distinct('company_id').pluck('company_id'),
        settings: await trx('company_settings').pluck('company_id'),
        branding: await trx('company_branding').pluck('company_id'),
        memberships: await trx('company_memberships').distinct('company_id').pluck('company_id'),
        perms: await trx('role_permissions').distinct('company_id').pluck('company_id'),
        audit: await trx('audit_logs').whereNotNull('company_id').distinct('company_id').pluck('company_id'),
        // Explicitly asking for the other tenant's rows must still return nothing.
        betaRoles: await trx('roles').where({ company_id: b.companyId }).pluck('id'),
        betaUsers: await trx('users').where({ email: 'b@beta.test' }).pluck('id')
      }));
      assert.deepEqual(seen.companies, [a.companyId]);
      for (const k of ['roles', 'settings', 'branding', 'memberships', 'perms', 'audit']) assert.deepEqual(seen[k], [a.companyId], k);
      assert.deepEqual(seen.betaRoles, []);
      assert.deepEqual(seen.betaUsers, []);
    });

    test('no context sees no tenant data', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const rows = await h.getDb().withContext({}, async trx => ({
        companies: await trx('companies').count('* as n').first(),
        roles: await trx('roles').count('* as n').first(),
        users: await trx('users').count('* as n').first()
      }));
      assert.deepEqual(Object.values(rows).map(r => Number(r.n)), [0, 0, 0]);
    });

    test('writes into another tenant are rejected by WITH CHECK', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      await assert.rejects(
        h.getDb().withContext({ companyId: a.companyId }, trx => trx('roles').insert({ company_id: b.companyId, key: 'evil' })),
        /row-level security/
      );
      const updated = await h.getDb().withContext({ companyId: a.companyId }, trx => trx('company_branding').where({ company_id: b.companyId }).update({ display_name: 'pwned' }));
      assert.equal(updated, 0);
    });

    test('only platform context can create companies or grant platform admin', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await assert.rejects(h.getDb().withContext({ companyId: a.companyId }, trx => trx('companies').insert({ name: 'X', slug: 'x' })), /row-level security/);
      await assert.rejects(
        h.getDb().withContext({ companyId: a.companyId }, trx => trx('users').insert({ email: 'x@x.test', name: 'x', is_platform_admin: true })),
        /row-level security/
      );
      await assert.rejects(
        h.getDb().withContext({ companyId: a.companyId, userId: a.ownerUserId }, trx => trx('users').where({ id: a.ownerUserId }).update({ is_platform_admin: true })),
        /only platform admins/
      );
    });

    test('the application role cannot bypass RLS or alter the permission catalog', async () => {
      const r = await h.getDb().knex.raw('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user');
      assert.equal(r.rows[0].rolbypassrls, false);
      assert.equal(r.rows[0].rolsuper, false);
      await assert.rejects(h.getDb().knex('permissions').insert({ key: 'evil', category: 'x' }), /permission denied/);
      await assert.rejects(h.getDb().withContext({}, trx => trx('audit_logs').del()), /permission denied/);
    });
  });

  describe('authentication & sessions', () => {
    test('login, me, logout', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/login').send({ email: 'A@Alpha.test', password: h.PASSWORD });
      assert.equal(res.status, 200);
      assert.match(res.headers['set-cookie'].join(';'), /HttpOnly/);
      const me = await agent.get('/api/auth/me');
      assert.equal(me.body.company.id, a.companyId);
      assert.equal(me.body.membership.roleKey, 'owner');
      assert.ok(me.body.permissions.includes('users.manage'));
      assert.equal(me.body.user.password_hash, undefined);
      assert.equal((await agent.post('/api/auth/logout').set('X-CSRF-Token', me.body.csrfToken)).status, 200);
      assert.equal((await agent.get('/api/auth/me')).status, 401);
    });

    test('bad credentials are rejected uniformly and audited', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const wrong = await request(app).post('/api/auth/login').send({ email: 'a@alpha.test', password: 'nope-nope' });
      const ghost = await request(app).post('/api/auth/login').send({ email: 'ghost@alpha.test', password: 'nope-nope' });
      assert.equal(wrong.status, 401);
      assert.equal(ghost.status, 401);
      assert.equal(wrong.body.code, 'auth.invalid_credentials');
      assert.equal(ghost.body.code, 'auth.invalid_credentials');
    });

    test('login is rate limited', async () => {
      const limited = h.makeApp({ loginRateLimit: 2 });
      for (let i = 0; i < 2; i++) await request(limited).post('/api/auth/login').send({ email: 'x@x.test', password: 'whatever1' });
      const res = await request(limited).post('/api/auth/login').send({ email: 'x@x.test', password: 'whatever1' });
      assert.equal(res.status, 429);
      assert.equal(res.body.code, 'auth.rate_limited');
    });

    test('CSRF token is required for writes', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      assert.equal((await agent.patch('/api/me/preferences').send({ locale: 'ar' })).status, 403);
      assert.equal((await agent.patch('/api/me/preferences').set('X-CSRF-Token', csrf).send({ locale: 'ar' })).status, 200);
    });

    test('language/theme preferences persist on the account', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      assert.equal((await agent.patch('/api/me/preferences').set('X-CSRF-Token', csrf).send({ locale: 'ar', theme: 'dark' })).status, 200);
      const again = await h.login(app, 'a@alpha.test');
      assert.equal(again.me.user.locale, 'ar');
      assert.equal(again.me.user.theme, 'dark');
      assert.equal((await agent.patch('/api/me/preferences').set('X-CSRF-Token', csrf).send({ locale: 'fr' })).status, 400);
    });

    test('changing password signs out other sessions', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const s1 = await h.login(app, 'a@alpha.test');
      const s2 = await h.login(app, 'a@alpha.test');
      const res = await s1.agent.post('/api/auth/change-password').set('X-CSRF-Token', s1.csrf).send({ currentPassword: h.PASSWORD, newPassword: 'Brand-New-Pass-1' });
      assert.equal(res.status, 200);
      assert.equal((await s2.agent.get('/api/auth/me')).status, 401);
      assert.equal((await s1.agent.get('/api/auth/me')).status, 200);
      await h.login(app, 'a@alpha.test', 'Brand-New-Pass-1');
    });

    test('suspended or pending companies give no workspace access', async () => {
      await h.createCompanyFixture('Pending Co', 'p@pending.test', { status: 'pending' });
      const { agent, me } = await h.login(app, 'p@pending.test');
      assert.equal(me.companyAccess, 'pending');
      assert.deepEqual(me.permissions, []);
      const res = await agent.get('/api/team');
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'company.pending');
    });
  });

  describe('tenant isolation through the API', () => {
    test('a company admin cannot read or change another company via ID manipulation', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      const bMember = await h.addMember(b.companyId, 'employee', 'emp@beta.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');

      const team = (await agent.get('/api/team')).body.members;
      assert.ok(team.every(m => m.email.endsWith('@alpha.test')));

      assert.equal((await agent.patch(`/api/team/${bMember.membershipId}`).set('X-CSRF-Token', csrf).send({ status: 'inactive' })).status, 404);
      assert.equal((await agent.post(`/api/team/${bMember.membershipId}/password`).set('X-CSRF-Token', csrf).send({ password: 'Hijack-Pass-1' })).status, 404);
      assert.equal((await agent.delete(`/api/team/${bMember.membershipId}`).set('X-CSRF-Token', csrf)).status, 404);
      assert.equal((await agent.patch(`/api/roles/${b.roles.employee}`).set('X-CSRF-Token', csrf).send({ name: 'x' })).status, 404);

      // Assigning a role that belongs to another company is rejected.
      const add = await agent.post('/api/team').set('X-CSRF-Token', csrf).send({ name: 'X', email: 'x@alpha.test', password: 'Strong-Pass-1', roleId: b.roles.admin });
      assert.equal(add.status, 400);
      assert.equal(add.body.code, 'team.invalid_role');

      // Switching the session into a company you do not belong to is rejected.
      assert.equal((await agent.post('/api/auth/switch-company').set('X-CSRF-Token', csrf).send({ companyId: b.companyId })).status, 404);

      const roles = (await agent.get('/api/roles')).body.roles;
      assert.ok(roles.every(r => !Object.values(b.roles).includes(r.id)));
      const audit = (await agent.get('/api/audit')).body.entries;
      assert.ok(audit.length > 0);
    });

    test('a company logo URL cannot point at another company\'s uploads', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      const bad = await agent.patch('/api/company/branding').set('X-CSRF-Token', csrf).send({ logoUrl: `/uploads/companies/${b.companyId}/x.png` });
      assert.equal(bad.status, 400);
      const ok = await agent.patch('/api/company/branding').set('X-CSRF-Token', csrf).send({ logoUrl: `/uploads/companies/${a.companyId}/x.png`, primaryColor: '#112233' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.branding.primaryColor, '#112233');
    });

    test('an admin cannot change credentials of an account shared with another company', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      // b@beta.test owns Beta and is ALSO an employee in Alpha.
      await h.createCompanyFixture('Beta', 'b@beta.test');
      const shared = await h.getDb().withContext({ companyId: a.companyId }, async trx => {
        const role = await trx('roles').where({ company_id: a.companyId, key: 'employee' }).first();
        const userId = (await trx.raw('SELECT app_user_id_by_email(?) AS id', ['b@beta.test'])).rows[0].id;
        const [row] = await trx('company_memberships').insert({ company_id: a.companyId, user_id: userId, role_id: role.id }).returning('id');
        return row.id;
      });
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      const reset = await agent.post(`/api/team/${shared}/password`).set('X-CSRF-Token', csrf).send({ password: 'Takeover-Pass-1' });
      assert.equal(reset.status, 403);
      assert.equal(reset.body.code, 'team.shared_account');
      const rename = await agent.patch(`/api/team/${shared}`).set('X-CSRF-Token', csrf).send({ name: 'Renamed' });
      assert.equal(rename.status, 403);
      await h.login(app, 'b@beta.test'); // original password still works
    });
  });

  describe('roles & permissions', () => {
    test('employees cannot manage the team, roles, settings or audit log', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.addMember(a.companyId, 'employee', 'emp@alpha.test');
      const { agent, csrf, me } = await h.login(app, 'emp@alpha.test');
      assert.ok(!me.permissions.includes('users.manage'));
      for (const [method, url] of [['get', '/api/team'], ['post', '/api/team'], ['post', '/api/roles'], ['patch', '/api/company'], ['patch', '/api/company/branding'], ['get', '/api/audit'], ['get', '/api/company']]) {
        const res = await agent[method](url).set('X-CSRF-Token', csrf).send({});
        assert.equal(res.status, 403, `${method} ${url}`);
      }
      assert.equal((await agent.get('/api/platform/settings')).status, 403);
    });

    test('team management lifecycle with owner safeguards', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const { agent, csrf, me } = await h.login(app, 'a@alpha.test');
      const add = await agent.post('/api/team').set('X-CSRF-Token', csrf).send({ name: 'Sara', email: 'sara@alpha.test', password: 'Strong-Pass-1', roleId: a.roles.employee });
      assert.equal(add.status, 201);
      const id = add.body.member.id;
      assert.equal((await agent.post('/api/team').set('X-CSRF-Token', csrf).send({ name: 'Dup', email: 'sara@alpha.test', password: 'Strong-Pass-1', roleId: a.roles.employee })).status, 409);
      assert.equal((await agent.post('/api/team').set('X-CSRF-Token', csrf).send({ name: 'Weak', email: 'w@alpha.test', password: 'short', roleId: a.roles.employee })).status, 400);

      const sara = await h.login(app, 'sara@alpha.test', 'Strong-Pass-1');
      assert.equal((await agent.patch(`/api/team/${id}`).set('X-CSRF-Token', csrf).send({ roleId: a.roles.supervisor, jobTitle: 'Lead' })).body.member.roleKey, 'supervisor');
      assert.equal((await agent.patch(`/api/team/${id}`).set('X-CSRF-Token', csrf).send({ status: 'inactive' })).status, 200);
      assert.equal((await sara.agent.get('/api/auth/me')).status, 401, 'deactivated member is signed out');
      assert.equal((await request(app).post('/api/auth/login').send({ email: 'sara@alpha.test', password: 'Strong-Pass-1' })).status, 200);

      const ownerMembership = (await agent.get('/api/team')).body.members.find(m => m.isOwner).id;
      assert.equal((await agent.patch(`/api/team/${ownerMembership}`).set('X-CSRF-Token', csrf).send({ status: 'inactive' })).body.code, 'team.self_deactivate');
      assert.equal((await agent.delete(`/api/team/${ownerMembership}`).set('X-CSRF-Token', csrf)).body.code, 'team.self_remove');
      assert.equal((await agent.delete(`/api/team/${id}`).set('X-CSRF-Token', csrf)).status, 200);
      assert.equal((await request(app).post('/api/auth/login').send({ email: 'sara@alpha.test', password: 'Strong-Pass-1' })).status, 403, 'removed single-workspace account is disabled');
      assert.ok(me);
    });

    test('admins cannot touch owners or grant permissions they lack', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.addMember(a.companyId, 'admin', 'admin@alpha.test');
      const mgr = await h.addMember(a.companyId, 'manager', 'mgr@alpha.test');
      const admin = await h.login(app, 'admin@alpha.test');
      const ownerId = (await admin.agent.get('/api/team')).body.members.find(m => m.isOwner).id;
      assert.equal((await admin.agent.patch(`/api/team/${ownerId}`).set('X-CSRF-Token', admin.csrf).send({ status: 'inactive' })).body.code, 'team.owner_only');
      assert.equal((await admin.agent.post(`/api/team/${ownerId}/password`).set('X-CSRF-Token', admin.csrf).send({ password: 'Owner-Takeover-1' })).body.code, 'team.owner_only');
      assert.equal((await admin.agent.patch(`/api/team/${mgr.membershipId}`).set('X-CSRF-Token', admin.csrf).send({ roleId: a.roles.owner })).body.code, 'team.owner_only');
      assert.equal((await admin.agent.patch(`/api/roles/${a.roles.owner}`).set('X-CSRF-Token', admin.csrf).send({ name: 'x' })).body.code, 'roles.owner_locked');

      // A custom role holder with roles.manage but not audit.view cannot grant audit.view.
      const owner = await h.login(app, 'a@alpha.test');
      const created = await owner.agent.post('/api/roles').set('X-CSRF-Token', owner.csrf).send({ name: 'Role admin', permissions: ['roles.manage', 'users.view'] });
      assert.equal(created.status, 201);
      const roleAdminRole = created.body.roles.find(r => r.name === 'Role admin');
      await owner.agent.patch(`/api/team/${mgr.membershipId}`).set('X-CSRF-Token', owner.csrf).send({ roleId: roleAdminRole.id });
      const ra = await h.login(app, 'mgr@alpha.test');
      const esc = await ra.agent.post('/api/roles').set('X-CSRF-Token', ra.csrf).send({ name: 'Sneaky', permissions: ['audit.view'] });
      assert.equal(esc.status, 403);
      assert.equal(esc.body.code, 'roles.escalation');
      assert.equal((await ra.agent.patch(`/api/roles/${roleAdminRole.id}`).set('X-CSRF-Token', ra.csrf).send({ permissions: ['roles.manage', 'users.view', 'audit.view'] })).body.code, 'roles.own_role');
    });

    test('custom roles: create, edit, protect in-use, delete', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      const created = await agent.post('/api/roles').set('X-CSRF-Token', csrf).send({ name: 'Shipping desk', permissions: ['orders.view', 'orders.manage'] });
      const role = created.body.roles.find(r => r.name === 'Shipping desk');
      assert.deepEqual(role.permissions.sort(), ['orders.manage', 'orders.view']);
      assert.equal((await agent.post('/api/roles').set('X-CSRF-Token', csrf).send({ name: 'Bad', permissions: ['does.not.exist'] })).status, 400);
      const edited = await agent.patch(`/api/roles/${role.id}`).set('X-CSRF-Token', csrf).send({ permissions: ['orders.view'] });
      assert.deepEqual(edited.body.roles.find(r => r.id === role.id).permissions, ['orders.view']);
      const m = await agent.post('/api/team').set('X-CSRF-Token', csrf).send({ name: 'S', email: 's@alpha.test', password: 'Strong-Pass-1', roleId: role.id });
      assert.equal((await agent.delete(`/api/roles/${role.id}`).set('X-CSRF-Token', csrf)).body.code, 'roles.in_use');
      await agent.patch(`/api/team/${m.body.member.id}`).set('X-CSRF-Token', csrf).send({ roleId: a.roles.employee });
      assert.equal((await agent.delete(`/api/roles/${role.id}`).set('X-CSRF-Token', csrf)).status, 200);
      assert.equal((await agent.delete(`/api/roles/${a.roles.employee}`).set('X-CSRF-Token', csrf)).body.code, 'roles.system_locked');
    });
  });

  describe('company settings & branding', () => {
    test('owner updates profile/settings; validation applies; audit records the change', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      const res = await agent.patch('/api/company').set('X-CSRF-Token', csrf).send({
        name: 'Alpha Trading', timezone: 'Asia/Riyadh', currency: 'SAR', defaultLocale: 'ar', taxRate: 15, quickReplies: ['Hello', ' ', 'Thanks']
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.profile.timezone, 'Asia/Riyadh');
      assert.deepEqual(res.body.settings.quickReplies, ['Hello', 'Thanks']);
      assert.equal((await agent.patch('/api/company').set('X-CSRF-Token', csrf).send({ timezone: 'Mars/Base' })).status, 400);
      assert.equal((await agent.patch('/api/company').set('X-CSRF-Token', csrf).send({ currency: 'XXX' })).status, 400);
      assert.equal((await agent.patch('/api/company/branding').set('X-CSRF-Token', csrf).send({ logoUrl: 'javascript:alert(1)' })).status, 400);
      const audit = (await agent.get('/api/audit')).body.entries;
      const entry = audit.find(e => e.action === 'company.settings_updated');
      assert.equal(entry.after.name, 'Alpha Trading');
      assert.equal(entry.before.name, 'Alpha');
    });

    test('logo upload validates content and stores under the company folder', async () => {
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const { agent, csrf } = await h.login(app, 'a@alpha.test');
      const bad = await agent.post('/api/company/branding/logo').set('X-CSRF-Token', csrf).attach('file', Buffer.from('<svg/>'), { filename: 'x.png', contentType: 'image/png' });
      assert.equal(bad.status, 400);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
      const ok = await agent.post('/api/company/branding/logo').set('X-CSRF-Token', csrf).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.url.startsWith(`/uploads/companies/${a.companyId}/`));
      assert.equal((await request(app).get(ok.body.url)).status, 200);
    });
  });

  describe('platform (super admin)', () => {
    test('only platform admins manage global branding; public endpoint reflects it', async () => {
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.createPlatformAdmin('root@platform.test');
      const owner = await h.login(app, 'a@alpha.test');
      assert.equal((await owner.agent.patch('/api/platform/settings').set('X-CSRF-Token', owner.csrf).send({ appName: 'Hacked' })).status, 403);
      assert.equal((await owner.agent.get('/api/platform/companies')).status, 403);

      const root = await h.platformLogin(app, 'root@platform.test');
      assert.equal(root.me.user.isPlatformAdmin, true);
      assert.equal(root.me.company, null);
      const res = await root.agent.patch('/api/platform/settings').set('X-CSRF-Token', root.csrf).send({
        appName: 'SalesHub', primaryColor: '#0EA5E9', defaultLocale: 'ar', loginHeading: { ar: 'مرحباً', en: 'Welcome' }
      });
      assert.equal(res.status, 200);
      const pub = (await request(app).get('/api/public/branding')).body;
      assert.equal(pub.appName, 'SalesHub');
      assert.equal(pub.primaryColor, '#0ea5e9');
      assert.equal(pub.loginHeading.ar, 'مرحباً');
      assert.equal((await root.agent.patch('/api/platform/settings').set('X-CSRF-Token', root.csrf).send({ fontFamily: 'Comic Sans' })).status, 400);
      const companies = (await root.agent.get('/api/platform/companies')).body.companies;
      assert.equal(companies.length, 1);
      assert.equal(companies[0].members, 1);
    });

    test('public branding never exposes private fields', async () => {
      const pub = (await request(app).get('/api/public/branding')).body;
      assert.equal(pub.updated_by, undefined);
      assert.equal(pub.updatedBy, undefined);
    });
  });
});
