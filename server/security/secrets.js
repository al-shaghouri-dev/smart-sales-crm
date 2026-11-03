const crypto = require('crypto');

/**
 * AES-256-GCM encryption for credentials stored in the database (channel tokens, etc.).
 * Key: APP_ENCRYPTION_KEY = 32 random bytes, base64 encoded (`openssl rand -base64 32`).
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>. The version prefix allows key rotation later.
 */
function keyFrom(base64Key) {
  const key = Buffer.from(String(base64Key || ''), 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

function encryptSecret(plaintext, base64Key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(base64Key), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decryptSecret(payload, base64Key) {
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(base64Key), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
