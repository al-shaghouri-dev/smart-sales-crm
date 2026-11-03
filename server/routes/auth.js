const express = require('express');
const { rateLimit } = require('express-rate-limit');
const v = require('../validate');
const { hashPassword, verifyPassword, dummyVerify, validatePassword, MIN_LENGTH } = require('../security/passwords');
const { COOKIE, cookieOptions, createSession, requireAuth } = require('../middleware/session');
const { unauthorized, forbidden, badRequest, notFound } = require('../errors');
const { audit } = require('../services/audit');

const brandingOut = b => b && ({
  displayName: b.display_name, logoUrl: b.logo_url,
  primaryColor: b.primary_color, secondaryColor: b.secondary_color, accentColor: b.accent_color
});

/** Everything the frontend needs to render the signed-in shell. */
async function buildMe(db, req) {
  return db.withContext({ userId: req.user.id, companyId: req.session.company_id }, async trx => {
    const companies = await trx('company_memberships as m').join('companies as c', 'c.id', 'm.company_id')
      .where('m.user_id', req.user.id).orderBy('c.name')
      .select('c.id', 'c.name', 'c.status', 'm.status as membership_status');
    let company = null;
    if (req.companyRecord) {
      const c = req.companyRecord;
      const branding = await trx('company_branding').where({ company_id: c.id }).first();
      company = {
        id: c.id, name: c.name, status: c.status, timezone: c.timezone, currency: c.currency,
        defaultLocale: c.default_locale, branding: req.company ? brandingOut(branding) : null
      };
    }
    return {
      ok: true,
      csrfToken: req.session.csrf_token,
      user: {
        id: req.user.id, email: req.user.email, name: req.user.name, phone: req.user.phone,
        locale: req.user.locale, theme: req.user.theme, isPlatformAdmin: req.user.is_platform_admin
      },
      company,
      companyAccess: req.company ? 'active' : (req.companyRecord ? (req.membership?.status === 'inactive' ? 'membership_inactive' : req.companyRecord.status) : 'none'),
      membership: req.company && req.membership ? { roleId: req.membership.role_id, roleKey: req.membership.role_key, roleName: req.membership.role_name, isOwner: req.membership.is_owner } : null,
      permissions: [...req.permissions],
      companies: companies.map(c => ({ id: c.id, name: c.name, status: c.status, membershipStatus: c.membership_status }))
    };
  });
}

/** Prefer a company the user can actually use; otherwise the first one (to show its status). */
async function pickCompany(db, userId, preferredId) {
  return db.withContext({ userId }, async trx => {
    const rows = await trx('company_memberships as m').join('companies as c', 'c.id', 'm.company_id')
      .where('m.user_id', userId).orderBy('m.created_at').select('c.id', 'c.status', 'm.status as ms');
    if (preferredId) return rows.find(r => r.id === preferredId)?.id || null;
    return (rows.find(r => r.status === 'active' && r.ms === 'active') || rows[0])?.id || null;
  });
}

module.exports = function authRoutes({ db, config }) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: config.loginRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, code: 'auth.rate_limited', error: 'Too many attempts, try again later' })
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const email = v.email(req.body?.email);
    const password = String(req.body?.password || '');
    const row = (await db.knex.raw('SELECT * FROM auth_user_for_login(?)', [email])).rows[0];
    const ok = row ? await verifyPassword(password, row.password_hash) : await dummyVerify(password);
    if (!row || !ok) {
      await db.withContext({}, trx => audit(trx, null, { action: 'auth.login_failed', entityType: 'user', after: { email } }));
      throw unauthorized('auth.invalid_credentials', 'Invalid email or password');
    }
    if (row.status !== 'active') throw forbidden('auth.account_disabled', 'This account is disabled');

    const companyId = await pickCompany(db, row.id);
    const { token } = await createSession(db, config, { userId: row.id, companyId, req });
    await db.withContext({ userId: row.id, companyId }, async trx => {
      await trx('users').where({ id: row.id }).update({ last_login_at: trx.fn.now() });
      await audit(trx, { user: { id: row.id, email }, ip: req.ip, get: h => req.get(h) }, { action: 'auth.login', companyId, entityType: 'user', entityId: row.id });
    });
    res.cookie(COOKIE, token, cookieOptions(config));
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    if (!req.user) throw unauthorized();
    res.json(await buildMe(db, req));
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await db.knex('sessions').where({ id: req.session.id }).del();
    res.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  router.post('/switch-company', requireAuth, async (req, res) => {
    const companyId = v.uuid(req.body?.companyId, { field: 'companyId' });
    const target = await pickCompany(db, req.user.id, companyId);
    if (!target) throw notFound('company.not_found');
    await db.knex('sessions').where({ id: req.session.id }).update({ company_id: target });
    res.json({ ok: true });
  });

  router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!validatePassword(newPassword)) throw badRequest('validation.password', `Password must be at least ${MIN_LENGTH} characters`);
    const row = (await db.knex.raw('SELECT * FROM auth_user_for_login(?)', [req.user.email])).rows[0];
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw badRequest('auth.wrong_password', 'Current password is incorrect');
    const hash = await hashPassword(newPassword);
    await db.withContext({ userId: req.user.id }, async trx => {
      await trx('users').where({ id: req.user.id }).update({ password_hash: hash, password_changed_at: trx.fn.now() });
      await audit(trx, req, { action: 'user.password_changed', entityType: 'user', entityId: req.user.id });
    });
    // Sign out every other session of this user.
    await db.knex('sessions').where({ user_id: req.user.id }).whereNot({ id: req.session.id }).del();
    res.json({ ok: true });
  });

  return router;
};

module.exports.buildMe = buildMe;
