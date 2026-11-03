const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);
const server = app.listen(config.port, () => console.log(`Smart Sales CRM API listening on http://localhost:${config.port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => app.locals.db.knex.destroy().finally(() => process.exit(0)));
  });
}
