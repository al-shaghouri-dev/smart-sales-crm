const express = require('express');
const { rateLimit } = require('express-rate-limit');
const v = require('../validate');
const { hashPassword, verifyPassword, dummyVerify, validatePassword, MIN_LENGTH } = require('../security/passwords');
const { COOKIE, cookieOptions, createSession, requireAuth } = require('../middleware/session');
const { unauthorized, forbidden, badRequest, notFound } = require('../errors');
const { audit } = require('../services/audit');
const { issueToken, findToken, consumeToken, linkFor, invalidToken } = require('../services/tokens');
const { compose } = require('../services/mailer');
const { summary } = require('../services/subscriptions');
const { planFeaturesFor } = require('../middleware/plan');

const brandingOut = b => b && ({
  displayName: b.display_name, logoUrl: b.logo_url,
  primaryColor: b.primary_color, secondaryColor: b.secondary_color, accentColor: b.accent_color
});

/** Everything the frontend needs to render the signed-in shell. */
async function buildMe(db, req) {
  const user = {
    id: req.user.id, email: req.user.email, name: req.user.name, phone: req.user.phone,
    locale: req.user.locale, theme: req.user.theme, isPlatformAdmin: req.user.is_platform_admin
  };
  if (req.isPlatformSession) {
    return { ok: true, sessionKind: 'platform', csrfToken: req.session.csrf_token, user, company: null, companyAccess: 'none', membership: null, permissions: [], companies: [], subscription: null };
  }
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
    let subscription = null;
    if (req.company && req.subscription) {
      const policy = (await trx('platform_settings').where({ id: 1 }).first('expired_access_policy')).expired_access_policy;
      const full = summary(req.subscription, req.subscription.plan, policy);
      // Everyone needs to know the access state; only billing viewers see plan & dates.
      subscription = req.permissions.has('billing.view') ? full : { access: full.access, status: full.status };
    }
    return {
      ok: true,
      sessionKind: 'company',
      csrfToken: req.session.csrf_token,
      user,
      company,
      companyAccess: req.company ? 'active' : (req.companyRecord ? (req.membership?.status === 'inactive' ? 'membership_inactive' : req.companyRecord.status) : 'none'),
      membership: req.company && req.membership ? { id: req.membership.id, roleId: req.membership.role_id, roleKey: req.membership.role_key, roleName: req.membership.role_name, isOwner: req.membership.is_owner } : null,
      permissions: [...req.permissions],
      companies: companies.map(c => ({ id: c.id, name: c.name, status: c.status, membershipStatus: c.membership_status })),
      subscription,
      // null = no subscription (no plan restrictions); otherwise the plan's feature keys.
      planFeatures: req.company ? planFeaturesFor(req.subscription) : null
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

const actor = (req, row, email) => ({ user: { id: row.id, email }, ip: req.ip, get: h => req.get(h) });

module.exports = function authRoutes({ db, config, mailer }) {
  const router = express.Router();
  const limiter = (limit, windowMs = 15 * 60 * 1000) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, code: 'auth.rate_limited', error: 'Too many attempts, try again later' })
  });
  const loginLimiter = limiter(config.loginRateLimit);
  const recoveryLimiter = limiter(config.recoveryRateLimit || 5);
  const tokenLimiter = limiter(config.tokenRateLimit || 30);

  /** Shared credential check; records failures in the audit log. */
  async function checkCredentials(req) {
    const email = v.email(req.body?.email);
    const password = String(req.body?.password || '');
    const row = (await db.knex.raw('SELECT * FROM auth_user_for_login(?)', [email])).rows[0];
    const ok = row ? await verifyPassword(password, row.password_hash) : await dummyVerify(password);
    if (!row || !ok) {
      await db.withContext({}, trx => audit(trx, null, { action: 'auth.login_failed', entityType: 'user', after: { email } }));
      throw unauthorized('auth.invalid_credentials', 'Invalid email or password');
    }
    if (row.status === 'invited') throw forbidden('auth.invitation_pending', 'Accept your invitation to activate this account');
    if (row.status !== 'active') throw forbidden('auth.account_disabled', 'This account is disabled');
    return { row, email };
  }

  // ---- Workspace sign-in ----
  router.post('/login', loginLimiter, async (req, res) => {
    const { row, email } = await checkCredentials(req);
    const companyId = await pickCompany(db, row.id);
    if (!companyId) {
      const platform = (await db.knex.raw('SELECT app_user_is_platform_admin(?) AS p', [row.id])).rows[0].p;
      if (platform) throw forbidden('auth.use_platform_login', 'Use the admin console sign-in');
    }
    const { token } = await createSession(db, config, { userId: row.id, companyId, req });
    await db.withContext({ userId: row.id, companyId }, async trx => {
      await trx('users').where({ id: row.id }).update({ last_login_at: trx.fn.now() });
      await audit(trx, actor(req, row, email), { action: 'auth.login', companyId, entityType: 'user', entityId: row.id });
    });
    res.cookie(COOKIE, token, cookieOptions(config));
    res.json({ ok: true });
  });

  // ---- Super Admin console sign-in (separate, shorter session, no company context) ----
  router.post('/platform-login', loginLimiter, async (req, res) => {
    const { row, email } = await checkCredentials(req);
    const platform = (await db.knex.raw('SELECT app_user_is_platform_admin(?) AS p', [row.id])).rows[0].p;
    if (!platform) {
      await db.withContext({}, trx => audit(trx, actor(req, row, email), { action: 'platform.login_denied', entityType: 'user', entityId: row.id }));
      throw unauthorized('auth.invalid_credentials', 'Invalid email or password');
    }
    const { token } = await createSession(db, config, { userId: row.id, req, kind: 'platform' });
    await db.withContext({ userId: row.id, platformAdmin: true }, async trx => {
      await trx('users').where({ id: row.id }).update({ last_login_at: trx.fn.now() });
      await audit(trx, actor(req, row, email), { action: 'platform.login', entityType: 'user', entityId: row.id });
    });
    res.cookie(COOKIE, token, cookieOptions(config, 'platform'));
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    if (!req.user) throw unauthorized();
    res.json(await buildMe(db, req));
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await db.knex('sessions').where({ id: req.session.id }).del();
    req.app.locals.realtime?.disconnectSession(req.session.id);
    res.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  router.post('/switch-company', requireAuth, async (req, res) => {
    if (req.isPlatformSession) throw forbidden('platform.no_company', 'Admin console sessions have no workspace');
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

  // ---- Self-service password reset (email). Same response whether or not the account exists. ----
  router.post('/forgot-password', recoveryLimiter, async (req, res) => {
    const email = v.email(req.body?.email);
    const row = (await db.knex.raw('SELECT * FROM auth_user_for_login(?)', [email])).rows[0];
    if (row && row.status === 'active' && mailer.enabled) {
      const token = await db.withContext({ userId: row.id }, trx => issueToken(trx, { purpose: 'password_reset', userId: row.id }));
      const { app, locale } = await db.withContext({ userId: row.id }, async trx => ({
        app: (await trx('platform_settings').where({ id: 1 }).first('app_name')).app_name,
        locale: (await trx('users').where({ id: row.id }).first('locale')).locale
      }));
      await mailer.send({ to: email, ...compose('password_reset', locale || req.body?.locale, app, null, linkFor(config, 'password_reset', token)) });
      await db.withContext({}, trx => audit(trx, actor(req, row, email), { action: 'auth.reset_requested', entityType: 'user', entityId: row.id }));
    }
    res.json({ ok: true, emailEnabled: mailer.enabled });
  });

  // ---- Invitation / reset links ----
  // Tokens are accepted only in POST bodies (never in URL paths or query strings) so they cannot
  // end up in access logs. Lookup does not consume the token; acceptance is atomic and one-time.
  const tokenFrom = body => String(body?.token || '');

  router.post('/token/inspect', tokenLimiter, async (req, res) => {
    const token = await findToken(db.knex, tokenFrom(req.body));
    if (!token) throw invalidToken();
    const info = await db.withContext({ userId: token.user_id, companyId: token.company_id }, async trx => {
      const user = await trx('users').where({ id: token.user_id }).first('email', 'name', 'status');
      const company = token.company_id ? await trx('companies').where({ id: token.company_id }).first('name') : null;
      return { user, company };
    });
    if (!info.user || info.user.status === 'disabled') throw invalidToken();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, purpose: token.purpose, email: info.user.email, name: info.user.name, companyName: info.company?.name || null, expiresAt: token.expires_at });
  });

  router.post('/token/accept', tokenLimiter, async (req, res) => {
    const token = await findToken(db.knex, tokenFrom(req.body));
    if (!token) throw invalidToken();
    if (!validatePassword(req.body?.password)) throw badRequest('validation.password', `Password must be at least ${MIN_LENGTH} characters`, { field: 'password' });
    const name = token.purpose === 'invite' ? v.str(req.body?.name, { field: 'name', max: 120 }) : undefined;
    const hash = await hashPassword(req.body.password);
    await db.withContext({ userId: token.user_id, companyId: token.company_id }, async trx => {
      if (!(await consumeToken(trx, token.id))) throw invalidToken();
      const user = await trx('users').where({ id: token.user_id }).first('id', 'email', 'status');
      if (!user || user.status === 'disabled') throw invalidToken();
      await trx('users').where({ id: user.id }).update({
        password_hash: hash, password_changed_at: trx.fn.now(), status: 'active', ...(name ? { name } : {})
      });
      // Any other outstanding links for this account stop working.
      await trx('auth_tokens').where({ user_id: user.id }).whereNull('used_at').update({ used_at: trx.fn.now() });
      await audit(trx, { user: { id: user.id, email: user.email }, ip: req.ip, get: h => req.get(h) }, {
        action: token.purpose === 'invite' ? 'auth.invitation_accepted' : 'auth.password_reset', companyId: token.company_id, entityType: 'user', entityId: user.id
      });
    });
    // Every existing session of this account ends immediately (new password required everywhere).
    await db.knex('sessions').where({ user_id: token.user_id }).del();
    req.app.locals.realtime?.disconnectUser(token.user_id);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  return router;
};

module.exports.buildMe = buildMe;
