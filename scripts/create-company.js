#!/usr/bin/env node
/*
 * Create a company workspace with its owner account (until the Super Admin UI ships in Phase 2).
 *   npm run company:create -- --name "Acme Trading" --owner-email owner@acme.com --owner-name "Jane Doe" \
 *       [--timezone Asia/Riyadh] [--currency SAR] [--locale ar] [--status active|pending]
 * The owner's password is prompted for (or read from PASSWORD) unless the account already exists.
 */
const { loadConfig } = require('../server/config');
const { createDb } = require('../server/db');
const { createCompany } = require('../server/services/companies');
const { validatePassword, MIN_LENGTH } = require('../server/security/passwords');
const v = require('../server/validate');
const { parseArgs, readPassword } = require('./cli-utils');

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (!a.name || !a['owner-email'] || !a['owner-name']) {
    console.error('Usage: npm run company:create -- --name "<Company>" --owner-email <email> --owner-name "<Name>" [--timezone Area/City] [--currency USD] [--locale en|ar] [--status active|pending]');
    process.exit(1);
  }
  const db = createDb(loadConfig().databaseUrl);
  try {
    const ownerEmail = v.email(a['owner-email']);
    const exists = (await db.knex.raw('SELECT app_user_id_by_email(?) AS id', [ownerEmail])).rows[0].id;
    let ownerPassword = null;
    if (!exists) {
      ownerPassword = await readPassword(`Password for ${ownerEmail} (min ${MIN_LENGTH} chars): `);
      if (!validatePassword(ownerPassword)) throw new Error(`Password must be at least ${MIN_LENGTH} characters`);
    }
    const result = await db.withContext({ platformAdmin: true }, trx => createCompany(trx, null, {
      name: v.str(a.name, { field: 'name', required: true, max: 120 }),
      ownerEmail, ownerName: String(a['owner-name']), ownerPassword,
      timezone: a.timezone ? v.timezone(a.timezone) : 'UTC',
      currency: a.currency ? String(a.currency).toUpperCase() : 'USD',
      defaultLocale: v.oneOf(a.locale || 'en', v.LOCALES, { field: 'locale' }),
      status: v.oneOf(a.status || 'active', ['active', 'pending'], { field: 'status' })
    }));
    console.log(`Created company ${result.companyId} with owner ${ownerEmail}${exists ? ' (existing account)' : ''}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db.knex.destroy();
  }
})();
