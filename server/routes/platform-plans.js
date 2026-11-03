const express = require('express');
const v = require('../validate');
const { PLAN_FEATURES } = require('../permissions');
const { badRequest, conflict, notFound } = require('../errors');
const { audit } = require('../services/audit');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'IQD', 'SYP', 'LBP', 'TRY', 'MAD', 'DZD', 'TND'];

const out = p => ({
  id: p.id, key: p.key, name: p.name, description: p.description, interval: p.billing_interval, durationDays: p.duration_days,
  price: Number(p.price), currency: p.currency, trialDays: p.trial_days, maxEmployees: p.max_employees, maxChannels: p.max_channels,
  features: p.features, isActive: p.is_active, isPublic: p.is_public, sort: p.sort, createdAt: p.created_at
});

/**
 * Starting points for Basic / Pro / Business. Created only when a Super Admin asks for them,
 * as INACTIVE drafts with price 0 — the admin sets real prices and activates them.
 */
const TEMPLATES = [
  { key: 'basic', name: { en: 'Basic', ar: 'الأساسية' }, description: { en: 'Core CRM for small teams.', ar: 'إدارة أساسية للفرق الصغيرة.' }, max_employees: 3, max_channels: 1, features: ['export.excel'], sort: 1 },
  { key: 'pro', name: { en: 'Pro', ar: 'الاحترافية' }, description: { en: 'More seats, channels and advanced reports.', ar: 'مقاعد وقنوات أكثر وتقارير متقدمة.' }, max_employees: 10, max_channels: 3, features: ['export.excel', 'reports.advanced', 'branding.custom'], sort: 2 },
  { key: 'business', name: { en: 'Business', ar: 'الأعمال' }, description: { en: 'Higher limits, automation and AI assistance.', ar: 'حدود أعلى وأتمتة ومساعد ذكي.' }, max_employees: 50, max_channels: 4, features: [...PLAN_FEATURES], sort: 3 }
];

function parse(b, { partial }) {
  const name = v.localized(b.name, { field: 'name', max: 60 });
  if (!partial && (!name || !(name.en || name.ar))) throw badRequest('validation.required', 'Plan name is required', { field: 'name' });
  const interval = v.oneOf(b.interval, ['month', 'year', 'custom'], { field: 'interval', required: !partial });
  const intOrNull = (x, field, min) => {
    if (x === undefined) return undefined;
    if (x === null || x === '') return null;
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > 100000) throw badRequest('validation.number', `${field} is invalid`, { field });
    return n;
  };
  let features;
  if (b.features !== undefined) {
    if (!Array.isArray(b.features) || b.features.some(f => !PLAN_FEATURES.includes(f))) throw badRequest('validation.invalid', 'Unknown feature', { field: 'features' });
    features = JSON.stringify([...new Set(b.features)]);
  }
  return v.compact({
    name: name ? JSON.stringify(name) : undefined,
    description: b.description !== undefined ? JSON.stringify(v.localized(b.description, { field: 'description', max: 300 })) : undefined,
    billing_interval: interval ?? undefined,
    duration_days: intOrNull(b.durationDays, 'durationDays', 1),
    price: v.number(b.price, { field: 'price', max: 1e8 }),
    currency: v.oneOf(b.currency, CURRENCIES, { field: 'currency' }) ?? undefined,
    trial_days: intOrNull(b.trialDays, 'trialDays', 0) ?? undefined,
    max_employees: intOrNull(b.maxEmployees, 'maxEmployees', 1),
    max_channels: intOrNull(b.maxChannels, 'maxChannels', 0),
    features,
    is_active: b.isActive === undefined ? undefined : Boolean(b.isActive),
    is_public: b.isPublic === undefined ? undefined : Boolean(b.isPublic),
    sort: intOrNull(b.sort, 'sort', 0) ?? undefined
  });
}

function checkCustom(row) {
  if (row.billing_interval === 'custom' && !(row.duration_days > 0)) throw badRequest('validation.required', 'Custom plans need a duration in days', { field: 'durationDays' });
}

module.exports = function planRoutes({ db }) {
  const router = express.Router();
  const platform = (req, fn) => db.withContext({ userId: req.user.id, platformAdmin: true }, fn);
  const list = trx => trx('plans').orderBy([{ column: 'sort' }, { column: 'created_at' }]);

  router.get('/', async (req, res) => {
    const rows = await platform(req, async trx => {
      const plans = await list(trx);
      const usage = await trx('subscriptions').groupBy('plan_id').select('plan_id').count('* as n');
      return plans.map(p => ({ ...out(p), companies: Number(usage.find(u => u.plan_id === p.id)?.n || 0) }));
    });
    res.json({ plans: rows, features: PLAN_FEATURES, currencies: CURRENCIES });
  });

  router.post('/', async (req, res) => {
    const row = parse(req.body || {}, { partial: false });
    const key = v.str(req.body?.key, { field: 'key', max: 40 }) || `plan-${Date.now().toString(36)}`;
    if (!/^[a-z0-9-]+$/.test(key)) throw badRequest('validation.invalid', 'Key may contain lowercase letters, digits and dashes', { field: 'key' });
    checkCustom(row);
    const plan = await platform(req, async trx => {
      if (await trx('plans').where({ key }).first('id')) throw conflict('plans.key_taken', 'A plan with this key already exists');
      const [p] = await trx('plans').insert({ ...row, key }).returning('*');
      await audit(trx, req, { action: 'plan.created', entityType: 'plan', entityId: p.id, after: out(p) });
      return p;
    });
    res.status(201).json({ plan: out(plan) });
  });

  router.post('/templates', async (req, res) => {
    const created = await platform(req, async trx => {
      const made = [];
      for (const t of TEMPLATES) {
        if (await trx('plans').where({ key: t.key }).first('id')) continue;
        const [p] = await trx('plans').insert({
          ...t, name: JSON.stringify(t.name), description: JSON.stringify(t.description), features: JSON.stringify(t.features),
          billing_interval: 'month', price: 0, currency: 'USD', trial_days: 0, is_active: false, is_public: true
        }).returning('*');
        made.push(p);
        await audit(trx, req, { action: 'plan.created', entityType: 'plan', entityId: p.id, after: { key: p.key, template: true } });
      }
      return made;
    });
    res.status(201).json({ created: created.map(out) });
  });

  router.patch('/:id', async (req, res) => {
    const id = v.uuid(req.params.id);
    const patch = parse(req.body || {}, { partial: true });
    const plan = await platform(req, async trx => {
      const before = await trx('plans').where({ id }).first();
      if (!before) throw notFound('plans.not_found', 'Plan not found');
      checkCustom({ ...before, ...patch });
      // Existing subscriptions keep their own price/interval snapshot; editing a plan never changes what a company already pays.
      const [after] = await trx('plans').where({ id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      await audit(trx, req, { action: 'plan.updated', entityType: 'plan', entityId: id, before: out(before), after: out(after) });
      return after;
    });
    res.json({ plan: out(plan) });
  });

  router.delete('/:id', async (req, res) => {
    const id = v.uuid(req.params.id);
    await platform(req, async trx => {
      const plan = await trx('plans').where({ id }).first();
      if (!plan) throw notFound('plans.not_found', 'Plan not found');
      if (await trx('subscriptions').where({ plan_id: id }).first('id')) throw conflict('plans.in_use', 'Plan is used by companies; deactivate it instead');
      await trx('plans').where({ id }).del();
      await audit(trx, req, { action: 'plan.deleted', entityType: 'plan', entityId: id, before: out(plan) });
    });
    res.json({ ok: true });
  });

  return router;
};

module.exports.planOut = out;
module.exports.CURRENCIES = CURRENCIES;
