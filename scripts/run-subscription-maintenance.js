#!/usr/bin/env node
/* Run subscription maintenance once (expire overdue subscriptions, send expiry notices). Safe to run repeatedly. */
const { loadConfig } = require('../server/config');
const { createDb } = require('../server/db');
const { createMailer } = require('../server/services/mailer');
const { runSubscriptionMaintenance } = require('../server/services/subscriptions');

(async () => {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const platform = await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first('app_name'));
    const result = await runSubscriptionMaintenance(db, { mailer: createMailer(config.mail), appName: platform.app_name });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db.knex.destroy();
  }
})();
