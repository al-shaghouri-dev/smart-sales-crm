const crypto = require('crypto');
const { ProviderError } = require('../channels/adapter');
const { readCredentials, flagChannel } = require('../services/channels');
const { detect, safeName } = require('../media/storage');
const { messageOut } = require('./serialize');
const { redact } = require('../webhooks/processor');

/**
 * Messaging core shared by webhook processing (inbound), the API (outbound queueing) and the
 * "message.send" worker.
 *
 * Inbound (adapter.processEvent → ctx.messaging.recordInbound)
 *  - Routing: app_channel_route(provider, account) returns only (channel, company, provider, status);
 *    every write then runs in THAT company's RLS context.
 *  - Identities are per channel. A new sender creates a new contact; nothing is ever merged
 *    automatically (two people sharing a name or number on different channels stay separate).
 *  - A per-identity advisory lock serialises concurrent deliveries for the same sender, so
 *    simultaneous first messages never create two contacts/conversations.
 *  - Messages are de-duplicated by UNIQUE(channel_id, external_message_id); counters change only
 *    when a row was really inserted.
 *  - Real-time events are emitted after commit.
 *
 * Outbound
 *  - queued → sending → sent (→ delivered → read) | failed.
 *  - The worker claims only "queued" rows (FOR UPDATE SKIP LOCKED) and commits "sending" before
 *    calling the provider. A row stuck in "sending" is never re-sent automatically (unknown
 *    outcome → failed), so customers never receive duplicates.
 *  - Errors are classified: retryable (rate limit, network, 5xx) → back to "queued" + retry with
 *    backoff until MESSAGE_SEND_MAX_ATTEMPTS; permanent → failed; revoked/expired token → failed
 *    AND the channel is flagged needs_reconnect.
 */
const IDENTITY_LOCK_NAMESPACE = 727004;
const TYPES = ['text', 'image', 'file', 'audio', 'video', 'sticker', 'location', 'template', 'unsupported'];
const STATUS_RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const MAX_BODY = 10000;
const RECONNECT_CODES = /^provider\.(token_invalid|token_expired|permission_revoked|unauthorized)$/;

const previewOf = (body, attachments) => {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 140);
  const a = attachments && attachments[0];
  return a ? `📎 ${a.name || a.kind}`.slice(0, 140) : null;
};

/** Classify any error thrown while sending into { code, retryable, reconnect }. */
function classifySendError(error) {
  if (error instanceof ProviderError || error?.name === 'ProviderError') {
    const reconnect = RECONNECT_CODES.test(error.code);
    return { code: error.code, retryable: reconnect ? false : error.retryable !== false, reconnect };
  }
  if (error?.name === 'SecretError') return { code: 'channel.credentials_unreadable', retryable: false, reconnect: true };
  // Network failures, timeouts and unexpected errors: retry (bounded by the attempt limit).
  const net = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code) || error?.name === 'AbortError';
  return { code: net ? 'provider.network_error' : 'send.error', retryable: true, reconnect: false };
}

function createMessaging({ db, config, media, providers, jobs, getRealtime = () => null, logger = console }) {
  const maxAttempts = config.messaging?.sendMaxAttempts ?? 5;
  const maxMediaBytes = config.messaging?.maxMediaBytes ?? 10 * 1024 * 1024;
  const realtime = () => getRealtime() || null;

  // ------------------------------------------------------------------ real-time helpers
  /** Collect user ids of memberships (for user-room emits). Runs inside the caller's tenant trx. */
  async function userIdsFor(trx, membershipIds) {
    const ids = [...new Set(membershipIds.filter(Boolean))];
    if (!ids.length) return [];
    return trx('company_memberships').whereIn('id', ids).pluck('user_id');
  }

  /** Conversation list changed: supervisors (view_all) + the involved assignees. Ids only. */
  function emitConversation(companyId, conversationId, userIds = []) {
    const rt = realtime();
    if (!rt) return;
    const payload = { companyId, conversationId };
    rt.emitToCompany(companyId, 'conversation:updated', payload, { permission: 'conversations.view_all' });
    for (const userId of new Set(userIds)) rt.emitToUser(userId, 'conversation:updated', payload);
  }

  /** Message events go to the authorised conversation room only, so they may carry the message. */
  function emitMessage(companyId, conversationId, event, message) {
    const rt = realtime();
    if (rt) rt.emitToResource(companyId, 'conversation', conversationId, event, { conversationId, message: messageOut(message) });
  }

  // ------------------------------------------------------------------ routing
  async function routeByAccount(provider, externalAccountId) {
    if (!externalAccountId) return null;
    const r = await db.knex.raw('SELECT * FROM app_channel_route(?, ?)', [provider, String(externalAccountId)]);
    return r.rows[0] || null;
  }

  async function routeById(channelId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(channelId || ''))) return null;
    const r = await db.knex.raw('SELECT * FROM app_channel_lookup(?)', [channelId]);
    return r.rows[0] || null;
  }

  /** Decrypted credentials of a routed channel (adapters need them to download inbound media). */
  async function getCredentials(route) {
    return db.withContext({ companyId: route.company_id, system: true }, async trx => {
      const channel = await trx('channels').where({ id: route.channel_id }).first();
      return channel ? readCredentials(trx, config.keyRing, channel) : null;
    });
  }

  /** Record a provider problem on the channel (e.g. revoked token seen while processing a webhook). */
  async function flagRoute(route, error, status = 'needs_reconnect') {
    await db.withContext({ companyId: route.company_id, system: true }, trx => flagChannel(trx, { id: route.channel_id, company_id: route.company_id }, { status, error }));
  }

  // ------------------------------------------------------------------ media
  /** Store inbound media bytes (already downloaded by the adapter with SSRF protection). */
  async function storeInboundMedia(companyId, buffer, { name, contentType } = {}) {
    if (!buffer || !buffer.length) return null;
    const id = crypto.randomUUID();
    if (buffer.length > maxMediaBytes) return { id, name: safeName(name, 'file'), contentType: contentType || null, size: buffer.length, kind: 'file', omitted: 'too_large' };
    const type = detect(buffer, name);
    const ext = type ? type.ext : 'bin';
    const mime = type ? type.mime : 'application/octet-stream';
    const stored = await media.put({ companyId, buffer, ext, contentType: mime });
    return { id, key: stored.key, name: safeName(name, `file.${ext}`), contentType: mime, size: stored.size, kind: type ? type.kind : 'file', inline: Boolean(type?.inline) };
  }

  /**
   * Short-lived public URL for one stored attachment (providers such as Instagram fetch media by
   * URL). HMAC-signed with WEBHOOK_SECRET_KEY, bound to the storage key, expires after ttl seconds.
   */
  function signedMediaUrl(attachment, ttlSeconds = 900) {
    if (!attachment?.key || !config.webhookSecretKey) return null;
    const payload = Buffer.from(JSON.stringify({ k: attachment.key, e: Math.floor(Date.now() / 1000) + ttlSeconds, t: attachment.contentType || 'application/octet-stream' })).toString('base64url');
    const sig = crypto.createHmac('sha256', String(config.webhookSecretKey)).update(`media|${payload}`).digest('base64url');
    return `${(config.publicUrl || config.appUrl || '').replace(/\/+$/, '')}/media/${payload}.${sig}`;
  }
  function verifyMediaToken(token) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig || !config.webhookSecretKey) return null;
    const expected = crypto.createHmac('sha256', String(config.webhookSecretKey)).update(`media|${payload}`).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.e > Date.now() / 1000 ? data : null;
    } catch { return null; }
  }

  /** Messenger-style read watermark: outbound messages to this contact sent before it are read. */
  async function recordReadUpTo(route, externalUserId, watermark) {
    const when = new Date(Number(watermark));
    if (!Number.isFinite(when.getTime())) return 0;
    const rows = await db.withContext({ companyId: route.company_id, system: true }, async trx => trx('messages as m')
      .whereIn('m.conversation_id', trx('conversations as c').join('contact_identities as ci', 'ci.id', 'c.identity_id')
        .where({ 'c.channel_id': route.channel_id, 'ci.external_user_id': String(externalUserId) }).select('c.id'))
      .where('m.direction', 'out').whereIn('m.status', ['sent', 'delivered']).where('m.sent_at', '<=', when)
      .update({ status: 'read', read_at: when, delivered_at: trx.raw('COALESCE(delivered_at, ?)', [when]), updated_at: new Date() }).returning('*'));
    for (const m of rows) emitMessage(route.company_id, m.conversation_id, 'message:updated', m);
    return rows.length;
  }

  async function readAttachment(attachment) {
    if (!attachment?.key) return null;
    return media.get(attachment.key);
  }

  // ------------------------------------------------------------------ inbound
  /**
   * Record an inbound message for a routed channel.
   * msg = { externalUserId, profile: { name, username }, externalMessageId, type, body,
   *         attachments: [stored attachment], timestamp }
   * Returns { created, messageId, conversationId, contactId }.
   */
  async function recordInbound(route, msg) {
    const companyId = route.company_id;
    const channelId = route.channel_id;
    const externalUserId = String(msg.externalUserId || '').slice(0, 200);
    if (!externalUserId) throw new ProviderError('message.missing_sender', { retryable: false });
    const type = TYPES.includes(msg.type) ? msg.type : 'unsupported';
    const body = msg.body ? String(msg.body).slice(0, MAX_BODY) : null;
    const attachments = Array.isArray(msg.attachments) ? msg.attachments.filter(Boolean) : [];
    const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const createdAt = Number.isFinite(ts.getTime()) && ts.getTime() <= Date.now() ? ts : new Date();
    const profile = { name: msg.profile?.name ? String(msg.profile.name).slice(0, 120) : null, username: msg.profile?.username ? String(msg.profile.username).slice(0, 120) : null };

    const result = await db.withContext({ companyId, system: true }, async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [IDENTITY_LOCK_NAMESPACE, `${channelId}:${externalUserId}`]);
      let identity = await trx('contact_identities').where({ channel_id: channelId, external_user_id: externalUserId }).first();
      let contactCreated = false;
      if (!identity) {
        const [contact] = await trx('contacts').insert({
          company_id: companyId, display_name: profile.name || profile.username || externalUserId,
          first_contact_at: createdAt, last_contact_at: createdAt
        }).returning('*');
        [identity] = await trx('contact_identities').insert({
          company_id: companyId, contact_id: contact.id, channel_id: channelId, provider: route.provider,
          external_user_id: externalUserId, profile: JSON.stringify(profile)
        }).returning('*');
        contactCreated = true;
      } else if ((profile.name && profile.name !== identity.profile?.name) || (profile.username && profile.username !== identity.profile?.username)) {
        await trx('contact_identities').where({ id: identity.id }).update({ profile: JSON.stringify({ ...identity.profile, ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v)) }) });
      }

      let conversation = await trx('conversations').where({ channel_id: channelId, identity_id: identity.id }).first();
      if (!conversation) {
        [conversation] = await trx('conversations').insert({
          company_id: companyId, channel_id: channelId, contact_id: identity.contact_id, identity_id: identity.id, status: 'open'
        }).returning('*');
      }

      const inserted = await trx.raw(`
        INSERT INTO messages (company_id, conversation_id, channel_id, direction, sender_type, type, body, attachments, external_message_id, status, created_at)
        VALUES (?, ?, ?, 'in', 'contact', ?, ?, ?::jsonb, ?, 'received', ?)
        ON CONFLICT (channel_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
        RETURNING *`,
      [companyId, conversation.id, channelId, type, body, JSON.stringify(attachments), msg.externalMessageId ? String(msg.externalMessageId).slice(0, 200) : null, createdAt]);
      const message = inserted.rows[0];
      if (!message) return { created: false, conversationId: conversation.id, contactId: identity.contact_id };

      const [updated] = await trx('conversations').where({ id: conversation.id }).update({
        unread_count: trx.raw('unread_count + 1'),
        last_message_preview: previewOf(body, attachments),
        last_message_at: trx.raw('GREATEST(COALESCE(last_message_at, ?), ?)', [createdAt, createdAt]),
        last_inbound_at: trx.raw('GREATEST(COALESCE(last_inbound_at, ?), ?)', [createdAt, createdAt]),
        // A closed conversation re-opens when the customer writes again.
        status: trx.raw("CASE WHEN status = 'closed' THEN 'open' ELSE status END"),
        updated_at: new Date()
      }).returning('*');
      await trx('contacts').where({ id: identity.contact_id }).update({ last_contact_at: trx.raw('GREATEST(COALESCE(last_contact_at, ?), ?)', [createdAt, createdAt]), updated_at: new Date() });
      await trx('channels').where({ id: channelId }).update({ last_inbound_at: new Date() });
      const userIds = await userIdsFor(trx, [updated.assigned_membership_id]);
      return { created: true, message, conversationId: conversation.id, contactId: identity.contact_id, contactCreated, userIds };
    });

    if (result.created) {
      emitMessage(companyId, result.conversationId, 'message:new', result.message);
      emitConversation(companyId, result.conversationId, result.userIds);
    }
    return { created: result.created, messageId: result.message?.id || null, conversationId: result.conversationId, contactId: result.contactId };
  }

  /** Delivery/read/failure receipts for outbound messages. Status never moves backwards. */
  async function recordStatus(route, { externalMessageId, status, at, errorCode }) {
    if (!externalMessageId || !['sent', 'delivered', 'read', 'failed'].includes(status)) return null;
    const when = at ? new Date(at) : new Date();
    const updated = await db.withContext({ companyId: route.company_id, system: true }, async trx => {
      const m = await trx('messages').where({ channel_id: route.channel_id, external_message_id: String(externalMessageId), direction: 'out' }).forUpdate().first();
      if (!m) return null;
      const patch = { updated_at: new Date() };
      if (status === 'failed') {
        if ((STATUS_RANK[m.status] ?? 0) >= STATUS_RANK.delivered) return { message: m, changed: false };
        Object.assign(patch, { status: 'failed', error_code: redact(errorCode || 'provider.delivery_failed').slice(0, 100) });
      } else if (m.status === 'failed' || (STATUS_RANK[status] ?? 0) <= (STATUS_RANK[m.status] ?? 0)) {
        // Older or duplicate receipt: only fill in a missing timestamp.
        if (status === 'delivered' && !m.delivered_at) patch.delivered_at = when;
        else if (status === 'read' && !m.read_at) patch.read_at = when;
        else return { message: m, changed: false };
      } else {
        patch.status = status;
        if (status === 'sent' && !m.sent_at) patch.sent_at = when;
        if (status === 'delivered' || status === 'read') patch.delivered_at = m.delivered_at || when;
        if (status === 'read') patch.read_at = when;
      }
      const [row] = await trx('messages').where({ id: m.id }).update(patch).returning('*');
      return { message: row, changed: true };
    });
    if (updated?.changed) emitMessage(route.company_id, updated.message.conversation_id, 'message:updated', updated.message);
    return updated ? updated.message : null;
  }

  // ------------------------------------------------------------------ outbound
  /** Enqueue the send job (ids only). If enqueueing fails the sweeper re-queues it later. */
  async function enqueue(messageId, companyId) {
    try { await jobs.send('message.send', { messageId, companyId }, { singletonKey: messageId }); } catch (error) {
      logger.error('[messaging] enqueue failed, the sweeper will retry:', error.code || error.message);
    }
  }

  async function finishSend(companyId, messageId, patch) {
    return db.withContext({ companyId, system: true }, async trx => {
      const [row] = await trx('messages').where({ id: messageId }).update({ ...patch, updated_at: new Date() }).returning('*');
      return row;
    });
  }

  /** Worker: send one queued message. Throws to request a pg-boss retry. */
  async function sendQueued(messageId, companyId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(messageId || '')) || !/^[0-9a-f-]{36}$/i.test(String(companyId || ''))) return { skipped: 'invalid' };
    const claimed = await db.withContext({ companyId, system: true }, async trx => {
      const m = await trx('messages').where({ id: messageId, direction: 'out' }).forUpdate().skipLocked().first();
      if (!m) return { skip: 'busy_or_missing' };
      if (m.status !== 'queued') return { skip: m.status };
      const [message] = await trx('messages').where({ id: m.id }).update({ status: 'sending', attempts: m.attempts + 1, updated_at: new Date() }).returning('*');
      const conversation = await trx('conversations').where({ id: m.conversation_id }).first();
      const identity = await trx('contact_identities').where({ id: conversation.identity_id }).first();
      const channel = await trx('channels').where({ id: m.channel_id }).first();
      let credentials = null, credentialError = null;
      if (channel.status === 'active') {
        try { credentials = await readCredentials(trx, config.keyRing, channel); } catch (error) { credentialError = error; }
      }
      return { message, conversation, identity, channel, credentials, credentialError };
    });
    if (claimed.skip) return { skipped: claimed.skip };
    const { message, conversation, identity, channel } = claimed;

    const fail = async (code, { reconnect = false } = {}) => {
      if (reconnect) await db.withContext({ companyId, system: true }, trx => flagChannel(trx, channel, { error: code }));
      const row = await finishSend(companyId, message.id, { status: 'failed', error_code: code, error_message: null });
      emitMessage(companyId, conversation.id, 'message:updated', row);
      return { status: 'failed', code };
    };

    if (channel.status !== 'active') return fail(channel.status === 'disconnected' ? 'channel.disconnected' : 'channel.needs_reconnect');
    const adapter = providers.get(channel.provider);
    if (!adapter) return fail('provider.not_enabled');
    if (claimed.credentialError) return fail('channel.credentials_unreadable', { reconnect: true });

    try {
      const attachments = (message.attachments || []).map(a => ({
        id: a.id, key: a.key, name: a.name, contentType: a.contentType, size: a.size, kind: a.kind, read: () => readAttachment(a)
      }));
      const result = await adapter.sendMessage({
        messageId: message.id,
        to: identity.external_user_id,
        text: message.body || '',
        type: message.type,
        attachments,
        template: message.template || null,
        channel: { id: channel.id, externalAccountId: channel.external_account_id, meta: channel.external_meta || {} },
        credentials: claimed.credentials,
        conversation: { lastInboundAt: conversation.last_inbound_at }
      }, { logger, config, messaging: self });
      const now = new Date();
      const row = await db.withContext({ companyId, system: true }, async trx => {
        const [m] = await trx('messages').where({ id: message.id }).update({
          status: 'sent', external_message_id: result?.externalMessageId ? String(result.externalMessageId).slice(0, 200) : null,
          sent_at: now, error_code: null, error_message: null, updated_at: now
        }).returning('*');
        await trx('conversations').where({ id: conversation.id }).update({ last_outbound_at: now, updated_at: now });
        await trx('channels').where({ id: channel.id }).update({ last_outbound_at: now });
        return m;
      });
      emitMessage(companyId, conversation.id, 'message:updated', row);
      return { status: 'sent' };
    } catch (error) {
      const c = classifySendError(error);
      const code = redact(c.code).slice(0, 100);
      if (!c.retryable || message.attempts >= maxAttempts) {
        logger.error(`[messaging] message ${message.id} failed after ${message.attempts} attempt(s): ${code}`);
        return fail(code, { reconnect: c.reconnect });
      }
      const row = await finishSend(companyId, message.id, { status: 'queued', error_code: code });
      emitMessage(companyId, conversation.id, 'message:updated', row);
      throw Object.assign(new Error(`retry: ${code}`), { code });
    }
  }

  /** Sweeper: re-queue messages whose job was lost; fail sends with an unknown outcome. */
  async function sweep() {
    const stuck = (await db.knex.raw('SELECT app_outbox_fail_stuck() AS n')).rows[0].n;
    const stale = (await db.knex.raw('SELECT * FROM app_outbox_stale(500)')).rows;
    for (const r of stale) await enqueue(r.message_id, r.company_id);
    return { requeued: stale.length, failedUnknown: stuck };
  }

  const self = {
    routeByAccount, routeById, getCredentials, flagRoute, recordInbound, recordReadUpTo, signedMediaUrl, verifyMediaToken, recordStatus, storeInboundMedia, readAttachment,
    enqueue, sendQueued, sweep, emitConversation, emitMessage, userIdsFor, previewOf, maxMediaBytes
  };
  return self;
}

module.exports = { createMessaging, classifySendError, previewOf, TYPES };
