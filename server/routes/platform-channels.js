const express = require('express');
const v = require('../validate');
const { notFound } = require('../errors');
const { audit } = require('../services/audit');

/**
 * Super Admin channel monitoring and per-company outbound controls.
 *   GET   /api/platform/channels                 every channel (status, errors, token expiry, traffic)
 *   GET   /api/platform/channels/outbound/:companyId
 *   PATCH /api/platform/channels/outbound/:companyId   { paused, dailyLimit }  kill switch + daily cap
 * Credentials are never read here.
 */
module.exports = function platformChannelRoutes({ db, providers }) {
  const router = express.Router();
  const platform = (req, fn) => db.withContext({ userId: req.user.id, platformAdmin: true }, fn);

  router.get('/', async (req, res) => {
    const status = v.oneOf(req.query.status || undefined, ['active', 'needs_reconnect', 'error', 'connecting', 'disconnected', 'attention'], { field: 'status' });
    const data = await platform(req, async trx => {
      const q = trx('channels as c').join('companies as co', 'co.id', 'c.company_id').leftJoin('channel_credentials as cc', 'cc.channel_id', 'c.id')
        .select('c.id', 'c.provider', 'c.status', 'c.display_name', 'c.external_account_id', 'c.last_inbound_at', 'c.last_outbound_at', 'c.last_health_check_at',
          'c.last_error', 'c.last_error_at', 'c.connected_at', 'co.id as company_id', 'co.name as company_name', 'co.outbound_paused', 'cc.expires_at')
        .orderBy([{ column: 'c.status' }, { column: 'co.name' }]).limit(1000);
      if (status === 'attention') q.whereIn('c.status', ['needs_reconnect', 'error']);
      else if (status) q.where('c.status', status);
      else q.whereNot('c.status', 'disconnected');
      if (req.query.provider) q.where('c.provider', String(req.query.provider));
      if (req.query.companyId) q.where('c.company_id', v.uuid(req.query.companyId, { field: 'companyId' }));
      const channels = await q;
      const ids = channels.map(c => c.id);
      const traffic = ids.length ? await trx('messages').whereIn('channel_id', ids).where('created_at', '>', trx.raw("now() - interval '24 hours'"))
        .groupBy('channel_id').select('channel_id',
          trx.raw("count(*) FILTER (WHERE direction = 'in') AS inbound"),
          trx.raw("count(*) FILTER (WHERE direction = 'out') AS outbound"),
          trx.raw("count(*) FILTER (WHERE direction = 'out' AND status = 'failed') AS failed")) : [];
      const summary = await trx('channels').whereNot('status', 'disconnected').groupBy('status').select('status').count('* as n');
      const queue = await trx('messages').where({ direction: 'out' }).whereIn('status', ['queued', 'sending']).count('* as n').first();
      return { channels, traffic, summary, queued: Number(queue.n) };
    });
    res.json({
      summary: Object.fromEntries(data.summary.map(s => [s.status, Number(s.n)])),
      queued: data.queued,
      providers: providers.list().map(p => p.id),
      channels: data.channels.map(c => {
        const t = data.traffic.find(x => x.channel_id === c.id) || {};
        return {
          id: c.id, provider: c.provider, status: c.status, displayName: c.display_name, externalAccountId: c.external_account_id,
          company: { id: c.company_id, name: c.company_name, outboundPaused: c.outbound_paused },
          lastInboundAt: c.last_inbound_at, lastOutboundAt: c.last_outbound_at, lastHealthCheckAt: c.last_health_check_at,
          lastError: c.last_error, lastErrorAt: c.last_error_at, connectedAt: c.connected_at, tokenExpiresAt: c.expires_at,
          last24h: { inbound: Number(t.inbound || 0), outbound: Number(t.outbound || 0), failed: Number(t.failed || 0) }
        };
      })
    });
  });

  async function outboundState(trx, companyId) {
    const co = await trx('companies').where({ id: companyId }).first('id', 'name', 'outbound_paused', 'outbound_daily_limit');
    if (!co) throw notFound('company.not_found', 'Company not found');
    const today = await trx('messages').where({ company_id: companyId, direction: 'out' })
      .where('created_at', '>=', trx.raw("date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"))
      .select(trx.raw('count(*) AS sent'), trx.raw("count(*) FILTER (WHERE status = 'failed') AS failed")).first();
    return { companyId: co.id, paused: co.outbound_paused, dailyLimit: co.outbound_daily_limit, sentToday: Number(today.sent), failedToday: Number(today.failed) };
  }

  router.get('/outbound/:companyId', async (req, res) => {
    res.json(await platform(req, trx => outboundState(trx, v.uuid(req.params.companyId))));
  });

  router.patch('/outbound/:companyId', async (req, res) => {
    const id = v.uuid(req.params.companyId);
    const b = req.body || {};
    const patch = v.compact({
      outbound_paused: b.paused === undefined ? undefined : Boolean(b.paused),
      outbound_daily_limit: b.dailyLimit === undefined ? undefined : (b.dailyLimit === null || b.dailyLimit === '' ? null : v.number(b.dailyLimit, { field: 'dailyLimit', min: 1, max: 10000000 }))
    });
    const state = await platform(req, async trx => {
      const before = await outboundState(trx, id);
      if (Object.keys(patch).length) await trx('companies').where({ id }).update({ ...patch, updated_at: trx.fn.now() });
      const after = await outboundState(trx, id);
      await audit(trx, req, { action: 'company.outbound_updated', companyId: id, entityType: 'company', entityId: id,
        before: { paused: before.paused, dailyLimit: before.dailyLimit }, after: { paused: after.paused, dailyLimit: after.dailyLimit } });
      return after;
    });
    res.json(state);
  });

  return router;
};
