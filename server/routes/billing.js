const express = require('express');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { summary } = require('../services/subscriptions');
const v = require('../validate');
const { notFound } = require('../errors');

/** Company-side billing view (read-only) and in-app notifications. */
function billingRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany, requirePermission('billing.view'));
  router.get('/', async (req, res) => {
    const data = await db.withContext({ companyId: req.company.id, userId: req.user.id }, async trx => {
      const sub = await trx('subscriptions').where({ company_id: req.company.id }).first();
      const plan = sub ? await trx('plans').where({ id: sub.plan_id }).first() : null;
      const payments = await trx('payments').where({ company_id: req.company.id }).orderBy('paid_at', 'desc').limit(100);
      const policy = (await trx('platform_settings').where({ id: 1 }).first('expired_access_policy')).expired_access_policy;
      const seats = await trx('company_memberships').where({ company_id: req.company.id, status: 'active' }).count('* as n').first();
      return { sub, plan, payments, policy, seats: Number(seats.n) };
    });
    res.json({
      subscription: data.sub ? summary(data.sub, data.plan, data.policy) : null,
      usage: { members: data.seats },
      payments: data.payments.map(p => ({ id: p.id, amount: Number(p.amount), currency: p.currency, paidAt: p.paid_at, method: p.method, reference: p.reference, periodStart: p.period_start, periodEnd: p.period_end }))
    });
  });
  return router;
}

function notificationRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const ctx = req => ({ companyId: req.company.id, userId: req.user.id });

  router.get('/', async (req, res) => {
    const rows = await db.withContext(ctx(req), trx => trx('notifications')
      .where({ user_id: req.user.id, company_id: req.company.id }).orderBy('created_at', 'desc').limit(50)
      .select('id', 'type', 'data', 'read_at', 'created_at'));
    res.json({ notifications: rows, unread: rows.filter(r => !r.read_at).length });
  });
  router.post('/read-all', async (req, res) => {
    await db.withContext(ctx(req), trx => trx('notifications').where({ user_id: req.user.id, company_id: req.company.id }).whereNull('read_at').update({ read_at: trx.fn.now() }));
    res.json({ ok: true });
  });
  router.post('/:id/read', async (req, res) => {
    const n = await db.withContext(ctx(req), trx => trx('notifications').where({ id: v.uuid(req.params.id), user_id: req.user.id, company_id: req.company.id }).update({ read_at: trx.fn.now() }));
    if (!n) throw notFound();
    res.json({ ok: true });
  });
  return router;
}

module.exports = { billingRoutes, notificationRoutes };
