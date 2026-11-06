const { AppError, conflict, forbidden, notFound } = require('../errors');

/**
 * Channels: connection records + encrypted credentials + plan limits.
 *
 * Limits (safe under concurrency): every path that makes a channel live calls reserveChannel()
 * inside the same transaction. A per-company advisory lock serialises those transactions, and
 * the plan is re-read inside the lock.
 *   plans.max_channels       NULL = unlimited, N = at most N live (non-disconnected) channels
 *   plans.allowed_providers  NULL = every provider, otherwise a list such as ["telegram","whatsapp"]
 *   no subscription          unlimited (manually managed companies)
 *
 * Credentials (tokens, secrets) are stored ONLY in channel_credentials.ciphertext, encrypted with
 * the key ring and bound to (purpose, company, channel). They are never returned by any API,
 * never written to audit logs and never logged.
 */
const CHANNEL_LOCK_NAMESPACE = 727003;
const CREDENTIAL_PURPOSE = 'channel_credential';
const KNOWN_PROVIDERS = ['telegram', 'messenger', 'instagram', 'whatsapp'];
const LIVE = q => q.whereNot('status', 'disconnected');

const credentialContext = channel => ({ purpose: CREDENTIAL_PURPOSE, companyId: channel.company_id, channelId: channel.id });

function requireKeyRing(keyRing) {
  if (!keyRing) throw new AppError(503, 'channels.encryption_unavailable', 'Credential encryption is not configured on the server');
  return keyRing;
}

async function planFor(trx, companyId) {
  return trx('subscriptions as s').join('plans as p', 'p.id', 's.plan_id')
    .where('s.company_id', companyId).first('p.max_channels', 'p.allowed_providers');
}

function providerAllowed(plan, provider) {
  if (!plan || !Array.isArray(plan.allowed_providers)) return true;
  return plan.allowed_providers.includes(provider);
}

/** Check the plan limits for a new live channel. Must run inside the writing transaction. */
async function reserveChannel(trx, companyId, provider) {
  await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [CHANNEL_LOCK_NAMESPACE, String(companyId)]);
  const plan = await planFor(trx, companyId);
  if (!providerAllowed(plan, provider)) throw forbidden('channels.provider_not_allowed', 'Your plan does not include this channel type');
  if (plan && plan.max_channels !== null && plan.max_channels !== undefined) {
    const used = await LIVE(trx('channels').where({ company_id: companyId })).count('* as n').first();
    if (Number(used.n) >= plan.max_channels) throw conflict('channels.plan_limit', `Your plan allows up to ${plan.max_channels} channels`);
  }
}

async function usage(trx, companyId) {
  const plan = await planFor(trx, companyId);
  const used = await LIVE(trx('channels').where({ company_id: companyId })).count('* as n').first();
  return {
    used: Number(used.n),
    max: plan ? plan.max_channels ?? null : null,
    allowedProviders: plan && Array.isArray(plan.allowed_providers) ? plan.allowed_providers : null
  };
}

async function storeCredentials(trx, keyRing, channel, secret, { scopes, expiresAt } = {}) {
  const ring = requireKeyRing(keyRing);
  const ciphertext = ring.encrypt(JSON.stringify(secret), credentialContext(channel));
  const row = {
    channel_id: channel.id, company_id: channel.company_id, ciphertext, key_id: ring.keyIdOf(ciphertext),
    scopes: scopes ? JSON.stringify(scopes) : null, expires_at: expiresAt || null, refreshed_at: new Date(), updated_at: new Date()
  };
  await trx('channel_credentials').insert(row).onConflict('channel_id').merge();
}

/** Decrypt a channel's credentials (server-side use only). Returns null when none are stored. */
async function readCredentials(trx, keyRing, channel) {
  const row = await trx('channel_credentials').where({ channel_id: channel.id, company_id: channel.company_id }).first();
  if (!row) return null;
  return JSON.parse(requireKeyRing(keyRing).decrypt(row.ciphertext, credentialContext(channel)));
}

/**
 * Create (or reconnect) a live channel for a provider account.
 * - Same company + same provider account already live → credentials are refreshed (no extra slot).
 * - The account is live in ANOTHER company → 409 channels.account_in_use (enforced by a unique
 *   index across all tenants; the other company's data is never revealed).
 */
async function connectChannel(trx, keyRing, { companyId, provider, displayName, externalAccountId, externalMeta = {}, credentials, scopes, expiresAt, connectedBy }) {
  requireKeyRing(keyRing);
  const existing = externalAccountId
    ? await LIVE(trx('channels').where({ company_id: companyId, provider, external_account_id: String(externalAccountId) })).first()
    : null;
  let channel;
  if (existing) {
    [channel] = await trx('channels').where({ id: existing.id }).update({
      status: 'active', display_name: displayName, external_meta: JSON.stringify(externalMeta), last_error: null, last_error_at: null,
      connected_by: connectedBy || existing.connected_by, connected_at: new Date(), updated_at: new Date()
    }).returning('*');
  } else {
    await reserveChannel(trx, companyId, provider);
    try {
      [channel] = await trx('channels').insert({
        company_id: companyId, provider, status: 'active', display_name: displayName,
        external_account_id: externalAccountId ? String(externalAccountId) : null, external_meta: JSON.stringify(externalMeta),
        connected_by: connectedBy || null, connected_at: new Date()
      }).returning('*');
    } catch (error) {
      if (error.code === '23505' && /channels_live_account_uq/.test(error.constraint || error.message)) {
        throw conflict('channels.account_in_use', 'This account is already connected to another workspace');
      }
      throw error;
    }
  }
  if (credentials) await storeCredentials(trx, keyRing, channel, credentials, { scopes, expiresAt });
  return { channel, reconnected: Boolean(existing) };
}

/** Disconnect: stop routing, keep history, and delete the stored credentials. */
async function disconnectChannel(trx, companyId, channelId) {
  const [channel] = await trx('channels').where({ id: channelId, company_id: companyId }).whereNot('status', 'disconnected')
    .update({ status: 'disconnected', disconnected_at: new Date(), updated_at: new Date() }).returning('*');
  if (!channel) throw notFound('channels.not_found', 'Channel not found');
  await trx('channel_credentials').where({ channel_id: channelId, company_id: companyId }).del();
  return channel;
}

/** Mark a channel as needing attention (token revoked/expired, repeated provider errors). */
async function flagChannel(trx, channel, { status = 'needs_reconnect', error }) {
  await trx('channels').where({ id: channel.id, company_id: channel.company_id }).whereNot('status', 'disconnected')
    .update({ status, last_error: String(error || '').slice(0, 200) || null, last_error_at: new Date(), updated_at: new Date() });
}

/** Public representation — never includes credentials. `detailed` adds operational fields for managers. */
function channelOut(c, { detailed = false } = {}) {
  const base = { id: c.id, provider: c.provider, status: c.status, displayName: c.display_name };
  if (!detailed) return base;
  return {
    ...base,
    externalAccountId: c.external_account_id,
    connectedAt: c.connected_at, disconnectedAt: c.disconnected_at,
    lastInboundAt: c.last_inbound_at, lastOutboundAt: c.last_outbound_at, lastHealthCheckAt: c.last_health_check_at,
    lastError: c.last_error, lastErrorAt: c.last_error_at, createdAt: c.created_at
  };
}

module.exports = {
  CHANNEL_LOCK_NAMESPACE, CREDENTIAL_PURPOSE, KNOWN_PROVIDERS, credentialContext, reserveChannel, usage, providerAllowed,
  storeCredentials, readCredentials, connectChannel, disconnectChannel, flagChannel, channelOut, planFor
};
