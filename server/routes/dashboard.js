const express = require('express');
const { requireAuth, requireCompany } = require('../middleware/session');

/**
 * Workspace dashboard. Every figure is computed from the company's own data; each block is
 * included only when the member has the permission that already guards the same data elsewhere:
 *   customers / sources / conversion  → customers.view | customers.manage
 *   sales / top customers             → reports.financial
 *   new conversations                 → conversations.view_all | reports.view
 *   recent activity                   → per event type, same rules
 *   upcoming tasks                    → always (own tasks only)
 * GET /api/dashboard?days=30|90|365  (365 is bucketed by month, others by day)
 */
const RANGES = [30, 90, 365];

module.exports = function dashboardRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);

  router.get('/', async (req, res) => {
    const days = RANGES.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const unit = days === 365 ? 'month' : 'day';
    const p = req.permissions;
    const can = {
      customers: p.has('customers.view') || p.has('customers.manage'),
      sales: p.has('reports.financial'),
      conversations: p.has('conversations.view_all') || p.has('reports.view'),
      orders: p.has('orders.view') || p.has('orders.manage') || p.has('reports.financial'),
      deals: p.has('customers.view') || p.has('customers.manage')
    };
    const tz = req.company.timezone || 'UTC';
    const cid = req.company.id;

    // Bucket labels (company time zone): days → YYYY-MM-DD, months → YYYY-MM.
    const labels = [];
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (unit === 'day') {
      for (let i = days - 1; i >= 0; i--) labels.push(fmt.format(new Date(Date.now() - i * 86400000)));
    } else {
      const [y, m] = fmt.format(new Date()).split('-').map(Number);
      for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); labels.push(d.toISOString().slice(0, 7)); }
    }

    const out = await db.withContext({ companyId: cid, userId: req.user.id }, async trx => {
      // Period start: first bucket's start; the previous period has the same length just before it.
      const start = unit === 'day'
        ? trx.raw("(date_trunc('day', now() AT TIME ZONE ?) - make_interval(days => ?)) AT TIME ZONE ?", [tz, days - 1, tz])
        : trx.raw("(date_trunc('month', now() AT TIME ZONE ?) - interval '11 months') AT TIME ZONE ?", [tz, tz]);
      const prevStart = unit === 'day'
        ? trx.raw("(date_trunc('day', now() AT TIME ZONE ?) - make_interval(days => ?)) AT TIME ZONE ?", [tz, 2 * days - 1, tz])
        : trx.raw("(date_trunc('month', now() AT TIME ZONE ?) - interval '23 months') AT TIME ZONE ?", [tz, tz]);
      const bucket = col => trx.raw(`to_char(date_trunc('${unit}', ${col} AT TIME ZONE ?), ?) AS b`, [tz, unit === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM']);

      /** current-period series + current/previous totals for one table. */
      async function metric(table, col, where, agg) {
        const base = () => where(trx(table).where(`${table}.company_id`, cid));
        const rows = await base().where(col, '>=', start).select(bucket(col), trx.raw(`${agg} AS v`)).groupBy('b');
        const map = Object.fromEntries(rows.map(r => [r.b, Number(r.v)]));
        const series = labels.map(l => map[l] || 0);
        const prev = await base().where(col, '>=', prevStart).where(col, '<', start).first(trx.raw(`coalesce(${agg}, 0) AS v`));
        const total = series.reduce((a, b) => a + b, 0);
        return { total: Math.round(total * 100) / 100, previous: Math.round(Number(prev.v) * 100) / 100, series };
      }

      const r = { days, unit, labels, currency: req.company.currency, kpis: {} };

      if (can.customers) {
        const all = await trx('contacts').where('company_id', cid).count('* as n').first();
        const m = await metric('contacts', 'contacts.created_at', q => q, 'count(*)::float');
        r.kpis.customers = { value: Number(all.n), added: m.total, addedPrevious: m.previous, series: m.series };

        // Conversion: share of customers first seen in the period who became paying customers.
        const conv = async (from, to) => {
          const q = trx('contacts').where('company_id', cid).where('created_at', '>=', from);
          if (to) q.where('created_at', '<', to);
          const row = await q.first(trx.raw("count(*)::int AS n"), trx.raw("count(*) FILTER (WHERE status = 'customer')::int AS c"));
          return row.n ? Math.round((row.c / row.n) * 1000) / 10 : null;
        };
        r.kpis.conversion = { value: await conv(start), previous: await conv(prevStart, start) };

        const src = await trx('contacts').where('company_id', cid).groupBy('src')
          .select(trx.raw("coalesce(nullif(source, ''), 'manual') AS src"), trx.raw('count(*)::int AS n')).orderBy('n', 'desc');
        r.sources = src.map(s => ({ source: s.src, count: s.n }));
      }

      if (can.sales) {
        const m = await metric('orders', 'orders.created_at', q => q.whereNot('status', 'cancelled'), 'sum(total)::float');
        r.kpis.sales = { value: m.total, previous: m.previous, series: m.series };
        const top = await trx('orders as o').join('contacts as c', 'c.id', 'o.contact_id')
          .where('o.company_id', cid).whereNot('o.status', 'cancelled').where('o.created_at', '>=', start)
          .groupBy('c.id', 'c.display_name', 'c.company_name')
          .select('c.id', 'c.display_name', 'c.company_name', trx.raw('sum(o.total)::float AS total'), trx.raw('count(*)::int AS orders'))
          .orderBy('total', 'desc').limit(5);
        r.topCustomers = top.map(t => ({ id: t.id, name: t.display_name, companyName: t.company_name, total: t.total, orders: t.orders }));
      }

      if (can.conversations) {
        const m = await metric('conversations', 'conversations.created_at', q => q, 'count(*)::float');
        r.kpis.conversations = { value: m.total, previous: m.previous, series: m.series };
      }

      // Recent activity: newest events the member may see, merged by time.
      const events = [];
      const recent = 8;
      if (can.customers) {
        (await trx('contacts').where('company_id', cid).orderBy('created_at', 'desc').limit(recent).select('id', 'display_name', 'source', 'created_at'))
          .forEach(c => events.push({ type: 'customer', at: c.created_at, id: c.id, title: c.display_name, source: c.source }));
      }
      if (can.deals) {
        (await trx('deals').where('company_id', cid).whereNotNull('closed_at').orderBy('closed_at', 'desc').limit(recent).select('id', 'title', 'status', 'value', 'currency', 'closed_at'))
          .forEach(d => events.push({ type: d.status === 'won' ? 'deal_won' : 'deal_lost', at: d.closed_at, id: d.id, title: d.title, ...(can.sales ? { value: Number(d.value), currency: d.currency } : {}) }));
      }
      if (can.orders) {
        (await trx('orders as o').leftJoin('contacts as c', 'c.id', 'o.contact_id').where('o.company_id', cid).orderBy('o.updated_at', 'desc').limit(recent)
          .select('o.id', 'o.number', 'o.status', 'o.total', 'o.currency', 'o.updated_at', 'c.display_name'))
          .forEach(o => events.push({ type: 'order', at: o.updated_at, id: o.id, number: o.number, status: o.status, title: o.display_name, ...(can.sales ? { value: Number(o.total), currency: o.currency } : {}) }));
      }
      if (can.conversations) {
        (await trx('conversations as v').join('contacts as c', 'c.id', 'v.contact_id').where('v.company_id', cid).orderBy('v.created_at', 'desc').limit(recent)
          .select('v.id', 'v.created_at', 'c.display_name'))
          .forEach(v => events.push({ type: 'conversation', at: v.created_at, id: v.id, title: v.display_name }));
      }
      r.activity = events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, recent);

      const tasks = await trx('tasks as t').leftJoin('contacts as c', 'c.id', 't.contact_id')
        .where('t.company_id', cid).whereNull('t.done_at')
        .where(w => w.where('t.assignee_membership_id', req.membership.id).orWhere(w2 => w2.whereNull('t.assignee_membership_id').where('t.created_by_user_id', req.user.id)))
        .orderByRaw('t.due_at ASC NULLS LAST, t.created_at DESC').limit(5)
        .select('t.id', 't.title', 't.due_at', 't.contact_id', 'c.display_name as contact_name');
      r.tasks = tasks.map(t => ({ id: t.id, title: t.title, dueAt: t.due_at, contactId: t.contact_id, contactName: t.contact_name, overdue: Boolean(t.due_at && new Date(t.due_at) < new Date()) }));
      return r;
    });
    res.json(out);
  });

  return router;
};
