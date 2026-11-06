const { test, describe, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const h = require('./helpers');
const { createRuntime } = require('../../server/runtime');
const { webhookSecret } = require('../../server/channels/providers/telegram');
const { safeFetch, isPrivateAddress } = require('../../server/net/safe-fetch');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${label}`);
}
const TOKEN = '123456789:AAHfakeTokenForMockServer_abcdefghijkl';
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)]);

/** Minimal Telegram Bot API stand-in: same paths, payloads and error format as the real API. */
function mockTelegram() {
  const state = { calls: [], webhook: null, fail: {}, nextId: 100 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const fileMatch = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (fileMatch) { res.writeHead(fileMatch[1] === TOKEN ? 200 : 401); return res.end(fileMatch[1] === TOKEN ? PHOTO : ''); }
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
      const [, token, method] = m;
      const ct = req.headers['content-type'] || '';
      const params = ct.includes('json') ? JSON.parse(raw.toString() || '{}') : { multipart: true, size: raw.length, raw: raw.toString('latin1') };
      state.calls.push({ method, params });
      if (token !== TOKEN) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const f = state.fail[method];
      if (f && f.times > 0) { f.times--; return send(f.status, { ok: false, error_code: f.status, description: f.description || 'error', parameters: f.status === 429 ? { retry_after: 1 } : undefined }); }
      switch (method) {
        case 'getMe': return send(200, { ok: true, result: { id: 987654321, is_bot: true, first_name: 'Nour Shop', username: 'nour_shop_bot' } });
        case 'setWebhook': state.webhook = params; return send(200, { ok: true, result: true });
        case 'deleteWebhook': state.webhook = null; return send(200, { ok: true, result: true });
        case 'getWebhookInfo': return send(200, { ok: true, result: { url: state.webhook?.url || '', pending_update_count: 0 } });
        case 'getFile': return send(200, { ok: true, result: { file_id: params.file_id, file_size: PHOTO.length, file_path: 'photos/file_1.jpg' } });
        case 'sendMessage': case 'sendPhoto': case 'sendDocument': return send(200, { ok: true, result: { message_id: state.nextId++, date: Math.floor(Date.now() / 1000) } });
        default: return send(400, { ok: false, error_code: 400, description: 'Bad Request: method not found' });
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

describe('Phase 3.3 Telegram', { skip }, () => {
  let tg;
  const runtimes = [];
  before(async () => { await h.setupDatabase(); tg = await mockTelegram(); });
  beforeEach(async () => { await h.resetDatabase(); tg.state.calls.length = 0; tg.state.fail = {}; tg.state.webhook = null; });
  afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop().catch(() => {}); });
  after(async () => { tg.server.close(); await h.teardown(); });

  const WEBHOOK_KEY = 'test-webhook-secret-key-0123456789abcdef';
  async function start() {
    const r = createRuntime(h.runtimeConfig({ channelProviders: ['telegram'], webhookSecretKey: WEBHOOK_KEY, publicUrl: 'https://crm.example.test', telegram: { apiBase: tg.url } }),
      { db: h.getDb(), apiRateLimit: 100000, port: 0 });
    runtimes.push(r);
    await r.start();
    return r;
  }
  async function session(app, email) {
    const s = await h.login(app, email);
    return { ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  const rows = (companyId, table, where = {}) => h.getDb().withContext({ companyId }, trx => trx(table).where(where));
  async function connected(rt) {
    const c = await h.createCompanyFixture('Nour', 'owner@nour.test');
    const owner = await session(rt.app, 'owner@nour.test');
    const res = await owner.call('post', '/api/channels/telegram/connect', { token: TOKEN });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { ...c, owner, channel: res.body.channel };
  }
  const update = (channelId, upd, secret) => request(runtimes[0].app).post(`/webhooks/telegram/${channelId}`).set('Content-Type', 'application/json')
    .set('X-Telegram-Bot-Api-Secret-Token', secret ?? webhookSecret({ webhookSecretKey: WEBHOOK_KEY }, channelId)).send(JSON.stringify(upd));
  const privateMsg = (id, extra = {}) => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 5551, type: 'private' }, from: { id: 5551, is_bot: false, first_name: 'Khaled', last_name: 'A.', username: 'khaled' }, text: `hello ${id}`, ...extra } });

  test('connect validates the token with getMe, stores it encrypted and registers a secret webhook', async () => {
    const rt = await start();
    const c = await h.createCompanyFixture('Nour', 'owner@nour.test');
    const owner = await session(rt.app, 'owner@nour.test');
    assert.equal((await owner.call('post', '/api/channels/telegram/connect', { token: 'not-a-token' })).body.code, 'provider.invalid_input');
    const wrong = await owner.call('post', '/api/channels/telegram/connect', { token: '123456789:AAHwrongTokenxxxxxxxxxxxxxxxxxxxxxxxx' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'provider.token_invalid');
    assert.equal((await rows(c.companyId, 'channels')).length, 0, 'nothing stored for a bad token');
    const ok = await owner.call('post', '/api/channels/telegram/connect', { token: TOKEN });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.channel.displayName, 'Nour Shop (@nour_shop_bot)');
    assert.equal(ok.body.channel.externalAccountId, '987654321');
    assert.equal(JSON.stringify(ok.body).includes(TOKEN), false);
    assert.equal(tg.state.webhook.url, `https://crm.example.test/webhooks/telegram/${ok.body.channel.id}`);
    assert.equal(tg.state.webhook.secret_token, webhookSecret({ webhookSecretKey: WEBHOOK_KEY }, ok.body.channel.id));
    assert.deepEqual(tg.state.webhook.allowed_updates, ['message']);
    const [cred] = await rows(c.companyId, 'channel_credentials');
    assert.equal(cred.ciphertext.includes(TOKEN.split(':')[1]), false);
    // setWebhook failure rolls the whole connection back.
    await owner.call('delete', `/api/channels/${ok.body.channel.id}`);
    assert.equal(tg.state.webhook, null, 'deleteWebhook on disconnect');
    tg.state.fail.setWebhook = { times: 1, status: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided for webhook' };
    const failed = await owner.call('post', '/api/channels/telegram/connect', { token: TOKEN });
    assert.equal(failed.body.code, 'provider.bad_request');
    assert.equal((await rows(c.companyId, 'channels')).filter(x => x.status !== 'disconnected').length, 0);
  });

  test('webhooks: secret required; private text and photo stored; groups, bots and duplicates ignored', async () => {
    const rt = await start();
    const a = await connected(rt);
    assert.equal((await update(a.channel.id, privateMsg(1), 'wrong')).status, 401);
    assert.equal((await update(a.channel.id, privateMsg(1), '')).status, 401);
    assert.equal((await update('not-a-uuid', privateMsg(1))).status, 401);
    // A valid secret for ANOTHER channel id does not work.
    assert.equal((await update(a.channel.id, privateMsg(1), webhookSecret({ webhookSecretKey: WEBHOOK_KEY }, crypto.randomUUID()))).status, 401);
    assert.equal((await update(a.channel.id, privateMsg(1))).status, 200);
    assert.equal((await update(a.channel.id, privateMsg(1))).status, 200);
    await update(a.channel.id, privateMsg(2, { text: undefined, caption: 'product photo', photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: PHOTO.length }] }));
    await update(a.channel.id, { update_id: 3, message: { message_id: 3, chat: { id: -100, type: 'group' }, from: { id: 1, first_name: 'G' }, text: 'group' } });
    await update(a.channel.id, { update_id: 4, edited_message: { message_id: 1, chat: { id: 5551, type: 'private' }, text: 'edit' } });
    const msgs = await waitFor(async () => { const m = await rows(a.companyId, 'messages'); return m.length === 2 && m; }, { label: 'two messages' });
    await waitFor(async () => (await h.getDb().withContext({ system: true }, trx => trx('webhook_events'))).every(e => ['processed', 'ignored'].includes(e.status)), { label: 'all handled' });
    const photo = msgs.find(m => m.type === 'image');
    assert.equal(photo.body, 'product photo');
    assert.equal(photo.attachments[0].contentType, 'image/jpeg');
    assert.equal(photo.external_message_id, '5551:2');
    assert.ok(tg.state.calls.some(c => c.method === 'getFile' && c.params.file_id === 'big'), 'largest photo size downloaded');
    const [contact] = await rows(a.companyId, 'contacts');
    assert.equal(contact.display_name, 'Khaled A.');
    const events = await h.getDb().withContext({ system: true }, trx => trx('webhook_events').orderBy('event_key'));
    assert.equal(events.length, 4, 'duplicate update stored once');
    assert.ok(events.some(e => e.last_error === 'telegram.not_private_chat'));
    assert.ok(events.some(e => e.last_error === 'telegram.unsupported_update'));
  });

  test('replies: text and photo; 429 retried; 403 permanent; 401 flags the channel', async () => {
    const rt = await start();
    const a = await connected(rt);
    await update(a.channel.id, privateMsg(10));
    const conv = await waitFor(async () => (await rows(a.companyId, 'conversations'))[0], { label: 'conversation' });
    const msg = id => rows(a.companyId, 'messages', { id }).then(r => r[0]);

    tg.state.fail.sendMessage = { times: 1, status: 429, description: 'Too Many Requests: retry after 1' };
    const r1 = await a.owner.call('post', `/api/conversations/${conv.id}/messages`, { text: 'مرحباً خالد' });
    const sent = await waitFor(async () => { const m = await msg(r1.body.message.id); return m.status === 'sent' && m; }, { label: 'sent after 429' });
    assert.equal(sent.attempts, 2);
    assert.match(sent.external_message_id, /^5551:\d+$/);
    const call = tg.state.calls.filter(c => c.method === 'sendMessage').pop();
    assert.deepEqual(call.params, { chat_id: '5551', text: 'مرحباً خالد' });

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
    const r2 = await a.owner.agent.post(`/api/conversations/${conv.id}/messages`).set('X-CSRF-Token', a.owner.csrf).field('text', 'catalog').attach('file', png, 'catalog.png');
    await waitFor(async () => (await msg(r2.body.message.id)).status === 'sent', { label: 'photo sent' });
    const photoCall = tg.state.calls.find(c => c.method === 'sendPhoto');
    assert.ok(photoCall.params.multipart && photoCall.params.raw.includes('name="caption"') && photoCall.params.raw.includes('catalog'));

    tg.state.fail.sendMessage = { times: 1, status: 403, description: 'Forbidden: bot was blocked by the user' };
    const r3 = await a.owner.call('post', `/api/conversations/${conv.id}/messages`, { text: 'blocked?' });
    const blocked = await waitFor(async () => { const m = await msg(r3.body.message.id); return m.status === 'failed' && m; }, { label: 'blocked' });
    assert.equal(blocked.error_code, 'provider.recipient_blocked');
    assert.equal(blocked.attempts, 1);
    assert.equal((await rows(a.companyId, 'channels'))[0].status, 'active');

    tg.state.fail.sendMessage = { times: 1, status: 401, description: 'Unauthorized' };
    const r4 = await a.owner.call('post', `/api/conversations/${conv.id}/messages`, { text: 'revoked?' });
    const revoked = await waitFor(async () => { const m = await msg(r4.body.message.id); return m.status === 'failed' && m; }, { label: 'revoked' });
    assert.equal(revoked.error_code, 'provider.token_invalid');
    const [ch] = await rows(a.companyId, 'channels');
    assert.equal(ch.status, 'needs_reconnect');
    // Reconnecting with the same bot restores the same channel (no extra slot) and re-registers the webhook.
    const again = await a.owner.call('post', '/api/channels/telegram/connect', { token: TOKEN });
    assert.equal(again.status, 200);
    assert.equal(again.body.channel.id, a.channel.id);
    assert.equal(again.body.channel.status, 'active');
  });

  test('connection test checks the bot and restores a changed webhook', async () => {
    const rt = await start();
    const a = await connected(rt);
    tg.state.webhook = { url: 'https://someone-else.example/hook' };
    const t1 = await a.owner.call('post', `/api/channels/${a.channel.id}/test`);
    assert.equal(t1.body.ok, true);
    assert.equal(tg.state.webhook.url, `https://crm.example.test/webhooks/telegram/${a.channel.id}`);
    tg.state.fail.getMe = { times: 1, status: 401 };
    const t2 = await a.owner.call('post', `/api/channels/${a.channel.id}/test`);
    assert.equal(t2.body.ok, false);
    assert.equal(t2.body.channel.status, 'needs_reconnect');
  });
});

describe('SSRF protection (safeFetch)', () => {
  test('private, loopback, link-local and metadata addresses are refused', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '149.154.167.220', '2a00:1450:4001:80b::200e']) assert.equal(isPrivateAddress(ip), false, ip);
    await assert.rejects(safeFetch('https://127.0.0.1/x'), { code: 'net.private_address' });
    await assert.rejects(safeFetch('https://169.254.169.254/latest/meta-data/'), { code: 'net.private_address' });
    await assert.rejects(safeFetch('https://[::1]/'), { code: 'net.private_address' });
    await assert.rejects(safeFetch('http://example.com/'), { code: 'net.insecure_url' });
    await assert.rejects(safeFetch('file:///etc/passwd'), { code: 'net.insecure_url' });
    await assert.rejects(safeFetch('https://user:pw@example.com/'), { code: 'net.invalid_url' });
    await assert.rejects(safeFetch('https://localhost/'), { code: 'net.private_address' });
    await assert.rejects(safeFetch('https://evil.example/', { allowedHosts: ['graph.facebook.com'] }), { code: 'net.host_not_allowed' });
  });

  test('redirects are re-validated and size limits enforced', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect-private') { res.writeHead(302, { Location: 'http://169.254.169.254/latest' }); return res.end(); }
      if (req.url === '/big') { res.writeHead(200); return res.end(Buffer.alloc(5000)); }
      res.writeHead(200); res.end('ok');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // Test servers are local, so allowPrivate is needed for the first hop only; the redirect
      // target is still checked against the protocol rules and refused when not allowed.
      await assert.rejects(safeFetch(`${base}/redirect-private`, { allowHttp: true, allowPrivate: true, allowedHosts: ['127.0.0.1'] }), { code: 'net.host_not_allowed' });
      await assert.rejects(safeFetch(`${base}/big`, { allowHttp: true, allowPrivate: true, maxBytes: 1000 }), { code: 'net.too_large' });
      assert.equal((await safeFetch(`${base}/ok`, { allowHttp: true, allowPrivate: true })).body.toString(), 'ok');
      await assert.rejects(safeFetch(`${base}/ok`, { allowHttp: true }), { code: 'net.private_address' });
    } finally { server.close(); }
  });
});
