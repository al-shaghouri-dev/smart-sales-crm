const express = require('express');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');

/**
 * Reports for one company (all figures computed from the database; nothing estimated).
 * reports.view: activity (conversations, messages, customers, deals counts, team activity).
 * reports.financial additionally: order revenue and deal values.
 * GET /api/reports/summary?days=7|30|90
 */
module.exports = function reportRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany, requirePermission('reports.view', 'reports.financial'));

  router.get('/summary', async (req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const financial = req.permissions.has('reports.financial');
    const tz = req.company.timezone || 'UTC';
    const cid = req.company.id;
    const data = await db.withContext({ companyId: cid, userId: req.user.id }, async trx => {
      const since = trx.raw("date_trunc('day', now() AT TIME ZONE ?) AT TIME ZONE ? - make_interval(days => ?)", [tz, tz, days - 1]);
      const day = col => trx.raw(`to_char(${col} AT TIME ZONE ?, 'YYYY-MM-DD')`, [tz]);
      const series = async (table, col, where = q => q, agg = trx.raw('count(*)::int AS n')) =>
        (await where(trx(table).where('company_id', cid).where(col, '>=', since)).select(day(col).wrap('', ' AS d'), agg).groupBy('d')).reduce((m, r) => ({ ...m, [r.d]: r }), {});
      const msgIn = await series('messages', 'created_at', q => q.where('direction', 'in'));
      const msgOut = await series('messages', 'created_at', q => q.where('direction', 'out'));
      const newContacts = await series('contacts', 'created_at');
      const newConvs = await series('conversations', 'created_at');
      const revenue = financial ? await series('orders', 'created_at', q => q.whereNot('status', 'cancelled'), trx.raw('count(*)::int AS n, coalesce(sum(total),0)::float AS v')) : {};
      const contactStatus = await trx('contacts').where('company_id', cid).groupBy('status').select('status').count('* as n');
      const convStatus = await trx('conversations').where('company_id', cid).groupBy('status').select('status').count('* as n');
      const stages = await trx('pipeline_stages as s').leftJoin('deals as d', function () { this.on('d.stage_id', 's.id'); })
        .where('s.company_id', cid).groupBy('s.id', 's.name', 's.kind', 's.position').orderBy('s.position')
        .select('s.id', 's.name', 's.kind', trx.raw('count(d.id)::int AS n'), trx.raw('coalesce(sum(d.value),0)::float AS v'));
      const won = await trx('deals').where({ company_id: cid, status: 'won' }).where('closed_at', '>=', since).select(trx.raw('count(*)::int AS n, coalesce(sum(value),0)::float AS v')).first();
      const lost = await trx('deals').where({ company_id: cid, status: 'lost' }).where('closed_at', '>=', since).count('* as n').first();
      const ordersStatus = financial ? await trx('orders').where('company_id', cid).where('created_at', '>=', since).groupBy('status').select('status').count('* as n') : [];
      const team = await trx('company_memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.company_id': cid, 'm.status': 'active' })
        .select('m.id', 'u.name',
          trx.raw("(SELECT count(*) FROM messages x WHERE x.sender_membership_id = m.id AND x.direction = 'out' AND x.created_at >= ?)::int AS replies", [since]),
          trx.raw("(SELECT count(*) FROM conversations c WHERE c.assigned_membership_id = m.id AND c.status <> 'closed')::int AS open_assigned"),
          trx.raw("(SELECT count(*) FROM deals d WHERE d.owner_membership_id = m.id AND d.status = 'won' AND d.closed_at >= ?)::int AS deals_won", [since]),
          trx.raw("(SELECT count(*) FROM tasks t WHERE t.assignee_membership_id = m.id AND t.done_at >= ?)::int AS tasks_done", [since]))
        .orderBy('u.name');
      const firstResponse = await trx.raw(`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.first_out - c.created_at)) AS median_s
        FROM conversations c
        JOIN LATERAL (SELECT min(m.created_at) AS first_out FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out') r ON r.first_out IS NOT NULL
        WHERE c.company_id = ? AND c.created_at >= ?`, [cid, since]);
      return { msgIn, msgOut, newContacts, newConvs, revenue, contactStatus, convStatus, stages, won, lost, ordersStatus, team, medianFirstResponse: firstResponse.rows[0]?.median_s };
    });

    const labels = [];
    const end = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400000);
      labels.push(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d));
    }
    const pick = (map, key = 'n') => labels.map(l => Number(map[l]?.[key] || 0));
    const sum = arr => arr.reduce((a, b) => a + b, 0);
    const inbound = pick(data.msgIn), outbound = pick(data.msgOut), contacts = pick(data.newContacts), conversations = pick(data.newConvs);
    const body = {
      days, labels, currency: req.company.currency, financial,
      series: { inbound, outbound, contacts, conversations, ...(financial ? { revenue: pick(data.revenue, 'v'), orders: pick(data.revenue) } : {}) },
      totals: {
        inbound: sum(inbound), outbound: sum(outbound), newContacts: sum(contacts), newConversations: sum(conversations),
        dealsWon: data.won.n, dealsLost: Number(data.lost.n),
        medianFirstResponseMinutes: data.medianFirstResponse === null || data.medianFirstResponse === undefined ? null : Math.round(Number(data.medianFirstResponse) / 60),
        ...(financial ? { revenue: Math.round(sum(pick(data.revenue, 'v')) * 100) / 100, orders: sum(pick(data.revenue)), wonValue: data.won.v } : {})
      },
      contactsByStatus: Object.fromEntries(data.contactStatus.map(r => [r.status, Number(r.n)])),
      conversationsByStatus: Object.fromEntries(data.convStatus.map(r => [r.status, Number(r.n)])),
      pipeline: data.stages.map(s => ({ id: s.id, name: s.name, kind: s.kind, count: s.n, ...(financial ? { value: s.v } : {}) })),
      ...(financial ? { ordersByStatus: Object.fromEntries(data.ordersStatus.map(r => [r.status, Number(r.n)])) } : {}),
      team: data.team.map(m => ({ membershipId: m.id, name: m.name, replies: m.replies, openAssigned: m.open_assigned, dealsWon: m.deals_won, tasksDone: m.tasks_done }))
    };
    res.json(body);
  });

  return router;
};
