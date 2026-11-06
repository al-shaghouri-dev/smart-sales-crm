const { PgBoss } = require('pg-boss');

/**
 * Background jobs on PostgreSQL (pg-boss). No external queue service is needed.
 *
 * - pg-boss installs/migrates its own tables inside the `pgboss` schema at start-up, running
 *   as the restricted application role (the migration grants USAGE + CREATE on that schema only).
 * - Schedules are stored in the database and keyed by queue name, so calling schedule() on every
 *   start-up — from any number of instances — never creates duplicate schedulers.
 * - Job payloads carry identifiers only (never tokens or personal data).
 * - Handlers must be idempotent: a job can run more than once (retry, crash, expiry).
 */

/** Queue definitions: retry/backoff/expiry per queue. */
function queueDefinitions(config) {
  const w = config.webhooks;
  const m = { sendMaxAttempts: 5, sendRetryDelaySeconds: 10, ...(config.messaging || {}) };
  return {
    'webhook.process': {
      // pg-boss may retry a little more than our own attempt counter (webhook_events.attempts),
      // which is the authority that marks an event "failed".
      retryLimit: w.maxAttempts + 1,
      retryDelay: w.retryDelaySeconds,
      retryBackoff: w.retryDelaySeconds > 0,
      // pg-boss only accepts a cap when exponential backoff is on.
      ...(w.retryDelaySeconds > 0 ? { retryDelayMax: 3600 } : {}),
      expireInSeconds: 300
    },
    'message.send': {
      // messages.attempts is the authority (see server/messaging); pg-boss only schedules retries.
      retryLimit: m.sendMaxAttempts + 1,
      retryDelay: m.sendRetryDelaySeconds,
      retryBackoff: m.sendRetryDelaySeconds > 0,
      // Capped so the outbox sweeper (5 minutes) never mistakes a waiting retry for a lost job.
      ...(m.sendRetryDelaySeconds > 0 ? { retryDelayMax: 240 } : {}),
      expireInSeconds: 120
    },
    'message.sweep': { retryLimit: 1, expireInSeconds: 120 },
    'webhook.sweep': { retryLimit: 1, expireInSeconds: 120 },
    'webhook.cleanup': { retryLimit: 1, expireInSeconds: 600 },
    'subscription.maintenance': { retryLimit: 2, retryDelay: 60, expireInSeconds: 600 }
  };
}

/** Cron schedules (UTC). Only processes with the worker role register them. */
const SCHEDULES = {
  'webhook.sweep': '*/5 * * * *',          // re-queue events whose job was lost
  'message.sweep': '*/2 * * * *',          // re-queue outbound messages whose job was lost
  'webhook.cleanup': '17 3 * * *',         // retention clean-up, daily
  'subscription.maintenance': '7 * * * *'  // hourly (replaces the Phase 2 in-process timer)
};

function createJobs(config, { logger = console } = {}) {
  const definitions = queueDefinitions(config);
  const boss = new PgBoss({
    connectionString: config.databaseDirectUrl,
    schema: config.jobs.schema,
    createSchema: false, // created by the Knex migration as the schema owner
    migrate: true,
    max: config.jobs.poolMax,
    application_name: 'sscrm-jobs'
  });
  boss.on('error', error => logger.error('[jobs] error:', error.code || error.message));
  let started = false;     // queues ready, accepting work
  let bossStarted = false; // pg-boss itself started (owns a connection pool that must be closed)

  return {
    boss,
    definitions,
    isStarted: () => started,

    async start() {
      await boss.start();
      bossStarted = true;
      for (const [name, options] of Object.entries(definitions)) {
        const existing = await boss.getQueue(name);
        if (existing) await boss.updateQueue(name, options);
        else await boss.createQueue(name, options);
      }
      started = true;
    },

    /** Register a handler. `handler(job)` receives one job; throwing triggers a retry. */
    async work(name, handler, { pollingIntervalSeconds = config.jobs.pollingIntervalSeconds, localConcurrency = 2 } = {}) {
      if (!definitions[name]) throw new Error(`Unknown queue ${name}`);
      return boss.work(name, { pollingIntervalSeconds, localConcurrency, batchSize: 1 }, async ([job]) => handler(job));
    },

    async send(name, data, options = {}) {
      if (!definitions[name]) throw new Error(`Unknown queue ${name}`);
      return boss.send(name, data, options);
    },

    /** Idempotent: re-registering the same schedule updates it instead of adding another. */
    async scheduleAll() {
      for (const [name, cron] of Object.entries(SCHEDULES)) await boss.schedule(name, cron, {}, { tz: 'UTC' });
    },

    /** Graceful: stop fetching, wait for active jobs (up to timeout), close pg-boss's pool. */
    async stop({ timeout = config.shutdownTimeoutMs } = {}) {
      started = false;
      if (!bossStarted) return; // also covers a start-up that failed half-way
      bossStarted = false;
      await boss.stop({ graceful: true, wait: true, timeout, close: true });
    },

    async health() {
      if (!started) return false;
      try { await boss.getQueue('webhook.process'); return true; } catch { return false; }
    }
  };
}

/** Used when jobs are disabled (e.g. JOBS_ENABLED=false): sends are dropped and swept later. */
function createDisabledJobs() {
  return {
    boss: null, definitions: {}, isStarted: () => false,
    async start() {}, async work() {}, async scheduleAll() {}, async stop() {}, async health() { return false; },
    async send() { return null; }
  };
}

module.exports = { createJobs, createDisabledJobs, queueDefinitions, SCHEDULES };
