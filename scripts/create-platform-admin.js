#!/usr/bin/env node
/*
 * Create (or promote) a platform Super Admin. There is no default account.
 *   npm run platform:admin -- --email owner@example.com --name "Platform Owner"
 * The password is prompted for (or read from PASSWORD) and never printed.
 */
const crypto = require('crypto');
const { loadConfig } = require('../server/config');
const { createDb } = require('../server/db');
const { hashPassword, validatePassword, MIN_LENGTH } = require('../server/security/passwords');
const { audit } = require('../server/services/audit');
const { parseArgs, readPassword } = require('./cli-utils');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || '').trim().toLowerCase();
  if (!email || !args.name) {
    console.error('Usage: npm run platform:admin -- --email <email> --name "<Full Name>"');
    process.exit(1);
  }
  const db = createDb(loadConfig().databaseUrl);
  try {
    const existing = (await db.knex.raw('SELECT app_user_id_by_email(?) AS id', [email])).rows[0].id;
    const password = existing && !args['reset-password'] ? null : await readPassword(`Password for ${email} (min ${MIN_LENGTH} chars): `);
    if (password !== null && !validatePassword(password)) throw new Error(`Password must be at least ${MIN_LENGTH} characters`);
    const hash = password ? await hashPassword(password) : null;
    await db.withContext({ platformAdmin: true }, async trx => {
      if (existing) {
        await trx('users').where({ id: existing }).update({ is_platform_admin: true, status: 'active', ...(hash ? { password_hash: hash, password_changed_at: trx.fn.now() } : {}) });
        await audit(trx, null, { action: 'platform.admin_promoted', entityType: 'user', entityId: existing, after: { email, via: 'cli' } });
        console.log(`Promoted ${email} to platform admin.`);
      } else {
        const id = crypto.randomUUID();
        await trx('users').insert({ id, email, name: String(args.name), password_hash: hash, password_changed_at: trx.fn.now(), is_platform_admin: true });
        await audit(trx, null, { action: 'platform.admin_created', entityType: 'user', entityId: id, after: { email, via: 'cli' } });
        console.log(`Created platform admin ${email}.`);
      }
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db.knex.destroy();
  }
})();
