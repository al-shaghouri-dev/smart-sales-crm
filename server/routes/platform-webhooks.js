const express = require('express');
const v = require('../validate');
const { notFound, conflict } = require('../errors');
const { audit } = require('../services/audit');

/**
 * Super Admin view of the webhook inbox: counts, failed events, manual retry.
 * Payloads are NOT returned (they may contain customers' personal data); only metadata.
 */
module.exports = function webhookAdminRoutes({ db, jobs }) {
  const router = express.Router();
  const platform = (req, fn) => db.withContext({ userId: req.user.id, platformAdmin: true }, fn);
  const out = e => ({
    id: e.id, provider: e.provider, eventType: e.event_type, status: e.status, attempts: e.attempts,
    lastError: e.last_error, companyId: e.company_id, receivedAt: e.received_at, processedAt: e.processed_at
  });

  router.get('/', async (req, res) => {
    const status = v.oneOf(req.query.status || undefined, ['received', 'processing', 'processed', 'ignored', 'failed'], { field: 'status' });
    const provider = req.query.provider ? v.str(req.query.provider, { field: 'provider', max: 32 }) : null;
    const data = await platform(req, async trx => {
      const counts = await trx('webhook_events').groupBy('status').select('status').count('* as n');
      const q = trx('webhook_events').orderBy('received_at', 'desc').limit(100)
        .select('id', 'provider', 'event_type', 'status', 'attempts', 'last_error', 'company_id', 'received_at', 'processed_at');
      if (status) q.where({ status });
      if (provider) q.where({ provider });
      return { counts, events: await q };
    });
    res.json({ counts: Object.fromEntries(data.counts.map(c => [c.status, Number(c.n)])), events: data.events.map(out) });
  });

  router.post('/:id/retry', async (req, res) => {
    const id = v.uuid(req.params.id);
    await platform(req, async trx => {
      const e = await trx('webhook_events').where({ id }).first('id', 'status');
      if (!e) throw notFound('webhooks.not_found', 'Event not found');
      if (e.status !== 'failed') throw conflict('webhooks.not_failed', 'Only failed events can be retried');
      await trx('webhook_events').where({ id }).update({ status: 'received', attempts: 0, last_error: null, processed_at: null });
      await audit(trx, req, { action: 'webhook.retried', entityType: 'webhook_event', entityId: id });
    });
    await jobs.send('webhook.process', { eventId: id }, { singletonKey: id });
    res.json({ ok: true });
  });

  return router;
};
