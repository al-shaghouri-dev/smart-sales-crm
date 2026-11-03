const crypto = require('crypto');

/**
 * Signature helpers shared by provider adapters. All comparisons are constant-time and
 * operate on the exact raw request bytes (never on re-serialised JSON).
 */

/** Constant-time string comparison that does not leak length via early exit. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing similar
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * HMAC-SHA256 over the raw body, hex encoded, with an optional prefix.
 * Meta (Messenger / Instagram / WhatsApp) sends `X-Hub-Signature-256: sha256=<hex>`.
 */
function verifyHmacSha256(rawBody, secret, header, { prefix = 'sha256=' } = {}) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !header.startsWith(prefix)) return false;
  const given = header.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(given.toLowerCase(), expected);
}

const signHmacSha256 = (rawBody, secret, prefix = 'sha256=') => prefix + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

/**
 * Shared-secret header (Telegram sends `X-Telegram-Bot-Api-Secret-Token: <secret>` when the
 * webhook was registered with secret_token).
 */
function verifySharedSecret(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  return safeEqual(given, expected);
}

module.exports = { safeEqual, verifyHmacSha256, signHmacSha256, verifySharedSecret };
