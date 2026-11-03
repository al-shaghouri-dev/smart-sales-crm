const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { scheduleSubscriptionMaintenance } = require('./services/subscriptions');

const config = loadConfig();
const app = createApp(config);
const server = app.listen(config.port, () => console.log(`Smart Sales CRM API listening on http://localhost:${config.port}`));
const stopJobs = config.jobsEnabled ? scheduleSubscriptionMaintenance(app.locals.db, { mailer: app.locals.mailer }) : () => {};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopJobs();
    server.close(() => app.locals.db.knex.destroy().finally(() => process.exit(0)));
  });
}
