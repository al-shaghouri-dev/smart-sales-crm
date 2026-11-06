const { test, describe, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const h = require('./helpers');
const { createRuntime } = require('../../server/runtime');
const { signHmacSha256 } = require('../../server/webhooks/signatures');
const { mapGraphError, parseSignedRequest } = require('../../server/channels/meta/core');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${label}`);
}
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(200)]);
const FB_SECRET = 'fb-app-secret-for-tests';
const IG_SECRET = 'ig-app-secret-for-tests';
const V = 'v24.0';

/** Generic mock: routes { 'GET /path': (ctx) => [status, json|Buffer] }; records calls; `fail` injects Graph errors. */
function mockServer(routes) {
  const state = { calls: [], fail: {} };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      const body = ct.includes('json') ? JSON.parse(raw.toString() || '{}') : ct.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(raw.toString())) : { raw: raw.toString('latin1') };
      const key = `${req.method} ${u.pathname}`;
      const ctx = { query: Object.fromEntries(u.searchParams), body, headers: req.headers, path: u.pathname, state };
      state.calls.push({ key, query: ctx.query, body, auth: req.headers.authorization || null });
      const f = state.fail[key];
      if (f && f.times > 0) { f.times--; res.writeHead(f.status || 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: f.error })); }
      const handler = routes[key] || Object.entries(routes).find(([k]) => new RegExp(`^${k.replace(/:[a-z]+/g, '[^/]+')}$`).test(key))?.[1];
      if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 803, message: 'unknown path' } })); }
      const [status, out, type] = handler(ctx);
      res.writeHead(status, { 'Content-Type': type || (Buffer.isBuffer(out) ? 'application/octet-stream' : 'application/json') });
      res.end(Buffer.isBuffer(out) ? out : JSON.stringify(out));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

describe('Phase 3.4–3.6 Meta channels', { skip }, () => {
  let fb, ig, n = 0;
  const runtimes = [];
  before(async () => {
    await h.setupDatabase();
    fb = await mockServer({
      [`GET /${V}/oauth/access_token`]: ({ query }) => (query.code === 'good-code' ? [200, { access_token: 'EAAshort', token_type: 'bearer' }]
        : query.fb_exchange_token ? [200, { access_token: 'EAAlongUserToken', expires_in: 5183944 }]
          : query.code === 'wa-code' ? [200, { access_token: 'EAAbusinessToken' }] : [400, { error: { code: 100, message: 'bad code' } }]),
      [`GET /${V}/me`]: () => [200, { id: 'fbuser-1', name: 'Admin' }],
      [`GET /${V}/me/accounts`]: () => [200, { data: [{ id: '1001', name: 'Nour Page', access_token: 'EAApageToken1001', tasks: ['MESSAGING'] }, { id: '1002', name: 'Second Page', access_token: 'EAApageToken1002', tasks: ['ANALYZE'] }] }],
      [`POST /${V}/:page/subscribed_apps`]: () => [200, { success: true }],
      [`DELETE /${V}/:page/subscribed_apps`]: () => [200, { success: true }],
      [`POST /${V}/me/messages`]: () => [200, { recipient_id: 'psid-1', message_id: `m_out_${++n}` }],
      [`GET /${V}/1001`]: () => [200, { id: '1001', name: 'Nour Page' }],
      [`GET /${V}/5550001`]: () => [200, { id: '5550001', display_phone_number: '+966 50 000 0001', verified_name: 'Nour Store', quality_rating: 'GREEN' }],
      [`POST /${V}/5550001/messages`]: () => [200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${++n}` }] }],
      [`POST /${V}/5550001/media`]: () => [200, { id: 'up-media-1' }],
      [`GET /${V}/media-in-1`]: ({ state }) => [200, { url: `${state.self}/cdn/doc.pdf`, file_size: PDF.length, mime_type: 'application/pdf' }],
      [`GET /${V}/9990001/message_templates`]: () => [200, { data: [{ name: 'order_update', language: 'ar', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'طلبك {{1}} جاهز' }] }, { name: 'draft', language: 'en', status: 'PENDING' }] }],
      'GET /cdn/img.jpg': () => [200, JPG, 'image/jpeg'],
      'GET /cdn/doc.pdf': ({ headers }) => (headers.authorization === 'Bearer EAAwaToken1234567890abcdef' ? [200, PDF, 'application/pdf'] : [401, { error: { code: 190 } }])
    });
    fb.state.self = fb.url;
    ig = await mockServer({
      'POST /oauth/access_token': ({ body }) => (body.code === 'ig-code' && body.client_secret === IG_SECRET ? [200, { access_token: 'IGshort', user_id: 17841400000000001 }] : [400, { error: { code: 100 } }]),
      'GET /access_token': ({ query }) => (query.grant_type === 'ig_exchange_token' ? [200, { access_token: 'IGlongToken', token_type: 'bearer', expires_in: 5184000 }] : [400, { error: { code: 100 } }]),
      'GET /refresh_access_token': () => [200, { access_token: 'IGrefreshedToken', expires_in: 5184000 }],
      [`GET /${V}/me`]: () => [200, { user_id: '17841400000000001', username: 'nour.shop', account_type: 'BUSINESS' }],
      [`POST /${V}/me/subscribed_apps`]: () => [200, { success: true }],
      [`POST /${V}/me/messages`]: () => [200, { recipient_id: 'igsid-1', message_id: `ig_out_${++n}` }]
    });
  });
  beforeEach(async () => { await h.resetDatabase(); for (const s of [fb.state, ig.state]) { s.calls.length = 0; s.fail = {}; } });
  afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop().catch(() => {}); });
  after(async () => { fb.server.close(); ig.server.close(); await h.teardown(); });

  const meta = (extra = {}) => ({ graphVersion: V, graphBase: fb.url, igGraphBase: ig.url, igApiBase: ig.url, appId: '111', appSecret: FB_SECRET, verifyToken: 'verify-me', igAppId: '222', igAppSecret: IG_SECRET, waConfigId: '', ...extra });
  async function start(metaExtra) {
    const r = createRuntime(h.runtimeConfig({ channelProviders: ['messenger', 'instagram', 'whatsapp'], webhookSecretKey: 'meta-test-webhook-key-0123456789abcdef', publicUrl: 'https://crm.example.test', meta: meta(metaExtra) }),
      { db: h.getDb(), apiRateLimit: 100000, port: 0 });
    runtimes.push(r);
    await r.start();
    return r;
  }
  async function owner(app, name = 'Nour') {
    const c = await h.createCompanyFixture(name, `owner@${name.toLowerCase()}.test`);
    const s = await h.login(app, `owner@${name.toLowerCase()}.test`);
    return { ...c, ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  const rows = (companyId, table, where = {}) => h.getDb().withContext({ companyId }, trx => trx(table).where(where));
  const hook = (app, provider, payload, secret) => {
    const raw = JSON.stringify(payload);
    return request(app).post(`/webhooks/${provider}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signHmacSha256(Buffer.from(raw), secret)).send(raw);
  };
  /** Run the OAuth round trip through the API exactly as a browser would. */
  async function oauth(app, o, provider, code) {
    const start = await o.agent.get(`/api/channels/${provider}/oauth/start`);
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.location);
    const cb = await o.agent.get(`/api/channels/oauth/callback/${provider}?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`);
    assert.equal(cb.status, 302);
    return { authorizeUrl: loc, redirect: new URL(cb.headers.location, 'https://x') };
  }

  test('Graph error mapping and signed_request parsing', () => {
    assert.equal(mapGraphError(400, { code: 190, error_subcode: 463 }).code, 'provider.token_expired');
    assert.equal(mapGraphError(400, { code: 190 }).code, 'provider.token_invalid');
    assert.equal(mapGraphError(400, { code: 10, error_subcode: 2018278 }).code, 'provider.window_closed');
    assert.equal(mapGraphError(400, { code: 200 }).code, 'provider.permission_revoked');
    assert.equal(mapGraphError(400, { code: 613 }).retryable, true);
    assert.equal(mapGraphError(400, { code: 131047 }).code, 'provider.window_closed');
    assert.equal(mapGraphError(400, { code: 551 }).code, 'provider.recipient_blocked');
    assert.equal(mapGraphError(500, {}).retryable, true);
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'u1' })).toString('base64url');
    const sig = crypto.createHmac('sha256', FB_SECRET).update(payload).digest('base64url');
    assert.equal(parseSignedRequest(`${sig}.${payload}`, FB_SECRET).user_id, 'u1');
    assert.equal(parseSignedRequest(`${sig}.${payload}`, 'other-secret'), null);
    assert.equal(parseSignedRequest(`${sig.slice(1)}x.${payload}`, FB_SECRET), null);
  });

  test('Messenger: verification handshake, signatures, OAuth page connect with encrypted Page tokens', async () => {
    const rt = await start();
    assert.equal((await request(rt.app).get('/webhooks/messenger?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345')).text, '12345');
    assert.equal((await request(rt.app).get('/webhooks/messenger?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
    assert.equal((await hook(rt.app, 'messenger', { object: 'page', entry: [] }, 'wrong-secret')).status, 401);
    const o = await owner(rt.app);
    // A forged callback (no cookie / wrong state) never connects anything.
    const forged = await o.agent.get('/api/channels/oauth/callback/messenger?code=good-code&state=abc.def');
    assert.match(forged.headers.location, /oauth_error=channels.oauth_invalid_state/);
    const { authorizeUrl, redirect } = await oauth(rt.app, o, 'messenger', 'good-code');
    assert.equal(authorizeUrl.origin, 'https://www.facebook.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), '111');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://crm.example.test/api/channels/oauth/callback/messenger');
    assert.match(authorizeUrl.searchParams.get('scope'), /pages_messaging/);
    const sessionId = redirect.searchParams.get('oauth');
    const sess = await o.agent.get(`/api/channels/oauth/sessions/${sessionId}`);
    assert.deepEqual(sess.body.session.accounts, [{ externalAccountId: '1001', displayName: 'Nour Page' }], 'pages without messaging access are not offered');
    assert.equal(JSON.stringify(sess.body).includes('EAA'), false, 'tokens never leave the server');
    const [stored] = await h.getDb().withContext({ companyId: o.companyId, userId: o.ownerUserId }, trx => trx('channel_oauth_sessions'));
    assert.equal((await rows(o.companyId, 'channel_oauth_sessions')).length, 0, 'OAuth sessions are visible only to the user who started them');
    assert.equal(stored.ciphertext.includes('EAApage'), false);
    const con = await o.call('post', `/api/channels/oauth/sessions/${sessionId}/connect`, { externalAccountId: '1001' });
    assert.equal(con.status, 201, JSON.stringify(con.body));
    const sub = fb.state.calls.find(c => c.key === `POST /${V}/1001/subscribed_apps`);
    assert.match(sub.query.subscribed_fields, /messages/);
    assert.equal(sub.auth, 'Bearer EAApageToken1001');
    assert.equal(sub.query.appsecret_proof, crypto.createHmac('sha256', FB_SECRET).update('EAApageToken1001').digest('hex'));
    const [ch] = await rows(o.companyId, 'channels');
    assert.equal(ch.external_meta.metaUserId, 'fbuser-1');
    // Another user of the same company cannot use this OAuth session.
    await h.addMember(o.companyId, 'admin', 'admin2@nour.test');
    const other = await h.login(rt.app, 'admin2@nour.test');
    assert.equal((await other.agent.get(`/api/channels/oauth/sessions/${sessionId}`)).status, 404);
  });

  async function messengerChannel(rt) {
    const o = await owner(rt.app);
    const { redirect } = await oauth(rt.app, o, 'messenger', 'good-code');
    const con = await o.call('post', `/api/channels/oauth/sessions/${redirect.searchParams.get('oauth')}/connect`, { externalAccountId: '1001' });
    return { ...o, channel: con.body.channel };
  }

  test('Messenger: inbound text + image, echoes ignored, delivery/read receipts, 24h window, token revocation', async () => {
    const rt = await start();
    const o = await messengerChannel(rt);
    const now = Date.now();
    await hook(rt.app, 'messenger', { object: 'page', entry: [{ id: '1001', time: now, messaging: [
      { sender: { id: 'psid-1' }, recipient: { id: '1001' }, timestamp: now, message: { mid: 'm_in_1', text: 'Hi, price?' } },
      { sender: { id: 'psid-1' }, recipient: { id: '1001' }, timestamp: now + 1, message: { mid: 'm_in_2', attachments: [{ type: 'image', payload: { url: `${fb.url}/cdn/img.jpg` } }] } },
      { sender: { id: '1001' }, recipient: { id: 'psid-1' }, timestamp: now + 2, message: { mid: 'm_echo', is_echo: true, text: 'echo' } }
    ] }] }, FB_SECRET);
    const msgs = await waitFor(async () => { const m = await rows(o.companyId, 'messages'); return m.length === 2 && m; }, { label: 'messenger inbound' });
    assert.equal(msgs.find(m => m.type === 'image').attachments[0].contentType, 'image/jpeg');
    const conv = (await rows(o.companyId, 'conversations'))[0];
    const r = await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'It is 50 SAR' });
    const sent = await waitFor(async () => { const m = (await rows(o.companyId, 'messages', { id: r.body.message.id }))[0]; return m.status === 'sent' && m; }, { label: 'messenger sent' });
    const call = fb.state.calls.find(c => c.key === `POST /${V}/me/messages`);
    assert.deepEqual(call.body, { recipient: { id: 'psid-1' }, messaging_type: 'RESPONSE', message: { text: 'It is 50 SAR' } });
    await hook(rt.app, 'messenger', { object: 'page', entry: [{ id: '1001', messaging: [{ sender: { id: 'psid-1' }, recipient: { id: '1001' }, timestamp: Date.now(), delivery: { mids: [sent.external_message_id], watermark: Date.now() } }] }] }, FB_SECRET);
    await waitFor(async () => (await rows(o.companyId, 'messages', { id: sent.id }))[0].status === 'delivered', { label: 'delivered' });
    await hook(rt.app, 'messenger', { object: 'page', entry: [{ id: '1001', messaging: [{ sender: { id: 'psid-1' }, recipient: { id: '1001' }, timestamp: Date.now() + 5, read: { watermark: Date.now() + 5 } }] }] }, FB_SECRET);
    await waitFor(async () => (await rows(o.companyId, 'messages', { id: sent.id }))[0].status === 'read', { label: 'read watermark' });
    // Provider says the window closed → permanent failure (no message tags are used).
    fb.state.fail[`POST /${V}/me/messages`] = { times: 1, error: { code: 10, error_subcode: 2018278, message: 'outside window' } };
    const late = await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'late' });
    const lateRow = await waitFor(async () => { const m = (await rows(o.companyId, 'messages', { id: late.body.message.id }))[0]; return m.status === 'failed' && m; }, { label: 'window failure' });
    assert.equal(lateRow.error_code, 'provider.window_closed');
    // Token revoked (190) → channel needs reconnect.
    fb.state.fail[`POST /${V}/me/messages`] = { times: 1, error: { code: 190, message: 'expired' } };
    const tok = await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'x' });
    await waitFor(async () => (await rows(o.companyId, 'messages', { id: tok.body.message.id }))[0].status === 'failed', { label: 'token failure' });
    assert.equal((await rows(o.companyId, 'channels'))[0].status, 'needs_reconnect');
    // Locally enforced 24-hour window: an old conversation cannot be answered.
    await h.getDb().withContext({ companyId: o.companyId }, trx => trx('conversations').update({ last_inbound_at: new Date(Date.now() - 25 * 3600 * 1000) }));
    await h.getDb().withContext({ companyId: o.companyId }, trx => trx('channels').update({ status: 'active' }));
    assert.equal((await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'too late' })).body.code, 'messages.window_closed');
  });

  test('Instagram Login: OAuth, long-lived token, inbound, send with signed media URL, token refresh', async () => {
    const rt = await start();
    const o = await owner(rt.app);
    const { authorizeUrl, redirect } = await oauth(rt.app, o, 'instagram', 'ig-code');
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.equal(authorizeUrl.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages');
    const con = await o.call('post', `/api/channels/oauth/sessions/${redirect.searchParams.get('oauth')}/connect`, { externalAccountId: '17841400000000001' });
    assert.equal(con.status, 201, JSON.stringify(con.body));
    assert.equal(con.body.channel.displayName, '@nour.shop');
    const [cred] = await rows(o.companyId, 'channel_credentials');
    assert.ok(cred.expires_at && new Date(cred.expires_at) > new Date(Date.now() + 50 * 86400 * 1000), 'long-lived token expiry stored');
    assert.ok(ig.state.calls.some(c => c.key === `POST /${V}/me/subscribed_apps` && c.auth === 'Bearer IGlongToken'));
    assert.equal((await hook(rt.app, 'instagram', { object: 'instagram', entry: [] }, FB_SECRET)).status, 401, 'Instagram webhooks use the Instagram app secret');
    await hook(rt.app, 'instagram', { object: 'instagram', entry: [{ id: '17841400000000001', time: Date.now(), messaging: [
      { sender: { id: 'igsid-1' }, recipient: { id: '17841400000000001' }, timestamp: Date.now(), message: { mid: 'ig_in_1', text: 'مرحبا' } }] }] }, IG_SECRET);
    const conv = await waitFor(async () => (await rows(o.companyId, 'conversations'))[0], { label: 'ig conversation' });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
    const r = await o.agent.post(`/api/conversations/${conv.id}/messages`).set('X-CSRF-Token', o.csrf).field('text', 'look').attach('file', png, 'p.png');
    await waitFor(async () => (await rows(o.companyId, 'messages', { id: r.body.message.id }))[0].status === 'sent', { label: 'ig sent' });
    const sends = ig.state.calls.filter(c => c.key === `POST /${V}/me/messages`);
    const url = new URL(sends[0].body.message.attachment.payload.url);
    assert.equal(url.origin, 'https://crm.example.test');
    assert.deepEqual(sends[1].body, { recipient: { id: 'igsid-1' }, message: { text: 'look' } });
    const fetched = await request(rt.app).get(url.pathname);
    assert.equal(fetched.status, 200);
    assert.equal(Buffer.compare(fetched.body, png), 0);
    assert.equal((await request(rt.app).get(url.pathname.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).status, 404, 'tampered link refused');
    // Refresh renews the long-lived token.
    const adapter = rt.providers.get('instagram');
    const refreshed = await adapter.refreshCredentials({ credentials: { accessToken: 'IGlongToken' } });
    assert.equal(refreshed.credentials.accessToken, 'IGrefreshedToken');
  });

  test('WhatsApp Cloud API: manual connect, media download, statuses, window + approved templates', async () => {
    const rt = await start();
    const o = await owner(rt.app);
    const bad = await o.call('post', '/api/channels/whatsapp/connect', { phoneNumberId: 'x', wabaId: '9990001', accessToken: 'short' });
    assert.equal(bad.body.code, 'provider.invalid_input');
    const con = await o.call('post', '/api/channels/whatsapp/connect', { phoneNumberId: '5550001', wabaId: '9990001', accessToken: 'EAAwaToken1234567890abcdef' });
    assert.equal(con.status, 201, JSON.stringify(con.body));
    assert.equal(con.body.channel.displayName, 'Nour Store (+966 50 000 0001)');
    assert.ok(fb.state.calls.some(c => c.key === `POST /${V}/9990001/subscribed_apps`));
    assert.equal((await o.call('post', '/api/channels/whatsapp/embedded-signup', { code: 'wa-code', phoneNumberId: '5550001', wabaId: '9990001' })).status, 404, 'Embedded Signup stays disabled');
    const wa = (value) => hook(rt.app, 'whatsapp', { object: 'whatsapp_business_account', entry: [{ id: '9990001', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '5550001' }, ...value } }] }] }, FB_SECRET);
    await wa({ contacts: [{ wa_id: '966500000009', profile: { name: 'Fahad' } }], messages: [
      { from: '966500000009', id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'أبي أطلب' } },
      { from: '966500000009', id: 'wamid.IN2', timestamp: String(Math.floor(Date.now() / 1000)), type: 'document', document: { id: 'media-in-1', filename: 'invoice.pdf', mime_type: 'application/pdf' } }] });
    const msgs = await waitFor(async () => { const m = await rows(o.companyId, 'messages'); return m.length === 2 && m; }, { label: 'wa inbound' });
    const doc = msgs.find(m => m.type === 'file');
    assert.equal(doc.attachments[0].name, 'invoice.pdf');
    assert.equal(doc.attachments[0].contentType, 'application/pdf');
    assert.equal((await rows(o.companyId, 'contacts'))[0].display_name, 'Fahad');
    const conv = (await rows(o.companyId, 'conversations'))[0];
    const r = await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'تم' });
    const sent = await waitFor(async () => { const m = (await rows(o.companyId, 'messages', { id: r.body.message.id }))[0]; return m.status === 'sent' && m; }, { label: 'wa sent' });
    const call = fb.state.calls.find(c => c.key === `POST /${V}/5550001/messages`);
    assert.equal(call.body.to, '966500000009');
    assert.deepEqual(call.body.text, { body: 'تم', preview_url: false });
    for (const status of ['delivered', 'read']) {
      await wa({ statuses: [{ id: sent.external_message_id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '966500000009' }] });
      await waitFor(async () => (await rows(o.companyId, 'messages', { id: sent.id }))[0].status === status, { label: status });
    }
    // Window closed: free text refused, approved template allowed.
    await h.getDb().withContext({ companyId: o.companyId }, trx => trx('conversations').update({ last_inbound_at: new Date(Date.now() - 30 * 3600 * 1000) }));
    assert.equal((await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'hello?' })).body.code, 'messages.window_closed');
    const templates = await o.agent.get(`/api/channels/${con.body.channel.id}/templates`);
    assert.deepEqual(templates.body.templates.map(t => t.name), ['order_update'], 'only approved templates');
    assert.equal(templates.body.templates[0].params, 1);
    const t = await o.call('post', `/api/conversations/${conv.id}/messages`, { template: { name: 'order_update', language: 'ar', params: ['#1042'] }, templatePreview: 'طلبك #1042 جاهز' });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    await waitFor(async () => (await rows(o.companyId, 'messages', { id: t.body.message.id }))[0].status === 'sent', { label: 'template sent' });
    const tcall = fb.state.calls.filter(c => c.key === `POST /${V}/5550001/messages`).pop();
    assert.deepEqual(tcall.body.template, { name: 'order_update', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '#1042' }] }] });
    // A failed status maps the WhatsApp error code.
    await wa({ statuses: [{ id: 'wamid.OUTX', status: 'failed', errors: [{ code: 131047 }] }] });
    assert.equal((await o.call('post', `/api/conversations/${conv.id}/messages`, { template: { name: 'BAD NAME', language: 'ar' } })).status, 400);
  });

  test('Deauthorize and Data Deletion callbacks verify signed_request and remove tokens', async () => {
    const rt = await start();
    const o = await messengerChannel(rt);
    const signed = (secret, data) => { const p = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', ...data })).toString('base64url'); return `${crypto.createHmac('sha256', secret).update(p).digest('base64url')}.${p}`; };
    assert.equal((await request(rt.app).post('/api/public/meta/messenger/deauthorize').type('form').send({ signed_request: signed('wrong', { user_id: 'fbuser-1' }) })).status, 400);
    assert.equal((await request(rt.app).post('/api/public/meta/messenger/deauthorize').type('form').send({ signed_request: signed(FB_SECRET, { user_id: 'fbuser-1' }) })).status, 200);
    let [ch] = await rows(o.companyId, 'channels');
    assert.equal(ch.status, 'needs_reconnect');
    assert.equal(ch.last_error, 'meta.deauthorized');
    assert.equal((await rows(o.companyId, 'channel_credentials')).length, 0);
    const del = await request(rt.app).post('/api/public/meta/messenger/data-deletion').type('form').send({ signed_request: signed(FB_SECRET, { user_id: 'fbuser-1' }) });
    assert.equal(del.status, 200);
    assert.match(del.body.confirmation_code, /^[0-9a-f]{24}$/);
    [ch] = await rows(o.companyId, 'channels');
    assert.equal(ch.status, 'disconnected');
    const page = await request(rt.app).get(new URL(del.body.url).pathname);
    assert.equal(page.status, 200);
    assert.match(page.text, /Completed/);
  });
});
