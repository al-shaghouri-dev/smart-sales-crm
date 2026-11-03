const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyHmacSha256, signHmacSha256, verifySharedSecret, safeEqual } = require('../../server/webhooks/signatures');
const { defineAdapter, ProviderError } = require('../../server/channels/adapter');
const { createProviderRegistry } = require('../../server/channels/registry');
const { createFakeProvider } = require('../../server/channels/providers/fake');
const { loadConfig } = require('../../server/config');
const { redact } = require('../../server/webhooks/processor');

describe('webhook signature verification', () => {
  const secret = 'app-secret-for-tests';
  // Providers escape non-ASCII (م…); re-serialising parsed JSON would produce different bytes.
  const raw = Buffer.from('{"text":"\\u0645\\u0631\\u062d\\u0628\\u0627","n":1}');

  test('HMAC-SHA256 over the exact raw bytes', () => {
    const header = signHmacSha256(raw, secret);
    assert.equal(verifyHmacSha256(raw, secret, header), true);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    assert.equal(verifyHmacSha256(reserialised, secret, header), false, 're-serialised JSON must not verify');
  });

  test('rejects missing, malformed, wrong-secret, wrong-prefix and truncated signatures', () => {
    const header = signHmacSha256(raw, secret);
    for (const bad of [undefined, '', 'sha256=', header.slice(0, -2), 'sha1=' + header.slice(7), signHmacSha256(raw, 'other'), 'sha256=' + 'g'.repeat(64)]) {
      assert.equal(verifyHmacSha256(raw, secret, bad), false, String(bad));
    }
    assert.equal(verifyHmacSha256(raw, '', header), false, 'no secret configured → never valid');
    assert.equal(verifyHmacSha256('not-a-buffer', secret, header), false);
    assert.equal(verifyHmacSha256(raw, secret, header.toUpperCase().replace('SHA256=', 'sha256=')), true, 'hex case-insensitive');
  });

  test('shared-secret header (Telegram style) and constant-time compare', () => {
    assert.equal(verifySharedSecret('abc_DEF-123', 'abc_DEF-123'), true);
    for (const bad of ['', undefined, 'abc_DEF-12', 'abc_DEF-1234', 'ABC_DEF-123']) assert.equal(verifySharedSecret(bad, 'abc_DEF-123'), false);
    assert.equal(verifySharedSecret('x', ''), false, 'no expected secret → never valid');
    assert.equal(safeEqual('a', 'a'), true);
    assert.equal(safeEqual('a', 'ab'), false);
  });
});

describe('provider adapter contract & registry', () => {
  const base = { id: 'demo', displayName: 'Demo', capabilities: {}, verifyRequest() {}, parseEvents() {}, processEvent() {}, sendMessage() {} };

  test('defineAdapter validates required members', () => {
    assert.ok(Object.isFrozen(defineAdapter(base)));
    for (const missing of ['verifyRequest', 'parseEvents', 'processEvent', 'sendMessage']) {
      const def = { ...base }; delete def[missing];
      assert.throws(() => defineAdapter(def), new RegExp(missing));
    }
    assert.throws(() => defineAdapter({ ...base, id: 'Bad Id' }), /invalid/);
    assert.throws(() => defineAdapter({ ...base, handleVerification: 'nope' }), /must be a function/);
  });

  test('registry: planned providers fail loudly; fake refused in production; unknown rejected', () => {
    assert.throws(() => createProviderRegistry({ channelProviders: ['telegram'] }), /Phase 3\.3/);
    assert.throws(() => createProviderRegistry({ channelProviders: ['whatsapp'] }), /Phase 3\.6/);
    assert.throws(() => createProviderRegistry({ channelProviders: ['fake'], isProd: true, fakeProviderSecret: 's' }), /production/);
    assert.throws(() => createProviderRegistry({ channelProviders: ['nope'] }), /Unknown/);
    assert.throws(() => createProviderRegistry({ channelProviders: ['fake'] }), /FAKE_PROVIDER_SECRET/);
    const r = createProviderRegistry({ channelProviders: ['fake'], fakeProviderSecret: 's' });
    assert.deepEqual(r.list().map(a => a.id), ['fake']);
    assert.equal(r.get('telegram'), null);
  });

  test('config validation protects production', () => {
    const base = { DATABASE_URL: 'postgres://x@localhost/x' };
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /APP_ENCRYPTION_KEYS/);
    const prod = { ...base, NODE_ENV: 'production', APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') };
    assert.ok(loadConfig(prod).keyRing);
    assert.throws(() => loadConfig({ ...prod, CHANNEL_PROVIDERS: 'fake' }), /fake channel provider/);
    assert.throws(() => loadConfig({ ...base, PROCESS_ROLE: 'both' }), /PROCESS_ROLE/);
    assert.throws(() => loadConfig({ ...base, REALTIME_ADAPTER: 'redis' }), /REALTIME_ADAPTER/);
    assert.equal(loadConfig(base).trustProxy, false);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy, 1);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy, 2, 'Vercel rewrite + host load balancer');
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '0' }).trustProxy, false);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: 'yes' }).trustProxy, false, 'invalid values never trust');
    const c = loadConfig({ ...base, APP_URL: 'https://crm.example.test/' });
    assert.deepEqual(c.realtime.allowedOrigins, ['https://crm.example.test'], 'realtime origins default to APP_URL');
  });
});

describe('fake provider (mock) behaviour', () => {
  const fake = createFakeProvider({ secret: 'fake-secret' });
  const body = obj => Buffer.from(JSON.stringify(obj));

  test('verification, handshake and parsing', () => {
    const raw = body({ events: [{ id: 'e1', account: 'acc', type: 'message' }] });
    assert.equal(fake.verifyRequest({ rawBody: raw, headers: { 'x-fake-signature': signHmacSha256(raw, 'fake-secret') } }), true);
    assert.equal(fake.verifyRequest({ rawBody: raw, headers: {} }), false);
    assert.deepEqual(fake.handleVerification({ query: { challenge: 'c1', verify_token: 'fake-secret' } }), { status: 200, body: 'c1' });
    assert.equal(fake.handleVerification({ query: { challenge: 'c1', verify_token: 'nope' } }).status, 403);
    const [e] = fake.parseEvents({ rawBody: raw });
    assert.deepEqual([e.eventKey, e.externalAccountId, e.type], ['e1', 'acc', 'message']);
    for (const bad of [Buffer.from('not json'), body({}), body({ events: [{ id: '' }] }), body({ events: new Array(101).fill({ id: 'x' }) })]) {
      assert.throws(() => fake.parseEvents({ rawBody: bad }), e2 => e2 instanceof ProviderError && e2.retryable === false);
    }
  });

  test('processing behaviours', async () => {
    const ev = (behavior, attempts = 1) => ({ event_key: 'k', attempts, payload: { behavior } });
    assert.deepEqual(await fake.processEvent(ev({})), { status: 'processed' });
    assert.deepEqual(await fake.processEvent(ev({ ignore: true })), { status: 'ignored', reason: 'fake.ignored' });
    await assert.rejects(fake.processEvent(ev({ failTimes: 2 }, 2)), e => e.code === 'fake.transient_failure' && e.retryable);
    assert.equal((await fake.processEvent(ev({ failTimes: 2 }, 3))).status, 'processed');
    await assert.rejects(fake.processEvent(ev({ permanent: true })), e => e.retryable === false);
  });

  test('sending: outbox and error classification', async () => {
    const r = await fake.sendMessage({ to: 'user-1', text: 'hi' });
    assert.equal(r.externalMessageId, 'fake-1');
    assert.equal(fake.outbox.length, 1);
    await assert.rejects(fake.sendMessage({ to: 'u', text: 'x', simulate: 'rate_limited' }), e => e.code === 'provider.rate_limited' && e.retryable);
    await assert.rejects(fake.sendMessage({ to: 'u', text: 'x', simulate: 'token_invalid' }), e => e.code === 'provider.token_invalid' && !e.retryable);
    await assert.rejects(fake.sendMessage({ text: 'x' }), e => e.code === 'provider.bad_request');
  });

  test('stored error text redacts token-like strings', () => {
    assert.equal(redact('failed with token Zx9QwErTyUiOpAsDfGhJkLzXcVbNm123456'), 'failed with token [redacted]');
    assert.ok(redact('x'.repeat(1000)).length <= 300);
  });
});
