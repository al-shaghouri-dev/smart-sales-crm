const { defineAdapter, ProviderError } = require('../adapter');
const { verifyHmacSha256, safeEqual } = require('../../webhooks/signatures');

/**
 * Fake provider for local development and automated tests ONLY (refused in production).
 * It behaves like a real webhook-based messaging provider so the shared pipeline can be
 * exercised end to end without any external account:
 *
 *   POST /webhooks/fake            X-Fake-Signature: sha256=<hex HMAC of raw body with FAKE_PROVIDER_SECRET>
 *   body: { "events": [ { "id": "evt-1", "type": "message", "account": "acc-1",
 *                         "data": {...}, "behavior": { "failTimes": 2, "alwaysFail": false,
 *                         "permanent": false, "ignore": false, "delayMs": 0 } } ] }
 *   GET  /webhooks/fake?challenge=X&verify_token=<secret>   → echoes X (handshake like Meta)
 *
 * Messaging events (Phase 3.2), routed to the channel whose external account id = "account":
 *   type "message": data = { from: "user-1", name: "Sara", username: "sara", messageId: "m-1",
 *                            text: "hi", timestamp, media: { name, base64 } }
 *   type "status":  data = { messageId: "<external id returned by sendMessage>", status: "delivered"|"read"|"failed" }
 * Events of other types, or for accounts without a channel, keep the Phase 3.1 behaviour.
 *
 * `behavior` lets tests simulate transient failures, permanent failures, ignored events and
 * slow processing. Outbound sends are kept in `outbox` (memory only). A message text containing
 * "#fail:rate_limited", "#fail:token_invalid", "#fail:permanent", "#fail:network" or
 * "#fail:flaky<N>" (fails N times, then succeeds) simulates provider errors.
 */
function createFakeProvider({ secret, now = () => Date.now() } = {}) {
  if (!secret) throw new Error('FAKE_PROVIDER_SECRET is required when the fake provider is enabled');
  const outbox = [];
  const processed = [];
  const flaky = new Map();

  return defineAdapter({
    id: 'fake',
    displayName: 'Fake provider (testing)',
    capabilities: { inbound: true, outbound: true, media: true, templates: false, replyWindowHours: null },
    outbox,
    processed,

    connectMode: 'form',
    connectFields: [{ name: 'accountId', type: 'text', required: true }, { name: 'displayName', type: 'text', required: true }],

    /** Validates input like a real provider would validate a token; no external call. */
    async connect({ input }) {
      const accountId = String(input.accountId || '').trim();
      const displayName = String(input.displayName || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId) || !displayName) throw new ProviderError('provider.invalid_input', { retryable: false });
      return { displayName: displayName.slice(0, 120), externalAccountId: accountId, credentials: { accessToken: `fake-token-${accountId}` } };
    },

    async healthCheck({ credentials }) {
      return credentials ? { ok: true } : { ok: false, code: 'channel.credentials_unreadable' };
    },

    verifyRequest({ rawBody, headers }) {
      return verifyHmacSha256(rawBody, secret, headers['x-fake-signature']);
    },

    handleVerification({ query }) {
      if (query.challenge && safeEqual(query.verify_token, secret)) return { status: 200, body: String(query.challenge) };
      return { status: 403, body: 'Forbidden' };
    },

    parseEvents({ rawBody }) {
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 }); }
      if (!body || !Array.isArray(body.events) || body.events.length > 100) throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 });
      return body.events.map(e => {
        if (!e || typeof e.id !== 'string' || !e.id || e.id.length > 200) throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 });
        return { eventKey: e.id, type: String(e.type || 'message'), externalAccountId: e.account ? String(e.account) : null, payload: e };
      });
    },

    async processEvent(event, ctx = {}) {
      const b = event.payload.behavior || {};
      if (b.delayMs) await new Promise(r => setTimeout(r, Math.min(Number(b.delayMs), 30000)));
      if (b.permanent) throw new ProviderError('fake.permanent_failure', { retryable: false });
      if (b.alwaysFail || (b.failTimes && event.attempts <= b.failTimes)) throw new ProviderError('fake.transient_failure');
      if (b.ignore) return { status: 'ignored', reason: 'fake.ignored' };

      const data = event.payload.data || {};
      const type = event.event_type || event.payload.type || 'message';
      const route = ctx.messaging && event.external_account_id ? await ctx.messaging.routeByAccount('fake', event.external_account_id) : null;
      if (route && type === 'message' && data.from) {
        const attachments = [];
        if (data.media && typeof data.media.base64 === 'string') {
          const stored = await ctx.messaging.storeInboundMedia(route.company_id, Buffer.from(data.media.base64, 'base64'), { name: data.media.name });
          if (stored) attachments.push(stored);
        }
        const kind = attachments[0]?.kind;
        await ctx.messaging.recordInbound(route, {
          externalUserId: String(data.from), profile: { name: data.name, username: data.username },
          externalMessageId: data.messageId || event.event_key, body: data.text || null,
          type: attachments.length ? (kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'file') : 'text',
          attachments, timestamp: data.timestamp
        });
        processed.push({ eventKey: event.event_key, attempts: event.attempts, at: now() });
        return { status: 'processed', companyId: route.company_id, channelId: route.channel_id };
      }
      if (route && type === 'status') {
        const m = await ctx.messaging.recordStatus(route, { externalMessageId: data.messageId, status: data.status, errorCode: data.error });
        return m ? { status: 'processed', companyId: route.company_id, channelId: route.channel_id } : { status: 'ignored', reason: 'status.unknown_message', companyId: route.company_id };
      }
      // A messaging event for an account no channel is connected to: nothing to deliver.
      if (!route && ctx.messaging && event.external_account_id && (data.from || type === 'status')) {
        return { status: 'ignored', reason: 'channel.not_found' };
      }
      processed.push({ eventKey: event.event_key, attempts: event.attempts, at: now() });
      return { status: 'processed' };
    },

    async sendMessage(request) {
      if (!request || !request.to || typeof request.text !== 'string' || (!request.text && !(request.attachments || []).length)) {
        throw new ProviderError('provider.bad_request', { retryable: false });
      }
      const text = request.text;
      if (request.simulate === 'rate_limited' || text.includes('#fail:rate_limited')) throw new ProviderError('provider.rate_limited', { retryable: true });
      if (request.simulate === 'token_invalid' || text.includes('#fail:token_invalid')) throw new ProviderError('provider.token_invalid', { retryable: false });
      if (text.includes('#fail:permanent')) throw new ProviderError('provider.bad_request', { retryable: false });
      if (text.includes('#fail:network')) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const flakyMatch = /#fail:flaky(\d+)/.exec(text);
      if (flakyMatch && request.messageId) {
        const n = (flaky.get(request.messageId) || 0) + 1;
        flaky.set(request.messageId, n);
        if (n <= Number(flakyMatch[1])) throw new ProviderError('provider.unavailable', { retryable: true });
      }
      const files = [];
      for (const a of request.attachments || []) {
        const bytes = await a.read();
        files.push({ name: a.name, kind: a.kind, size: bytes ? bytes.length : 0 });
      }
      const externalMessageId = `fake-${outbox.length + 1}`;
      outbox.push({ ...request, attachments: files, credentials: request.credentials ? '[present]' : null, externalMessageId });
      return { externalMessageId };
    }
  });
}

module.exports = { createFakeProvider };
