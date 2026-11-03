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
 * `behavior` lets tests simulate transient failures, permanent failures, ignored events and
 * slow processing. Sent messages are kept in `outbox` (memory only).
 */
function createFakeProvider({ secret, now = () => Date.now() } = {}) {
  if (!secret) throw new Error('FAKE_PROVIDER_SECRET is required when the fake provider is enabled');
  const outbox = [];
  const processed = [];

  return defineAdapter({
    id: 'fake',
    displayName: 'Fake provider (testing)',
    capabilities: { inbound: true, outbound: true, media: false, templates: false },
    outbox,
    processed,

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

    async processEvent(event) {
      const b = event.payload.behavior || {};
      if (b.delayMs) await new Promise(r => setTimeout(r, Math.min(Number(b.delayMs), 30000)));
      if (b.permanent) throw new ProviderError('fake.permanent_failure', { retryable: false });
      if (b.alwaysFail || (b.failTimes && event.attempts <= b.failTimes)) throw new ProviderError('fake.transient_failure');
      if (b.ignore) return { status: 'ignored', reason: 'fake.ignored' };
      processed.push({ eventKey: event.event_key, attempts: event.attempts, at: now() });
      return { status: 'processed' };
    },

    async sendMessage(request) {
      if (!request || !request.to || typeof request.text !== 'string') throw new ProviderError('provider.bad_request', { retryable: false });
      if (request.simulate === 'rate_limited') throw new ProviderError('provider.rate_limited', { retryable: true });
      if (request.simulate === 'token_invalid') throw new ProviderError('provider.token_invalid', { retryable: false });
      const externalMessageId = `fake-${outbox.length + 1}`;
      outbox.push({ ...request, externalMessageId });
      return { externalMessageId };
    }
  });
}

module.exports = { createFakeProvider };
