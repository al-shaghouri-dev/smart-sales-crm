const crypto = require('crypto');
const { unauthorized, forbidden, AppError } = require('../errors');
const { accessFor } = require('../services/subscriptions');

const COOKIE = 'sscrm_session';
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

const ttlHours = (config, kind) => (kind === 'platform' ? config.platformSessionTtlHours || 4 : config.sessionTtlHours);

function cookieOptions(config, kind = 'company') {
  return { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: ttlHours(config, kind) * 3600 * 1000 };
}

/**
 * kind "company"  – workspace session (company context, company permissions)
 * kind "platform" – Super Admin console session (no company context; only /api/platform)
 */
async function createSession(db, config, { userId, companyId, req, kind = 'company' }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  await db.knex('sessions').insert({
    id: sha256(token), user_id: userId, company_id: kind === 'platform' ? null : (companyId || null), csrf_token: csrf, kind,
    ip: req.ip || null, user_agent: String(req.get('user-agent') || '').slice(0, 300),
    expires_at: new Date(Date.now() + ttlHours(config, kind) * 3600 * 1000)
  });
  // Opportunistic cleanup of expired sessions.
  db.knex('sessions').where('expires_at', '<', new Date()).del().catch(() => {});
  return { token, csrf };
}

/** Load (but do not require) the session, user, active company and permissions. */
function loadSession(db) {
  return async (req, _res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (!token) return next();
      const session = await db.knex('sessions').where({ id: sha256(token) }).where('expires_at', '>', new Date()).first();
      if (!session) return next();

      const loaded = await db.withContext({ userId: session.user_id, companyId: session.company_id }, async trx => {
        const user = await trx('users').where({ id: session.user_id })
          .first('id', 'email', 'name', 'phone', 'status', 'is_platform_admin', 'locale', 'theme');
        if (!user || user.status !== 'active') return null;
        if (session.kind === 'platform' && !user.is_platform_admin) return null;
        let company = null, membership = null, permissions = [], subscription = null;
        if (session.kind === 'company' && session.company_id) {
          company = await trx('companies').where({ id: session.company_id }).first();
          membership = await trx('company_memberships as m').join('roles as r', 'r.id', 'm.role_id')
            .where({ 'm.company_id': session.company_id, 'm.user_id': user.id })
            .first('m.id', 'm.status', 'm.role_id', 'r.key as role_key', 'r.name as role_name', 'r.is_owner');
          if (membership && membership.status === 'active') {
            permissions = await trx('role_permissions').where({ role_id: membership.role_id, company_id: session.company_id }).pluck('permission_key');
          }
          subscription = await trx('subscriptions').where({ company_id: session.company_id }).first();
          if (subscription) subscription.plan = await trx('plans').where({ id: subscription.plan_id }).first();
        }
        return { user, company, membership, permissions, subscription };
      });
      if (!loaded) return next();

      req.session = session;
      req.user = loaded.user;
      req.companyRecord = loaded.company;
      req.membership = loaded.membership;
      // Company access requires an active company AND an active membership.
      const usable = loaded.company && loaded.company.status === 'active' && loaded.membership && loaded.membership.status === 'active';
      req.company = usable ? loaded.company : null;
      req.permissions = new Set(usable ? loaded.permissions : []);
      req.subscription = usable ? loaded.subscription : null;
      req.isPlatformSession = session.kind === 'platform';

      if (Date.now() - new Date(session.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
        db.knex('sessions').where({ id: session.id }).update({ last_seen_at: new Date() }).catch(() => {});
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!SAFE_METHODS.has(req.method)) {
    const given = Buffer.from(String(req.get('x-csrf-token') || ''));
    const expected = Buffer.from(req.session.csrf_token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return next(forbidden('auth.csrf', 'Invalid CSRF token'));
    }
  }
  next();
}

function requireCompany(req, _res, next) {
  if (req.company) return next();
  const status = req.companyRecord?.status;
  if (status === 'suspended') return next(forbidden('company.suspended', 'This company account is suspended'));
  if (status === 'pending') return next(forbidden('company.pending', 'This company account is awaiting activation'));
  return next(forbidden('company.no_access', 'No active company workspace'));
}

/** Passes if the member holds ANY of the listed permissions. */
const requirePermission = (...keys) => (req, _res, next) => {
  if (keys.some(k => req.permissions?.has(k))) return next();
  next(forbidden());
};

/** Super Admin APIs require a dedicated platform session — a workspace session never qualifies. */
function requirePlatformAdmin(req, _res, next) {
  if (req.user?.is_platform_admin && req.isPlatformSession) return next();
  next(forbidden('platform.forbidden', 'Platform administrators only'));
}

/**
 * Applies the platform's expired-subscription policy to workspace APIs.
 * Data is never deleted; access is reduced to read-only or to the billing page.
 */
function enforceSubscription(db) {
  let cache = { at: 0, policy: 'read_only' };
  const policy = async () => {
    if (Date.now() - cache.at < 30_000) return cache.policy;
    const row = await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first('expired_access_policy'));
    cache = { at: Date.now(), policy: row?.expired_access_policy || 'read_only' };
    return cache.policy;
  };
  const middleware = async (req, _res, next) => {
    try {
      if (!req.company || !req.subscription) return next();
      const access = accessFor(req.subscription, await policy());
      req.subscriptionAccess = access;
      if (access === 'full') return next();
      const safe = SAFE_METHODS.has(req.method);
      const billingArea = /^\/api\/(billing|notifications)(\/|$)/.test(req.originalUrl);
      if (access === 'read_only' && (safe || (billingArea && req.method === 'POST'))) return next();
      if (access === 'blocked' && billingArea) return next();
      next(new AppError(402, access === 'blocked' ? 'subscription.blocked' : 'subscription.read_only', 'Subscription inactive'));
    } catch (error) { next(error); }
  };
  middleware.invalidate = () => { cache.at = 0; };
  return middleware;
}

module.exports = { COOKIE, sha256, cookieOptions, createSession, loadSession, requireAuth, requireCompany, requirePermission, requirePlatformAdmin, enforceSubscription };
