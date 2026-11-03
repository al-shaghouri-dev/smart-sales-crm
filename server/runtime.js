const http = require('http');
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createJobs, createDisabledJobs } = require('./jobs');
const { createRealtime } = require('./realtime');
const { createProviderRegistry } = require('./channels/registry');
const { createWebhookProcessor } = require('./webhooks/processor');
const { createMailer } = require('./services/mailer');
const { runSubscriptionMaintenance } = require('./services/subscriptions');

/**
 * Composes the application: HTTP + Socket.IO (web role) and background workers (worker role).
 *
 *   PROCESS_ROLE=all     one process does everything (local development, single small server)
 *   PROCESS_ROLE=web     HTTP API, frontend and Socket.IO; enqueues jobs but runs no workers
 *   PROCESS_ROLE=worker  job workers and schedules only; no HTTP listener
 *
 * Shutdown order (stop): mark not-ready → stop accepting HTTP + close sockets → let active jobs
 * finish (bounded by SHUTDOWN_TIMEOUT_MS) → close database pools. stop() is idempotent.
 */
function createRuntime(config, options = {}) {
  const logger = options.logger || console;
  const db = options.db || createDb(config.databaseUrl);
  const ownsDb = !options.db;
  const providers = options.providers || createProviderRegistry(config, options.extraProviders);
  const mailer = options.mailer || createMailer(config.mail);
  const jobs = config.jobsEnabled ? (options.jobs || createJobs(config, { logger })) : createDisabledJobs();
  const role = config.processRole;
  const serveWeb = role === 'all' || role === 'web';
  const runWorkers = config.jobsEnabled && (role === 'all' || role === 'worker');

  const app = createApp(config, { db, jobs: config.jobsEnabled ? jobs : undefined, providers, mailer, apiRateLimit: options.apiRateLimit });
  app.locals.runtimeState = 'starting';
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  const realtime = serveWeb && config.realtime.enabled ? createRealtime({ httpServer: server, db, config, logger }) : null;
  app.locals.realtime = realtime;
  const processor = createWebhookProcessor({ db, config, providers, logger, realtime });

  let state = 'created';
  let stopping = null;

  async function start(opts) {
    try {
      return await startInner(opts);
    } catch (error) {
      // Never leave pools, workers or listeners behind after a failed start-up.
      await stop().catch(() => {});
      throw error;
    }
  }

  async function startInner({ listen = true } = {}) {
    if (state !== 'created') throw new Error(`runtime already ${state}`);
    state = 'starting';
    await jobs.start();
    if (runWorkers) {
      await jobs.work('webhook.process', job => processor.process(job.data.eventId));
      await jobs.work('webhook.sweep', () => processor.sweep(jobs));
      await jobs.work('webhook.cleanup', () => processor.cleanup());
      await jobs.work('subscription.maintenance', async () => {
        const platform = await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first('app_name'));
        return runSubscriptionMaintenance(db, { mailer, appName: platform?.app_name });
      });
      await jobs.scheduleAll();
    }
    if (serveWeb && listen) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? config.port, () => { server.off('error', reject); resolve(); });
      });
    }
    state = 'running';
    app.locals.runtimeState = 'running';
    return { port: server.address()?.port };
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      state = 'stopping';
      app.locals.runtimeState = 'stopping'; // readiness turns 503 immediately
      const closeHttp = new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        // Long-lived keep-alive connections would otherwise delay close().
        server.closeIdleConnections?.();
      });
      if (realtime) await realtime.close(); // disconnects sockets (and closes the HTTP server)
      await closeHttp;
      await jobs.stop({ timeout: config.shutdownTimeoutMs }); // waits for active jobs
      if (ownsDb) await db.knex.destroy();
      state = 'stopped';
      app.locals.runtimeState = 'stopped';
    })();
    return stopping;
  }

  return { app, server, db, jobs, realtime, providers, processor, start, stop, state: () => state };
}

module.exports = { createRuntime };
