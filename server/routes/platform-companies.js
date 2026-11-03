const express = require('express');
const v = require('../validate');
const { badRequest, conflict, notFound } = require('../errors');
const { audit } = require('../services/audit');
const { createCompany, upsertSubscription } = require('../services/companies');
const { issueToken, linkFor } = require('../services/tokens');
const { compose } = require('../services/mailer');
const { addPeriod, summary } = require('../services/subscriptions');
const { CURRENCIES } = require('./platform-plans');

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'mobile_wallet', 'other'];
const SUB_STATUSES = ['pending', 'active', 'expired', 'suspended', 'cancelled'];

const companyOut = c => ({
  id: c.id, name: c.name, slug: c.slug, status: c.status, email: c.email, phone: c.phone, country: c.country, address: c.address,
  businessType: c.business_type, timezone: c.timezone, currency: c.currency, defaultLocale: c.default_locale,
  suspendedAt: c.suspended_at, suspensionReason: c.suspension_reason, createdAt: c.created_at
});
const paymentOut = p => ({
  id: p.id, amount: Number(p.amount), currency: p.currency, paidAt: p.paid_at, method: p.method, reference: p.reference, notes: p.notes,
  provider: p.provider, periodStart: p.period_start, periodEnd: p.period_end, createdAt: p.created_at
});
const dateOrUndefined = (value, field) => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest('validation.invalid', `${field} is not a valid date`, { field });
  return d;
};

/** Validate the subscription part of a request body. */
function parseSubscription(b) {
  if (!b || !b.planId) return null;
  const periods = b.periods === undefined ? undefined : Number(b.periods);
  if (periods !== undefined && (!Number.isInteger(periods) || periods < 1 || periods > 120)) throw badRequest('validation.number', 'periods is invalid', { field: 'periods' });
  return v.compact({
    planId: v.uuid(b.planId, { field: 'planId' }),
    status: v.oneOf(b.status || 'active', SUB_STATUSES, { field: 'status' }),
    interval: v.oneOf(b.interval, ['month', 'year', 'custom'], { field: 'interval' }) ?? undefined,
    durationDays: b.durationDays === undefined ? undefined : v.number(b.durationDays, { field: 'durationDays', min: 1, max: 3650 }),
    startsAt: dateOrUndefined(b.startsAt, 'startsAt'),
    endsAt: dateOrUndefined(b.endsAt, 'endsAt'),
    periods,
    price: b.price === undefined || b.price === '' ? undefined : v.number(b.price, { field: 'price', max: 1e8 }),
    currency: v.oneOf(b.currency, CURRENCIES, { field: 'currency' }) ?? undefined,
    trial: b.trial === undefined ? undefined : Boolean(b.trial),
    notes: v.str(b.notes, { field: 'notes', max: 1000 }) ?? undefined
  });
}

module.exports = function companyAdminRoutes({ db, config, mailer }) {
  const router = express.Router();
  const platform = (req, fn) => db.withContext({ userId: req.user.id, platformAdmin: true }, fn);

  async function loadCompany(trx, id) {
    const c = await trx('companies').where({ id: v.uuid(id) }).first();
    if (!c) throw notFound('company.not_found', 'Company not found');
    return c;
  }
  async function appName(trx) { return (await trx('platform_settings').where({ id: 1 }).first('app_name')).app_name; }

  /** Email a one-time link when email is configured; otherwise hand it back (once) to the Super Admin. */
  async function deliver(email, locale, purpose, token, companyName) {
    const link = linkFor(config, purpose, token);
    let emailSent = false;
    if (mailer.enabled) {
      const app = await db.withContext({}, appName);
      emailSent = (await mailer.send({ to: email, ...compose(purpose, locale, app, companyName, link) })).delivered;
    }
    return { emailSent, link: emailSent ? undefined : link };
  }

  // ---- List with search & filters ----
  router.get('/', async (req, res) => {
    const search = v.str(req.query.search, { field: 'search', max: 100 });
    const status = v.oneOf(req.query.status || undefined, ['active', 'pending', 'suspended'], { field: 'status' });
    const subStatus = v.oneOf(req.query.subscription || undefined, [...SUB_STATUSES, 'none'], { field: 'subscription' });
    const planId = req.query.plan ? v.uuid(req.query.plan, { field: 'plan' }) : null;
    const rows = await platform(req, trx => {
      const q = trx('companies as c')
        .leftJoin('subscriptions as s', 's.company_id', 'c.id')
        .leftJoin('plans as p', 'p.id', 's.plan_id')
        .select('c.*', 's.status as sub_status', 's.ends_at as sub_ends_at', 'p.name as plan_name', 'p.id as plan_id',
          trx.raw('(SELECT count(*) FROM company_memberships m WHERE m.company_id = c.id AND m.status = ?)::int AS members', ['active']))
        .orderBy('c.created_at', 'desc').limit(500);
      if (search) q.where(w => w.whereILike('c.name', `%${search}%`).orWhereILike('c.email', `%${search}%`).orWhereILike('c.slug', `%${search}%`));
      if (status) q.where('c.status', status);
      if (subStatus === 'none') q.whereNull('s.id'); else if (subStatus) q.where('s.status', subStatus);
      if (planId) q.where('s.plan_id', planId);
      return q;
    });
    res.json({
      companies: rows.map(r => ({
        ...companyOut(r), members: r.members,
        subscription: r.sub_status ? { status: r.sub_status, endsAt: r.sub_ends_at, planId: r.plan_id, planName: r.plan_name } : null
      }))
    });
  });

  // ---- Manual creation ----
  router.post('/', async (req, res) => {
    const b = req.body || {};
    const owner = b.owner || {};
    const input = {
      name: v.str(b.name, { field: 'name', required: true, max: 120 }),
      email: b.email ? v.email(b.email, { field: 'email' }) : null,
      phone: v.str(b.phone, { field: 'phone', max: 40 }) ?? null,
      country: v.str(b.country, { field: 'country', max: 80 }) ?? null,
      businessType: v.str(b.businessType, { field: 'businessType', max: 120 }) ?? null,
      timezone: v.timezone(b.timezone) || 'UTC',
      currency: v.oneOf(b.currency || 'USD', CURRENCIES, { field: 'currency' }),
      defaultLocale: v.oneOf(b.defaultLocale || 'en', v.LOCALES, { field: 'defaultLocale' }),
      status: v.oneOf(b.status || 'active', ['active', 'pending'], { field: 'status' }),
      ownerName: v.str(owner.name, { field: 'owner.name', required: true, max: 120 }),
      ownerEmail: v.email(owner.email, { field: 'owner.email' }),
      ownerPhone: v.str(owner.phone, { field: 'owner.phone', max: 40 }) ?? null,
      subscription: parseSubscription(b.subscription)
    };
    const result = await platform(req, trx => createCompany(trx, req, input));
    const delivery = result.inviteToken ? await deliver(input.ownerEmail, input.defaultLocale, 'invite', result.inviteToken, input.name) : null;
    res.status(201).json({ ok: true, companyId: result.companyId, existingAccount: result.existingAccount, invitation: delivery });
  });

  // ---- Details ----
  router.get('/:id', async (req, res) => {
    const data = await platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      const [branding, members, sub, payments, activity, policy] = await Promise.all([
        trx('company_branding').where({ company_id: c.id }).first(),
        trx('company_memberships as m').join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
          .where('m.company_id', c.id).orderBy('m.created_at')
          .select('m.id', 'm.status', 'u.name', 'u.email', 'u.status as user_status', 'u.last_login_at', 'r.key as role_key', 'r.name as role_name', 'r.is_owner'),
        trx('subscriptions').where({ company_id: c.id }).first(),
        trx('payments').where({ company_id: c.id }).orderBy('paid_at', 'desc').limit(100),
        trx('audit_logs').where({ company_id: c.id }).orderBy('id', 'desc').limit(30).select('id', 'action', 'actor_email', 'created_at'),
        trx('platform_settings').where({ id: 1 }).first('expired_access_policy')
      ]);
      const plan = sub ? await trx('plans').where({ id: sub.plan_id }).first() : null;
      return { c, branding, members, sub, plan, payments, activity, policy: policy.expired_access_policy };
    });
    res.json({
      company: companyOut(data.c),
      branding: data.branding && { displayName: data.branding.display_name, logoUrl: data.branding.logo_url, primaryColor: data.branding.primary_color },
      members: data.members.map(m => ({
        id: m.id, name: m.name, email: m.email, status: m.status, invitationPending: m.user_status === 'invited', accountStatus: m.user_status,
        roleKey: m.role_key, roleName: m.role_name, isOwner: m.is_owner, lastLoginAt: m.last_login_at
      })),
      subscription: data.sub ? { ...summary(data.sub, data.plan, data.policy), notes: data.sub.notes } : null,
      payments: data.payments.map(paymentOut),
      activity: data.activity.map(a => ({ ...a, id: Number(a.id) }))
    });
  });

  // ---- Profile edit ----
  router.patch('/:id', async (req, res) => {
    const b = req.body || {};
    const patch = v.compact({
      name: v.str(b.name, { field: 'name', max: 120, min: 1 }) ?? undefined,
      email: b.email === '' || b.email === null ? null : (b.email !== undefined ? v.email(b.email, { field: 'email' }) : undefined),
      phone: v.str(b.phone, { field: 'phone', max: 40 }),
      country: v.str(b.country, { field: 'country', max: 80 }),
      address: v.str(b.address, { field: 'address', max: 300 }),
      business_type: v.str(b.businessType, { field: 'businessType', max: 120 }),
      timezone: v.timezone(b.timezone),
      currency: v.oneOf(b.currency, CURRENCIES, { field: 'currency' }) ?? undefined,
      default_locale: v.oneOf(b.defaultLocale, v.LOCALES, { field: 'defaultLocale' }) ?? undefined
    });
    const c = await platform(req, async trx => {
      const before = await loadCompany(trx, req.params.id);
      const [after] = await trx('companies').where({ id: before.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      await audit(trx, req, { action: 'company.updated', companyId: before.id, entityType: 'company', entityId: before.id, before: companyOut(before), after: companyOut(after) });
      return after;
    });
    res.json({ company: companyOut(c) });
  });

  // ---- Lifecycle: activate / suspend / reactivate (data is always preserved) ----
  async function setStatus(req, from, to, extra, action) {
    return platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      if (!from.includes(c.status)) throw conflict('company.invalid_transition', `Cannot change a ${c.status} company to ${to}`);
      const [after] = await trx('companies').where({ id: c.id }).update({ status: to, updated_at: trx.fn.now(), ...extra }).returning('*');
      await audit(trx, req, { action, companyId: c.id, entityType: 'company', entityId: c.id, before: { status: c.status }, after: { status: to, ...extra } });
      return after;
    });
  }
  router.post('/:id/activate', async (req, res) => {
    res.json({ company: companyOut(await setStatus(req, ['pending'], 'active', {}, 'company.activated')) });
  });
  router.post('/:id/suspend', async (req, res) => {
    const reason = v.str(req.body?.reason, { field: 'reason', required: true, max: 500 });
    const c = await setStatus(req, ['active', 'pending'], 'suspended', { suspended_at: new Date(), suspension_reason: reason }, 'company.suspended');
    await db.knex('sessions').where({ company_id: c.id }).del(); // members are signed out immediately
    res.json({ company: companyOut(c) });
  });
  router.post('/:id/reactivate', async (req, res) => {
    res.json({ company: companyOut(await setStatus(req, ['suspended'], 'active', { suspended_at: null, suspension_reason: null }, 'company.reactivated')) });
  });

  // ---- Owner onboarding / recovery link ----
  router.post('/:id/owner-link', async (req, res) => {
    const { owner, token, purpose, company } = await platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      const o = await trx('company_memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id')
        .where({ 'm.company_id': c.id, 'r.is_owner': true }).orderBy('m.created_at').first('u.id', 'u.email', 'u.status', 'u.locale');
      if (!o) throw notFound('team.not_found', 'Owner not found');
      if (o.status === 'disabled') throw badRequest('team.account_disabled', 'This account is disabled');
      const kind = o.status === 'invited' ? 'invite' : 'password_reset';
      const t = await issueToken(trx, { purpose: kind, userId: o.id, companyId: c.id, createdBy: req.user.id });
      await audit(trx, req, { action: kind === 'invite' ? 'company.owner_invite_resent' : 'company.owner_reset_link', companyId: c.id, entityType: 'user', entityId: o.id });
      return { owner: o, token: t, purpose: kind, company: c };
    });
    res.json({ ok: true, purpose, ...(await deliver(owner.email, owner.locale || company.default_locale, purpose, token, company.name)) });
  });

  // ---- Subscription ----
  router.put('/:id/subscription', async (req, res) => {
    const input = parseSubscription(req.body);
    if (!input) throw badRequest('validation.required', 'planId is required', { field: 'planId' });
    const sub = await platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      return upsertSubscription(trx, req, c.id, input);
    });
    res.json({ ok: true, subscriptionId: sub.id });
  });

  router.patch('/:id/subscription', async (req, res) => {
    const b = req.body || {};
    const status = v.oneOf(b.status, SUB_STATUSES, { field: 'status' }) ?? undefined;
    const endsAt = dateOrUndefined(b.endsAt, 'endsAt');
    const notes = v.str(b.notes, { field: 'notes', max: 1000 });
    await platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      const before = await trx('subscriptions').where({ company_id: c.id }).first();
      if (!before) throw notFound('subscription.not_found', 'No subscription');
      const patch = v.compact({ status, ends_at: endsAt, notes, updated_by: req.user.id, updated_at: new Date() });
      if (status === 'cancelled') patch.cancelled_at = new Date();
      if (status === 'active' && !before.starts_at) patch.starts_at = new Date();
      const next = { ...before, ...patch };
      if (next.status === 'active' && (!next.ends_at || new Date(next.ends_at) <= new Date())) {
        throw badRequest('subscription.needs_future_end', 'An active subscription needs a future end date', { field: 'endsAt' });
      }
      if (next.ends_at && next.starts_at && new Date(next.ends_at) <= new Date(next.starts_at)) throw badRequest('subscription.invalid_dates', 'End date must be after start date', { field: 'endsAt' });
      const [after] = await trx('subscriptions').where({ id: before.id }).update(patch).returning('*');
      await audit(trx, req, { action: 'subscription.updated', companyId: c.id, entityType: 'subscription', entityId: before.id, before, after });
    });
    res.json({ ok: true });
  });

  /** Extend from the later of now / current end date, and (re)activate. */
  async function extend(trx, req, company, sub, periods, days) {
    const plan = await trx('plans').where({ id: sub.plan_id }).first();
    const now = new Date();
    const base = sub.ends_at && new Date(sub.ends_at) > now ? new Date(sub.ends_at) : now;
    const ends = days ? new Date(base.getTime() + days * 86400000) : addPeriod(base, sub.billing_interval, periods || 1, plan.duration_days);
    const patch = { ends_at: ends, status: 'active', starts_at: sub.starts_at || now, is_trial: false, cancelled_at: null, updated_by: req.user.id, updated_at: now };
    const [after] = await trx('subscriptions').where({ id: sub.id }).update(patch).returning('*');
    await audit(trx, req, { action: 'subscription.extended', companyId: company.id, entityType: 'subscription', entityId: sub.id, before: { ends_at: sub.ends_at, status: sub.status }, after: { ends_at: after.ends_at, status: after.status } });
    return { base, after };
  }
  const parseExtension = b => {
    const periods = b?.periods === undefined ? undefined : Number(b.periods);
    const days = b?.days === undefined ? undefined : Number(b.days);
    if (periods !== undefined && (!Number.isInteger(periods) || periods < 1 || periods > 120)) throw badRequest('validation.number', 'periods is invalid', { field: 'periods' });
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) throw badRequest('validation.number', 'days is invalid', { field: 'days' });
    return { periods, days };
  };

  router.post('/:id/subscription/extend', async (req, res) => {
    const { periods, days } = parseExtension(req.body);
    const after = await platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      const sub = await trx('subscriptions').where({ company_id: c.id }).first();
      if (!sub) throw notFound('subscription.not_found', 'No subscription');
      return (await extend(trx, req, c, sub, periods, days)).after;
    });
    res.json({ ok: true, endsAt: after.ends_at });
  });

  // ---- Manual payment confirmation ----
  router.post('/:id/payments', async (req, res) => {
    const b = req.body || {};
    const amount = v.number(b.amount, { field: 'amount', max: 1e8 });
    if (!(amount > 0)) throw badRequest('validation.number', 'amount must be greater than zero', { field: 'amount' });
    const method = v.oneOf(b.method, PAYMENT_METHODS, { field: 'method', required: true });
    const paidAt = dateOrUndefined(b.paidAt, 'paidAt') || new Date();
    if (paidAt > new Date(Date.now() + 86400000)) throw badRequest('validation.invalid', 'Payment date cannot be in the future', { field: 'paidAt' });
    const reference = v.str(b.reference, { field: 'reference', max: 120 }) ?? null;
    const notes = v.str(b.notes, { field: 'notes', max: 1000 }) ?? null;
    const extension = b.extend ? parseExtension(b.extend) : null;

    const payment = await platform(req, async trx => {
      const c = await loadCompany(trx, req.params.id);
      const sub = await trx('subscriptions').where({ company_id: c.id }).first();
      if (!sub) throw badRequest('subscription.not_found', 'Assign a plan before recording payments');
      const currency = v.oneOf(b.currency || sub.currency, CURRENCIES, { field: 'currency' });
      let period = { start: null, end: null };
      if (extension) {
        const { base, after } = await extend(trx, req, c, sub, extension.periods, extension.days);
        period = { start: base, end: after.ends_at };
      }
      const [p] = await trx('payments').insert({
        company_id: c.id, subscription_id: sub.id, amount, currency, paid_at: paidAt, method, reference, notes,
        period_start: period.start, period_end: period.end, recorded_by: req.user.id
      }).returning('*');
      await audit(trx, req, { action: 'payment.recorded', companyId: c.id, entityType: 'payment', entityId: p.id, after: paymentOut(p) });
      return p;
    });
    res.status(201).json({ payment: paymentOut(payment) });
  });

  return router;
};
