/**
 * Channel provider adapter contract.
 *
 * Every messaging provider (Telegram, Messenger, Instagram, WhatsApp, and the fake test provider)
 * implements this interface. Provider-specific rules (signature formats, payload shapes, API calls)
 * live ONLY inside adapters; the shared pipeline never inspects provider payloads itself.
 *
 * Required members
 *   id            string   stable provider key used in URLs and the database ("telegram", …)
 *   displayName   string
 *   capabilities  object   e.g. { inbound: true, outbound: true, media: false, templates: false }
 *   verifyRequest({ rawBody: Buffer, headers, query, endpointKey }) → boolean
 *        Authenticate a webhook delivery. Must use the raw bytes. Never throw on bad input.
 *   parseEvents({ rawBody, headers, endpointKey }) → Array<ParsedEvent>
 *        Split one delivery into events. Throw ProviderError('webhook.bad_payload') on garbage.
 *        ParsedEvent = { eventKey: string (unique per provider, used for de-duplication),
 *                        type: string, externalAccountId?: string, payload: object }
 *   processEvent(event, ctx) → Promise<{ status: 'processed'|'ignored', companyId?, channelId?, reason? }>
 *        Handle one stored event (idempotently). Throw ProviderError for failures; set
 *        retryable=false for errors that will never succeed.
 *   sendMessage(request, ctx) → Promise<{ externalMessageId: string }>
 *
 * Optional members
 *   handleVerification({ query, endpointKey }) → { status, body }   GET handshake (e.g. Meta hub.challenge)
 *   ackResponse() → { status, body }                                  custom 2xx acknowledgement
 *   connectMode 'form' | 'oauth'    how the connect UI collects input; connectFields: [{ name, type, required }]
 *   connect({ input, config, companyId }) → { displayName, externalAccountId, externalMeta?,
 *        credentials (encrypted at rest), scopes?, expiresAt? }   validate input with the provider
 *   afterConnect({ channel, credentials, config })   e.g. register the webhook (inside the DB transaction)
 *   disconnect({ channel, credentials, config })     e.g. remove the webhook (best effort)
 *   healthCheck({ channel, credentials, config }) → { ok, code? }
 *   refreshCredentials({ channel, credentials, config }) → { credentials, expiresAt }   token refresh
 *   capabilities.replyWindowHours   provider customer-service window enforced before queueing
 */

class ProviderError extends Error {
  /**
   * @param {string} code       stable machine code, e.g. "provider.rate_limited"
   * @param {object} [opts]     { retryable = true, message, status }
   */
  constructor(code, { retryable = true, message, status } = {}) {
    super(message || code);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    if (status) this.status = status;
  }
}

const REQUIRED_FUNCTIONS = ['verifyRequest', 'parseEvents', 'processEvent', 'sendMessage'];
const ID = /^[a-z][a-z0-9_]{1,30}$/;

/** Validate and freeze an adapter definition. Throws at start-up on a broken adapter. */
function defineAdapter(def) {
  if (!def || typeof def !== 'object') throw new TypeError('Adapter definition must be an object');
  if (!ID.test(String(def.id))) throw new TypeError(`Adapter id "${def.id}" is invalid`);
  if (!def.displayName) throw new TypeError(`Adapter ${def.id} needs a displayName`);
  if (!def.capabilities || typeof def.capabilities !== 'object') throw new TypeError(`Adapter ${def.id} needs capabilities`);
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof def[fn] !== 'function') throw new TypeError(`Adapter ${def.id} must implement ${fn}()`);
  }
  for (const fn of ['handleVerification', 'ackResponse', 'connect', 'afterConnect', 'disconnect', 'refreshCredentials', 'healthCheck', 'oauthStart', 'oauthCallback']) {
    if (def[fn] !== undefined && typeof def[fn] !== 'function') throw new TypeError(`Adapter ${def.id}.${fn} must be a function`);
  }
  return Object.freeze({ ...def });
}

/** Wrap transport failures (DNS, timeouts, SSRF refusals) so callers always see a ProviderError code. */
async function providerCall(fn) {
  try { return await fn(); } catch (error) {
    if (error instanceof ProviderError || error?.name === 'ProviderError') throw error;
    const blocked = ['net.private_address', 'net.insecure_url', 'net.host_not_allowed', 'net.invalid_url', 'net.too_large'].includes(error?.message);
    throw new ProviderError(blocked ? (error.message === 'net.too_large' ? 'provider.media_too_large' : 'provider.bad_request') : 'provider.network_error', { retryable: !blocked });
  }
}

module.exports = { defineAdapter, ProviderError, providerCall };
