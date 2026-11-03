const crypto = require('crypto');

/**
 * Credential encryption (AES-256-GCM) with key versions and context binding.
 *
 * v2 format:  v2:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
 *   - keyId selects the key from the key ring, so old values stay readable after rotation.
 *   - Additional Authenticated Data (AAD) binds every value to its owner:
 *       "sscrm|v2|<keyId>|<purpose>|<companyId>|<channelId>"
 *     A value copied to another company, channel or purpose fails authentication.
 * v1 format (legacy, read-only):  v1:<iv>:<tag>:<ciphertext>  — no key id, no AAD.
 *   Only decrypted when explicitly allowed; re-encrypt to v2 with rotate().
 *
 * Keys come from the environment only (see loadKeyRingFromEnv). Errors never include keys,
 * plaintext or ciphertext.
 */
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CONTEXT_PART = /^[A-Za-z0-9_.:-]{1,100}$/;

class SecretError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'SecretError'; }
}

function decodeKey(base64Key, label) {
  const key = Buffer.from(String(base64Key || ''), 'base64');
  if (key.length !== 32) throw new SecretError('secrets.bad_key', `Encryption key ${label} must be 32 bytes, base64 encoded`);
  return key;
}

function contextAad(keyId, ctx) {
  if (!ctx || typeof ctx !== 'object') throw new SecretError('secrets.context_required', 'Encryption context is required');
  const parts = [ctx.purpose, ctx.companyId, ctx.channelId];
  if (parts.some(p => !CONTEXT_PART.test(String(p ?? '')))) {
    throw new SecretError('secrets.context_invalid', 'Encryption context needs purpose, companyId and channelId');
  }
  return Buffer.from(['sscrm', 'v2', keyId, ...parts.map(String)].join('|'), 'utf8');
}

/**
 * @param {{ keys: Record<string,string>, primaryKeyId: string, legacyKey?: string }} opts
 *   keys: keyId → base64 32-byte key. primaryKeyId: the key used for new encryptions.
 *   legacyKey: optional base64 key for reading v1 values.
 */
function createKeyRing({ keys, primaryKeyId, legacyKey } = {}) {
  const ring = new Map();
  for (const [id, value] of Object.entries(keys || {})) {
    if (!KEY_ID.test(id)) throw new SecretError('secrets.bad_key_id', 'Encryption key ids may use letters, digits, "_" and "-" (max 32)');
    ring.set(id, decodeKey(value, id));
  }
  if (!ring.size) throw new SecretError('secrets.no_keys', 'No encryption keys configured');
  if (!ring.has(primaryKeyId)) throw new SecretError('secrets.no_primary', 'The primary encryption key id is not in the key ring');
  const legacy = legacyKey ? decodeKey(legacyKey, 'APP_ENCRYPTION_KEY') : null;

  function encrypt(plaintext, ctx) {
    if (typeof plaintext !== 'string' || !plaintext.length) throw new SecretError('secrets.empty', 'Nothing to encrypt');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ring.get(primaryKeyId), iv);
    cipher.setAAD(contextAad(primaryKeyId, ctx));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v2', primaryKeyId, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  function parse(payload) {
    const parts = String(payload || '').split(':');
    if (parts[0] === 'v2' && parts.length === 5) return { version: 'v2', keyId: parts[1], iv: parts[2], tag: parts[3], data: parts[4] };
    if (parts[0] === 'v1' && parts.length === 4) return { version: 'v1', keyId: null, iv: parts[1], tag: parts[2], data: parts[3] };
    throw new SecretError('secrets.bad_format', 'Unsupported encrypted value format');
  }

  function decipher(key, p, aad) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64'));
      if (aad) d.setAAD(aad);
      d.setAuthTag(Buffer.from(p.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(p.data, 'base64')), d.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong context or modified data — deliberately indistinguishable.
      throw new SecretError('secrets.auth_failed', 'Encrypted value could not be authenticated');
    }
  }

  /** ctx.allowLegacy must be true to read v1 values (which carry no context binding). */
  function decrypt(payload, ctx) {
    const p = parse(payload);
    if (p.version === 'v1') {
      if (!ctx?.allowLegacy) throw new SecretError('secrets.legacy_not_allowed', 'Legacy (v1) value requires explicit opt-in');
      if (!legacy) throw new SecretError('secrets.no_legacy_key', 'No legacy key configured for v1 values');
      return decipher(legacy, p, null);
    }
    const key = ring.get(p.keyId);
    if (!key) throw new SecretError('secrets.unknown_key', 'Encrypted with a key id that is not configured');
    return decipher(key, p, contextAad(p.keyId, ctx));
  }

  const keyIdOf = payload => parse(payload).keyId;
  /** True for v1 values and v2 values not encrypted with the current primary key. */
  const needsRotation = payload => { const p = parse(payload); return p.version !== 'v2' || p.keyId !== primaryKeyId; };
  /** Decrypt with whatever key wrote it, re-encrypt with the primary key and v2 context. */
  const rotate = (payload, ctx) => encrypt(decrypt(payload, ctx), ctx);

  return { encrypt, decrypt, keyIdOf, needsRotation, rotate, primaryKeyId, keyIds: () => [...ring.keys()] };
}

/**
 * Environment:
 *   APP_ENCRYPTION_KEYS="2026a:<base64>,2025b:<base64>"   key ring (id:key pairs)
 *   APP_ENCRYPTION_PRIMARY_KEY_ID=2026a                     key for new values
 *   APP_ENCRYPTION_KEY=<base64>                             Phase 0-2 single key: still accepted;
 *       used as key id "k1" when APP_ENCRYPTION_KEYS is unset, and to read legacy v1 values.
 * Returns null when nothing is configured (allowed outside production).
 */
function loadKeyRingFromEnv(env = process.env) {
  const pairs = String(env.APP_ENCRYPTION_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  const keys = {};
  for (const pair of pairs) {
    const i = pair.indexOf(':');
    if (i < 1) throw new SecretError('secrets.bad_env', 'APP_ENCRYPTION_KEYS must look like "id:base64,id2:base64"');
    keys[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (!pairs.length && env.APP_ENCRYPTION_KEY) keys.k1 = env.APP_ENCRYPTION_KEY;
  if (!Object.keys(keys).length) return null;
  const primaryKeyId = env.APP_ENCRYPTION_PRIMARY_KEY_ID || (pairs.length ? Object.keys(keys)[0] : 'k1');
  return createKeyRing({ keys, primaryKeyId, legacyKey: env.APP_ENCRYPTION_KEY || undefined });
}

// ---- v1 helpers kept for backward compatibility (unused by new code) ----
function encryptSecret(plaintext, base64Key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', decodeKey(base64Key, 'APP_ENCRYPTION_KEY'), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
function decryptSecret(payload, base64Key) {
  const ring = createKeyRing({ keys: { legacy: base64Key }, primaryKeyId: 'legacy', legacyKey: base64Key });
  return ring.decrypt(payload, { allowLegacy: true });
}

/**
 * Re-encrypt one encrypted column to the primary key, in batches (key rotation).
 * `contextFor(row)` must return the same context used when the value was written.
 * Runs inside the caller's transaction/security context. Returns counts.
 */
async function reencryptColumn(trx, ring, { table, idColumn = 'id', column, contextFor, batchSize = 200 }) {
  let rotated = 0, scanned = 0, lastId = null;
  for (;;) {
    const q = trx(table).select('*').whereNotNull(column).orderBy(idColumn).limit(batchSize);
    if (lastId !== null) q.where(idColumn, '>', lastId);
    const rows = await q;
    if (!rows.length) break;
    for (const row of rows) {
      scanned++;
      lastId = row[idColumn];
      if (!ring.needsRotation(row[column])) continue;
      const next = ring.rotate(row[column], contextFor(row));
      await trx(table).where({ [idColumn]: row[idColumn] }).update({ [column]: next });
      rotated++;
    }
  }
  return { scanned, rotated };
}

module.exports = { createKeyRing, loadKeyRingFromEnv, reencryptColumn, SecretError, encryptSecret, decryptSecret };
