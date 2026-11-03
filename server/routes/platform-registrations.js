const express = require('express');
const { rateLimit } = require('express-rate-limit');
const v = require('../validate');
const { badRequest, conflict, forbidden, notFound } = require('../errors');
const { audit } = require('../services/audit');
const { createCompany } = require('../services/companies');
const { linkFor } = require('../services/tokens');
const { compose } = require('../services/mailer');
const { planOut } = require('./platform-plans');

const out = r => ({
  id: r.id, companyName: r.company_name, businessType: r.business_type, country: r.country, companyPhone: r.company_phone,
  ownerName: r.owner_name, ownerEmail: r.owner_email, ownerPhone: r.owner_phone, planId: r.plan_id, planName: r.plan_name || null,
  locale: r.locale, status: r.status, messageToApplicant: r.message_to_applicant, internalNote: r.internal_note,
  reviewedAt: r.reviewed_at, companyId: r.company_id, createdAt: r.created_at
});

/** Public: list of plans to choose from, and the registration form submission. */
function publicRegistrationRoutes({ db, config }) {
  const router = express.Router();
  const submitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: config.registrationRateLimit || 5, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, code: 'auth.rate_limited', error: 'Too many attempts' })
  });

  router.get('/plans', async (_req, res) => {
    const plans = await db.withContext({}, trx => trx('plans').where({ is_active: true, is_public: true }).orderBy('sort'));
    res.json({ plans: plans.map(p => { const o = planOut(p); delete o.isPublic; delete o.isActive; return o; }) });
  });

  router.post('/register', submitLimiter, async (req, res) => {
    const b = req.body || {};
    // Honeypot: real users never fill this hidden field.
    if (b.website) return res.status(202).json({ ok: true });
    const settings = await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first('registration_enabled'));
    if (!settings.registration_enabled) throw forbidden('registration.closed', 'Registration is currently closed');
    const row = {
      company_name: v.str(b.companyName, { field: 'companyName', required: true, max: 120 }),
      business_type: v.str(b.businessType, { field: 'businessType', max: 120 }) ?? null,
      country: v.str(b.country, { field: 'country', max: 80 }) ?? null,
      company_phone: v.str(b.companyPhone, { field: 'companyPhone', max: 40 }) ?? null,
      owner_name: v.str(b.ownerName, { field: 'ownerName', required: true, max: 120 }),
      owner_email: v.email(b.ownerEmail, { field: 'ownerEmail' }),
      owner_phone: v.str(b.ownerPhone, { field: 'ownerPhone', required: true, max: 40 }),
      plan_id: b.planId ? v.uuid(b.planId, { field: 'planId' }) : null,
      locale: v.oneOf(b.locale || 'en', v.LOCALES, { field: 'locale' }),
      ip: req.ip || null
    };
    await db.withContext({}, async trx => {
      if (row.plan_id && !(await trx('plans').where({ id: row.plan_id, is_active: true, is_public: true }).first('id'))) {
        throw badRequest('plans.not_found', 'Plan not available', { field: 'planId' });
      }
      await trx('registration_requests').insert(row);
    });
    // Deliberately no request id or status lookup: applicants cannot enumerate requests.
    res.status(201).json({ ok: true });
  });

  return router;
}

/** Super Admin review of registration requests. */
function registrationAdminRoutes({ db, config, mailer }) {
  const router = express.Router();
  const platform = (req, fn) => db.withContext({ userId: req.user.id, platformAdmin: true }, fn);
  const base = trx => trx('registration_requests as r').leftJoin('plans as p', 'p.id', 'r.plan_id').select('r.*', 'p.name as plan_name');

  async function load(trx, id) {
    const r = await base(trx).where('r.id', v.uuid(id)).first();
    if (!r) throw notFound('registration.not_found', 'Request not found');
    return r;
  }
  const open = r => { if (!['pending', 'info_requested'].includes(r.status)) throw conflict('registration.closed_request', 'This request was already processed'); };

  router.get('/', async (req, res) => {
    const status = v.oneOf(req.query.status || undefined, ['pending', 'info_requested', 'approved', 'rejected'], { field: 'status' });
    const rows = await platform(req, trx => { const q = base(trx).orderBy('r.created_at', 'desc').limit(500); if (status) q.where('r.status', status); return q; });
    res.json({ requests: rows.map(out) });
  });

  router.post('/:id/approve', async (req, res) => {
    const b = req.body || {};
    const result = await platform(req, async trx => {
      const r = await load(trx, req.params.id);
      open(r);
      const planId = b.subscription?.planId || r.plan_id;
      const created = await createCompany(trx, req, {
        name: v.str(b.companyName, { field: 'companyName', max: 120 }) || r.company_name,
        businessType: r.business_type, country: r.country, phone: r.company_phone,
        ownerName: r.owner_name, ownerEmail: r.owner_email, ownerPhone: r.owner_phone,
        defaultLocale: r.locale, timezone: v.timezone(b.timezone) || 'UTC',
        currency: b.currency || 'USD',
        status: v.oneOf(b.status || 'active', ['active', 'pending'], { field: 'status' }),
        subscription: planId ? {
          planId: v.uuid(planId, { field: 'planId' }), status: b.subscription?.status || 'active', trial: Boolean(b.subscription?.trial),
          periods: b.subscription?.periods ? Number(b.subscription.periods) : undefined
        } : null
      });
      await trx('registration_requests').where({ id: r.id }).update({
        status: 'approved', company_id: created.companyId, reviewed_by: req.user.id, reviewed_at: trx.fn.now(),
        internal_note: v.str(b.internalNote, { field: 'internalNote', max: 1000 }) ?? r.internal_note, updated_at: trx.fn.now()
      });
      await audit(trx, req, { action: 'registration.approved', companyId: created.companyId, entityType: 'registration', entityId: r.id, after: { companyId: created.companyId } });
      return { created, request: r };
    });
    let invitation = null;
    if (result.created.inviteToken) {
      const link = linkFor(config, 'invite', result.created.inviteToken);
      let emailSent = false;
      if (mailer.enabled) {
        const app = (await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first('app_name'))).app_name;
        emailSent = (await mailer.send({ to: result.request.owner_email, ...compose('invite', result.request.locale, app, result.request.company_name, link) })).delivered;
      }
      invitation = { emailSent, link: emailSent ? undefined : link };
    }
    res.json({ ok: true, companyId: result.created.companyId, existingAccount: result.created.existingAccount, invitation });
  });

  async function close(req, status, action) {
    const message = v.str(req.body?.message, { field: 'message', required: status === 'info_requested', max: 1000 }) ?? null;
    const r = await platform(req, async trx => {
      const row = await load(trx, req.params.id);
      open(row);
      await trx('registration_requests').where({ id: row.id }).update({
        status, message_to_applicant: message, reviewed_by: req.user.id, reviewed_at: trx.fn.now(), updated_at: trx.fn.now()
      });
      await audit(trx, req, { action, entityType: 'registration', entityId: row.id, after: { status, message } });
      return row;
    });
    let emailSent = false;
    if (mailer.enabled && message) {
      emailSent = (await mailer.send({ to: r.owner_email, subject: r.company_name, text: message })).delivered;
    }
    return { ok: true, emailSent };
  }
  router.post('/:id/reject', async (req, res) => res.json(await close(req, 'rejected', 'registration.rejected')));
  router.post('/:id/request-info', async (req, res) => res.json(await close(req, 'info_requested', 'registration.info_requested')));

  router.patch('/:id', async (req, res) => {
    const note = v.str(req.body?.internalNote, { field: 'internalNote', max: 1000 });
    await platform(req, async trx => {
      const r = await load(trx, req.params.id);
      await trx('registration_requests').where({ id: r.id }).update({ internal_note: note, updated_at: trx.fn.now() });
    });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { publicRegistrationRoutes, registrationAdminRoutes };
