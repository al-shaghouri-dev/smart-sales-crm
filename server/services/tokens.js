const crypto = require('crypto');
const { badRequest } = require('../errors');

/**
 * One-time tokens for invitations and password resets.
 * Only the SHA-256 hash is stored; the raw token appears once, inside the link.
 */
const TTL_HOURS = { invite: 7 * 24, password_reset: 1 };
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

function linkFor(config, purpose, token) {
  return `${config.appUrl}/${purpose === 'invite' ? 'invite' : 'reset-password'}/${token}`;
}

/** Issue a token (revoking older unused tokens for the same user + purpose). */
async function issueToken(trx, { purpose, userId, companyId = null, createdBy = null }) {
  if (!TTL_HOURS[purpose]) throw new Error(`unknown token purpose ${purpose}`);
  await trx('auth_tokens').where({ user_id: userId, purpose }).whereNull('used_at').update({ used_at: trx.fn.now() });
  const token = crypto.randomBytes(32).toString('base64url');
  await trx('auth_tokens').insert({
    token_hash: sha256(token), purpose, user_id: userId, company_id: companyId, created_by: createdBy,
    expires_at: new Date(Date.now() + TTL_HOURS[purpose] * 3600 * 1000)
  });
  return token;
}

/** Look up a usable token (not used, not expired). Does not consume it. */
async function findToken(knex, token) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(token || ''))) return null;
  const row = await knex('auth_tokens').where({ token_hash: sha256(token) }).first();
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) return null;
  return row;
}

/** Atomically mark a token used; returns false if someone else used it first. */
async function consumeToken(trx, id) {
  const n = await trx('auth_tokens').where({ id }).whereNull('used_at').where('expires_at', '>', new Date()).update({ used_at: trx.fn.now() });
  return n === 1;
}

const invalidToken = () => badRequest('token.invalid', 'This link is invalid or has expired');

module.exports = { issueToken, findToken, consumeToken, linkFor, invalidToken, TTL_HOURS };
