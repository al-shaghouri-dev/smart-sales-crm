const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ProviderError } = require('../channels/adapter');

/**
 * Shared webhook ingestion: /webhooks/:provider and /webhooks/:provider/:endpointKey
 *
 *   1. Raw body only (mounted BEFORE express.json) so signatures are checked on exact bytes.
 *   2. Provider adapter verifies the request. Failure → 401, nothing stored, no details leaked.
 *   3. Adapter splits the delivery into events; each is persisted in webhook_events.
 *      UNIQUE(provider, event_key) makes repeated deliveries no-ops (duplicates are acknowledged).
 *   4. New events are queued for asynchronous processing (job payload = event id only).
 *      If queueing fails the event stays "received" and the sweeper re-queues it.
 *   5. 200 is returned only after the events are durably stored — so the provider retries if
 *      our database is unavailable.
 */
const DEFAULTS = { bodyLimit: '1mb', rateLimitPerMinute: 1200 };

function createWebhookRouter({ db, config, providers, jobs, logger = console }) {
  const router = express.Router();
  const settings = { ...DEFAULTS, ...(config.webhooks || {}) };
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: settings.rateLimitPerMinute, standardHeaders: 'draft-7', legacyHeaders: false });
  const raw = express.raw({ type: () => true, limit: settings.bodyLimit });
  const endpointKeyOk = key => key === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(key);

  function adapterFor(req, res) {
    const adapter = providers.get(req.params.provider);
    if (!adapter || !endpointKeyOk(req.params.endpointKey)) {
      res.status(404).json({ ok: false });
      return null;
    }
    return adapter;
  }

  const verificationHandler = (req, res) => {
    const adapter = adapterFor(req, res);
    if (!adapter) return;
    if (!adapter.handleVerification) return res.status(405).end();
    const { status, body } = adapter.handleVerification({ query: req.query, endpointKey: req.params.endpointKey });
    res.status(status).type('text/plain').send(body);
  };

  const deliveryHandler = async (req, res) => {
    const adapter = adapterFor(req, res);
    if (!adapter) return;
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const context = { rawBody, headers: req.headers, query: req.query, endpointKey: req.params.endpointKey };

    let verified = false;
    try { verified = adapter.verifyRequest(context) === true; } catch { verified = false; }
    if (!verified) return res.status(401).json({ ok: false });

    let events;
    try {
      events = adapter.parseEvents(context);
    } catch (error) {
      const status = error instanceof ProviderError && error.status ? error.status : 400;
      return res.status(status).json({ ok: false });
    }

    const fresh = await db.withContext({ system: true }, async trx => {
      const ids = [];
      for (const e of events) {
        const rows = await trx('webhook_events').insert({
          provider: adapter.id,
          endpoint_key: req.params.endpointKey || null,
          event_key: String(e.eventKey).slice(0, 300),
          event_type: e.type ? String(e.type).slice(0, 100) : null,
          external_account_id: e.externalAccountId ? String(e.externalAccountId).slice(0, 200) : null,
          payload: JSON.stringify(e.payload ?? {})
        }).onConflict(['provider', 'event_key']).ignore().returning('id');
        if (rows.length) ids.push(rows[0].id);
      }
      return ids;
    });

    for (const id of fresh) {
      try {
        await jobs.send('webhook.process', { eventId: id }, { singletonKey: id });
      } catch (error) {
        logger.error('[webhooks] queueing failed; sweeper will retry:', error.code || error.message);
      }
    }
    const ack = adapter.ackResponse ? adapter.ackResponse() : { status: 200, body: { ok: true } };
    res.status(ack.status).json(ack.body);
  };

  router.get('/:provider{/:endpointKey}', limiter, verificationHandler);
  router.post('/:provider{/:endpointKey}', limiter, raw, deliveryHandler);
  // Oversized or unreadable bodies: answer without details.
  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ ok: false });
    res.status(error.status && error.status < 500 ? error.status : 500).json({ ok: false });
  });
  return router;
}

module.exports = { createWebhookRouter };
