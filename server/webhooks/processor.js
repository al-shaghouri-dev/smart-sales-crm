/**
 * Asynchronous processing of stored webhook events (pg-boss queue "webhook.process").
 *
 * Idempotency & failure tracking
 *  - The event row is claimed with SELECT … FOR UPDATE SKIP LOCKED and only from status "received":
 *    two workers can never process the same event, and processing / terminal events are skipped.
 *  - webhook_events.attempts is the single source of truth. The attempt is recorded (committed)
 *    before the adapter runs, so crashes still count.
 *  - Retryable failure below maxAttempts → status back to "received" + rethrow → pg-boss retries
 *    with backoff. Permanent failure, or attempts exhausted → status "failed" (kept for review and
 *    manual retry by a Super Admin); the job then completes so it is not retried again.
 *  - Errors are stored as short codes with token-like strings redacted.
 */
const MAX_ERROR = 300;
const redact = text => String(text || '').replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[redacted]').slice(0, MAX_ERROR);

function createWebhookProcessor({ db, config, providers, logger = console, realtime = null }) {
  const maxAttempts = config.webhooks.maxAttempts;

  async function claim(eventId) {
    return db.withContext({ system: true }, async trx => {
      const event = await trx('webhook_events').where({ id: eventId }).forUpdate().skipLocked().first();
      if (!event) return { skip: 'busy_or_missing' };
      // Only "received" events can be claimed. "processing" means another worker owns it (the
      // sweeper hands stuck ones back after 10 minutes); terminal states are never re-run.
      if (event.status !== 'received') return { skip: event.status };
      const [claimed] = await trx('webhook_events').where({ id: eventId })
        .update({ status: 'processing', attempts: event.attempts + 1, processing_started_at: trx.fn.now() }).returning('*');
      return { event: claimed };
    });
  }

  async function finish(eventId, patch) {
    await db.withContext({ system: true }, trx => trx('webhook_events').where({ id: eventId }).update(patch));
  }

  /** Process one event. Returns the final status (or a skip reason). Throws to request a retry. */
  async function process(eventId) {
    const { event, skip } = await claim(eventId);
    if (skip) return { skipped: skip };

    const adapter = providers.get(event.provider);
    if (!adapter) {
      await finish(eventId, { status: 'failed', last_error: 'provider.not_enabled', processed_at: new Date() });
      return { status: 'failed' };
    }

    try {
      const result = await adapter.processEvent(event, { db, logger, realtime, config });
      const status = result?.status === 'ignored' ? 'ignored' : 'processed';
      await finish(eventId, {
        status, last_error: result?.reason ? redact(result.reason) : null, processed_at: new Date(),
        company_id: result?.companyId || null, channel_id: result?.channelId || null
      });
      return { status };
    } catch (error) {
      const code = redact(error.code || error.message || 'error');
      const permanent = error.retryable === false;
      if (permanent || event.attempts >= maxAttempts) {
        await finish(eventId, { status: 'failed', last_error: code, processed_at: new Date() });
        logger.error(`[webhooks] event ${eventId} failed after ${event.attempts} attempt(s): ${code}`);
        return { status: 'failed' };
      }
      await finish(eventId, { status: 'received', last_error: code });
      throw Object.assign(new Error(`retry: ${code}`), { code });
    }
  }

  /**
   * Re-queue events whose job was lost (queue send failed, worker crashed, job expired):
   * "received" for >2 min, or stuck "processing" for >10 min. Idempotent.
   */
  async function sweep(jobs) {
    const stale = await db.withContext({ system: true }, async trx => {
      const stuck = await trx('webhook_events').where({ status: 'processing' })
        .where('processing_started_at', '<', trx.raw("now() - interval '10 minutes'"))
        .update({ status: 'received' }).returning('id');
      const waiting = await trx('webhook_events').where({ status: 'received' })
        .where('received_at', '<', trx.raw("now() - interval '2 minutes'"))
        .whereNotIn('id', stuck.map(r => r.id)).limit(500).pluck('id');
      return [...stuck.map(r => r.id), ...waiting];
    });
    for (const id of stale) await jobs.send('webhook.process', { eventId: id }, { singletonKey: id });
    return stale.length;
  }

  /** Retention: delete finished events older than WEBHOOK_RETENTION_DAYS (failed ones are kept). */
  async function cleanup() {
    return db.withContext({ system: true }, trx => trx('webhook_events')
      .whereIn('status', ['processed', 'ignored'])
      .where('received_at', '<', trx.raw('now() - make_interval(days => ?)', [config.webhooks.retentionDays]))
      .del());
  }

  return { process, sweep, cleanup };
}

module.exports = { createWebhookProcessor, redact };
