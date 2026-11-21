const crypto = require('crypto');
const totp = require('../security/totp');
const { AppError, badRequest } = require('../errors');
const QRCode = require('qrcode');

/**
 * Two-factor authentication (TOTP). Secrets are encrypted with the application key ring
 * (AES-256-GCM, context bound to the user); recovery codes are stored as SHA-256 hashes only.
 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const ctxFor = userId => ({ purpose: 'mfa_secret', companyId: 'user', channelId: userId });

function ring(config) {
  if (!config.keyRing) throw new AppError(503, 'auth.mfa_unavailable', 'Two-factor authentication needs the encryption key to be configured');
  return config.keyRing;
}

async function status(db, userId) {
  const row = await db.withContext({ userId }, trx => trx('user_mfa').where({ user_id: userId }).first('enabled_at', 'recovery_hashes'));
  return { enabled: Boolean(row?.enabled_at), enabledAt: row?.enabled_at || null, recoveryCodesLeft: row?.enabled_at ? row.recovery_hashes.length : 0 };
}

/** Creates (or replaces an unconfirmed) secret and returns what the authenticator app needs. */
async function beginSetup(db, config, user, issuer) {
  const keyRing = ring(config);
  const current = await status(db, user.id);
  if (current.enabled) throw badRequest('auth.mfa_already_enabled', 'Two-factor authentication is already on');
  const secret = totp.generateSecret();
  const ciphertext = keyRing.encrypt(secret, ctxFor(user.id));
  await db.withContext({ userId: user.id }, trx => trx('user_mfa')
    .insert({ user_id: user.id, secret_ciphertext: ciphertext, key_id: keyRing.primaryKeyId, enabled_at: null, recovery_hashes: [], last_step: 0 })
    .onConflict('user_id').merge());
  const url = totp.otpauthUrl({ secret, account: user.email, issuer });
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret, otpauthUrl: url, qrSvg };
}

async function loadSecret(trx, config, userId) {
  const row = await trx('user_mfa').where({ user_id: userId }).forUpdate().first();
  if (!row) return { row: null, secret: null };
  return { row, secret: ring(config).decrypt(row.secret_ciphertext, ctxFor(userId)) };
}

/** Confirms setup with a first code; returns the one-time recovery codes (shown once). */
async function enable(db, config, userId, code) {
  return db.withContext({ userId }, async trx => {
    const { row, secret } = await loadSecret(trx, config, userId);
    if (!row) throw badRequest('auth.mfa_not_started', 'Start the setup first');
    if (row.enabled_at) throw badRequest('auth.mfa_already_enabled', 'Two-factor authentication is already on');
    const step = totp.verify(secret, code, { lastStep: Number(row.last_step) });
    if (step === null) throw badRequest('auth.mfa_invalid', 'Invalid code', { field: 'code' });
    const codes = totp.generateRecoveryCodes();
    await trx('user_mfa').where({ user_id: userId }).update({ enabled_at: trx.fn.now(), last_step: step, recovery_hashes: codes.map(totp.hashRecovery) });
    return codes;
  });
}

/** Verifies an authenticator code or consumes a recovery code. */
async function check(trx, config, userId, code) {
  const { row, secret } = await loadSecret(trx, config, userId);
  if (!row?.enabled_at) return { ok: false };
  const step = totp.verify(secret, code, { lastStep: Number(row.last_step) });
  if (step !== null) {
    await trx('user_mfa').where({ user_id: userId }).update({ last_step: step });
    return { ok: true };
  }
  const h = totp.hashRecovery(code);
  if (String(code || '').replace(/\s/g, '').length >= 8 && row.recovery_hashes.includes(h)) {
    await trx('user_mfa').where({ user_id: userId }).update({ recovery_hashes: row.recovery_hashes.filter(x => x !== h) });
    return { ok: true, usedRecovery: true };
  }
  return { ok: false };
}

async function disable(db, config, userId, code) {
  await db.withContext({ userId }, async trx => {
    const r = await check(trx, config, userId, code);
    if (!r.ok) throw badRequest('auth.mfa_invalid', 'Invalid code', { field: 'code' });
    await trx('user_mfa').where({ user_id: userId }).del();
  });
}

async function regenerateRecovery(db, config, userId, code) {
  return db.withContext({ userId }, async trx => {
    const r = await check(trx, config, userId, code);
    if (!r.ok) throw badRequest('auth.mfa_invalid', 'Invalid code', { field: 'code' });
    const codes = totp.generateRecoveryCodes();
    await trx('user_mfa').where({ user_id: userId }).update({ recovery_hashes: codes.map(totp.hashRecovery) });
    return codes;
  });
}

/** After a correct password: returns a ticket when the account has two-factor on, else null. */
async function challengeIfEnabled(db, userId, kind) {
  return db.withContext({ userId }, async trx => {
    const row = await trx('user_mfa').where({ user_id: userId }).whereNotNull('enabled_at').first('user_id');
    if (!row) return null;
    await trx('mfa_challenges').where({ user_id: userId }).where('expires_at', '<', trx.fn.now()).del();
    const secret = crypto.randomBytes(32).toString('base64url');
    await trx('mfa_challenges').insert({ user_id: userId, token_hash: sha256(secret), kind, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS) });
    return `${userId}.${secret}`;
  });
}

/** Second step of sign-in. The ticket is single-use, expires after 5 minutes and allows 5 tries. */
async function completeChallenge(db, config, ticket, code) {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(String(ticket || ''));
  if (!m) return { ok: false, code: 'auth.mfa_expired' };
  const [, userId, secret] = m;
  return db.withContext({ userId }, async trx => {
    const ch = await trx('mfa_challenges').where({ user_id: userId, token_hash: sha256(secret) }).forUpdate().first();
    if (!ch || new Date(ch.expires_at) < new Date() || ch.attempts >= MAX_ATTEMPTS) {
      if (ch) await trx('mfa_challenges').where({ id: ch.id }).del();
      return { ok: false, code: 'auth.mfa_expired' };
    }
    const r = await check(trx, config, userId, code);
    if (!r.ok) {
      await trx('mfa_challenges').where({ id: ch.id }).increment('attempts', 1);
      return { ok: false, userId, code: 'auth.mfa_invalid' };
    }
    await trx('mfa_challenges').where({ id: ch.id }).del();
    return { ok: true, userId, kind: ch.kind, usedRecovery: Boolean(r.usedRecovery) };
  });
}

module.exports = { status, beginSetup, enable, disable, regenerateRecovery, challengeIfEnabled, completeChallenge, ctxFor };
