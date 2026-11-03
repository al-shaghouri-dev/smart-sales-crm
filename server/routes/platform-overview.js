const express = require('express');
const { monthlyValue } = require('../services/subscriptions');

/** Platform statistics — every number is computed from database records. */
module.exports = function overviewRoutes({ db }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const stats = await db.withContext({ userId: req.user.id, platformAdmin: true }, async trx => {
      const count = async (q) => Number((await q.count('* as n').first()).n);
      const byStatus = await trx('companies').groupBy('status').select('status').count('* as n');
      const subs = await trx('subscriptions').select('status', 'price', 'currency', 'billing_interval', 'is_trial', 'starts_at', 'ends_at');
      const now = new Date();
      const active = subs.filter(s => s.status === 'active' && new Date(s.ends_at) > now);
      const mrr = {};
      for (const s of active) {
        const v = monthlyValue(s);
        if (v) mrr[s.currency] = Math.round(((mrr[s.currency] || 0) + v) * 100) / 100;
      }
      const soon = active.filter(s => new Date(s.ends_at) - now <= 7 * 86400000).length;
      const recent = await trx('companies').orderBy('created_at', 'desc').limit(5).select('id', 'name', 'status', 'created_at');
      return {
        companies: {
          total: byStatus.reduce((a, r) => a + Number(r.n), 0),
          active: Number(byStatus.find(r => r.status === 'active')?.n || 0),
          pending: Number(byStatus.find(r => r.status === 'pending')?.n || 0),
          suspended: Number(byStatus.find(r => r.status === 'suspended')?.n || 0)
        },
        registrations: { pending: await count(trx('registration_requests').whereIn('status', ['pending', 'info_requested'])) },
        subscriptions: {
          active: active.length,
          trial: active.filter(s => s.is_trial).length,
          expiringIn7Days: soon,
          expired: subs.filter(s => s.status === 'expired' || (s.status === 'active' && new Date(s.ends_at) <= now)).length,
          suspended: subs.filter(s => s.status === 'suspended').length,
          cancelled: subs.filter(s => s.status === 'cancelled').length
        },
        // Revenue cannot be summed across currencies, so MRR is reported per currency.
        mrr,
        users: {
          total: await count(trx('users')),
          employees: await count(trx('company_memberships').where({ status: 'active' })),
          platformAdmins: await count(trx('users').where({ is_platform_admin: true }))
        },
        // Messaging channels arrive in Phase 4; reported as null (not zero) until they exist.
        channels: null,
        recentCompanies: recent
      };
    });
    res.json(stats);
  });

  return router;
};
