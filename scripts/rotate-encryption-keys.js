#!/usr/bin/env node
/*
 * Re-encrypt stored credentials with the current primary key (and upgrade v1 → v2).
 *
 * Rotation procedure (keys live in the environment only):
 *   1. Generate a key:  openssl rand -base64 32
 *   2. Add it to APP_ENCRYPTION_KEYS (keep the old one!) and set APP_ENCRYPTION_PRIMARY_KEY_ID to it.
 *   3. Restart the app: new values use the new key; old values remain readable.
 *   4. Run:  npm run secrets:rotate            (add --dry-run to only count)
 *   5. When it reports 0 remaining, remove the old key from APP_ENCRYPTION_KEYS and restart.
 *
 * ENCRYPTED_FIELDS lists every encrypted column (channel credentials since Phase 3.2).
 * The script is safe to run at any time and can be re-run after an interruption.
 */
const { loadConfig } = require('../server/config');
const { createDb } = require('../server/db');
const { reencryptColumn } = require('../server/security/secrets');

const ENCRYPTED_FIELDS = [
  { table: 'channel_credentials', column: 'ciphertext', idColumn: 'channel_id', keyIdColumn: 'key_id',
    contextFor: row => ({ purpose: 'channel_credential', companyId: row.company_id, channelId: row.channel_id }) }
];

(async () => {
  const config = loadConfig();
  if (!config.keyRing) { console.error('No encryption keys configured (APP_ENCRYPTION_KEYS / APP_ENCRYPTION_KEY).'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const db = createDb(config.databaseUrl);
  try {
    let total = 0;
    for (const field of ENCRYPTED_FIELDS) {
      // System context + platform admin: rotation must see every tenant's rows.
      const r = await db.withContext({ system: true, platformAdmin: true }, async trx => {
        const res = await reencryptColumn(trx, config.keyRing, field);
        if (dryRun) throw Object.assign(new Error('dry-run'), { result: res });
        return res;
      }).catch(e => { if (e.message === 'dry-run') return e.result; throw e; });
      console.log(`${field.table}.${field.column}: scanned ${r.scanned}, ${dryRun ? 'would rotate' : 'rotated'} ${r.rotated}`);
      total += r.rotated;
    }
    console.log(ENCRYPTED_FIELDS.length ? `Done. ${dryRun ? 'Values needing rotation' : 'Rotated'}: ${total}` : 'No encrypted fields registered yet — nothing to rotate.');
  } catch (error) {
    console.error('Rotation failed:', error.code || error.message);
    process.exitCode = 1;
  } finally {
    await db.knex.destroy();
  }
})();
