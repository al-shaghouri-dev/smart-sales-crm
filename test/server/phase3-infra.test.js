const { test, describe, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const h = require('./helpers');
const { createRuntime } = require('../../server/runtime');
const { defineAdapter, ProviderError } = require('../../server/channels/adapter');
const { signHmacSha256 } = require('../../server/webhooks/signatures');
const { createKeyRing, reencryptColumn } = require('../../server/security/secrets');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';
const SECRET = 'fake-test-secret';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('Phase 3.1 infrastructure', { skip }, () => {
  let rt = null;
  const runtimes = [];
  const sockets = [];

  before(async () => { await h.setupDatabase(); });
  beforeEach(() => h.resetDatabase());
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const r of runtimes.splice(0)) await r.stop().catch(() => {});
    rt = null;
  });
  after(() => h.teardown());

  async function startRuntime(overrides = {}, options = {}) {
    const r = createRuntime(h.runtimeConfig(overrides), { db: h.getDb(), apiRateLimit: 100000, port: 0, ...options });
    runtimes.push(r);
    const { port } = await r.start();
    r.url = `http://localhost:${port}`;
    return r;
  }
  const events = () => h.getDb().withContext({ system: true }, trx => trx('webhook_events').orderBy('received_at'));
  const eventByKey = key => h.getDb().withContext({ system: true }, trx => trx('webhook_events').where({ event_key: key }).first());
  const deliver = (app, payload, { signature, raw } = {}) => {
    const body = raw ?? Buffer.from(JSON.stringify(payload));
    // Send the exact bytes (supertest would re-encode a Buffer given a JSON content type).
    return request(app).post('/webhooks/fake').set('Content-Type', 'application/json')
      .set('X-Fake-Signature', signature ?? signHmacSha256(body, SECRET)).send(body.toString('utf8'));
  };

  // ------------------------------------------------------------------ webhooks
  describe('webhook ingestion pipeline', () => {
    test('signed delivery is stored before the 200, then processed asynchronously', async () => {
      rt = await startRuntime();
      const res = await deliver(rt.app, { events: [{ id: 'evt-1', account: 'acc-1', type: 'message', data: { text: 'hi' } }] });
      assert.equal(res.status, 200);
      const stored = await eventByKey('evt-1');
      assert.ok(stored, 'persisted before acknowledging');
      assert.equal(stored.external_account_id, 'acc-1');
      const done = await waitFor(async () => { const e = await eventByKey('evt-1'); return e.status === 'processed' && e; }, { label: 'processed' });
      assert.equal(done.attempts, 1);
      assert.equal(rt.providers.get('fake').processed.length, 1);
      // Job payloads carry identifiers only — never provider data.
      const jobs = await h.getDb().knex.raw("SELECT data FROM pgboss.job WHERE name = 'webhook.process'");
      assert.ok(jobs.rows.length >= 1);
      assert.deepEqual(Object.keys(jobs.rows[0].data), ['eventId']);
    });

    test('raw-byte signatures: escaped Unicode body verifies; any change is rejected and nothing stored', async () => {
      rt = await startRuntime();
      const raw = Buffer.from('{"events":[{"id":"evt-ar","data":{"text":"\\u0645\\u0631\\u062d\\u0628\\u0627"}}]}');
      assert.equal((await deliver(rt.app, null, { raw })).status, 200);
      for (const sig of [undefined, '', 'sha256=deadbeef', signHmacSha256(raw, 'wrong-secret'), signHmacSha256(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), SECRET)]) {
        const r = await request(rt.app).post('/webhooks/fake').set('Content-Type', 'application/json').set('X-Fake-Signature', sig ?? '')
          .send('{"events":[{"id":"evt-forged"}]}');
        assert.equal(r.status, 401);
        assert.deepEqual(r.body, { ok: false }, 'no details leaked');
      }
      assert.equal(await eventByKey('evt-forged'), undefined);
      const ar = await waitFor(async () => { const e = await eventByKey('evt-ar'); return e.status === 'processed' && e; }, { label: 'arabic event' });
      assert.equal(ar.payload.data.text, 'مرحبا');
    });

    test('duplicate deliveries (sequential and simultaneous) are stored and processed once', async () => {
      rt = await startRuntime();
      const payload = { events: [{ id: 'dup-1' }, { id: 'dup-2' }] };
      for (let i = 0; i < 3; i++) assert.equal((await deliver(rt.app, payload)).status, 200);
      const burst = await Promise.all([...Array(8)].map(() => deliver(rt.app, payload)));
      assert.ok(burst.every(r => r.status === 200), 'duplicates are acknowledged so providers stop retrying');
      await waitFor(async () => (await events()).every(e => e.status === 'processed'), { label: 'all processed' });
      assert.equal((await events()).length, 2);
      await sleep(1200);
      assert.equal(rt.providers.get('fake').processed.length, 2, 'each event processed exactly once');
    });

    test('unknown provider, bad endpoint key, malformed body, oversized body', async () => {
      rt = await startRuntime({ webhooks: { bodyLimit: '1kb' } });
      assert.equal((await request(rt.app).post('/webhooks/telegram').send({})).status, 404, 'provider not enabled');
      assert.equal((await request(rt.app).post('/webhooks/fake/bad%20key').send({})).status, 404);
      const garbage = Buffer.from('not json');
      assert.equal((await deliver(rt.app, null, { raw: garbage })).status, 400);
      const big = Buffer.from(JSON.stringify({ events: [{ id: 'big', pad: 'x'.repeat(5000) }] }));
      assert.equal((await deliver(rt.app, null, { raw: big })).status, 413);
      assert.equal((await events()).length, 0);
    });

    test('verification handshake is delegated to the adapter', async () => {
      const plain = defineAdapter({ id: 'plain', displayName: 'Plain', capabilities: {}, verifyRequest: () => false, parseEvents: () => [], processEvent: async () => ({ status: 'processed' }), sendMessage: async () => ({}) });
      rt = await startRuntime({}, { extraProviders: [plain] });
      const ok = await request(rt.app).get('/webhooks/fake').query({ challenge: 'abc123', verify_token: SECRET });
      assert.equal(ok.status, 200);
      assert.equal(ok.text, 'abc123');
      assert.equal((await request(rt.app).get('/webhooks/fake').query({ challenge: 'abc123', verify_token: 'nope' })).status, 403);
      assert.equal((await request(rt.app).get('/webhooks/plain')).status, 405, 'adapters without a handshake');
    });

    test('transient failures are retried with tracking until success', async () => {
      rt = await startRuntime();
      await deliver(rt.app, { events: [{ id: 'flaky-1', behavior: { failTimes: 2 } }] });
      const e = await waitFor(async () => { const x = await eventByKey('flaky-1'); return x.status === 'processed' && x; }, { timeout: 15000, label: 'retried success' });
      assert.equal(e.attempts, 3);
      assert.equal(e.last_error, null);
    });

    test('permanent failure fails immediately; exhausted retries end as failed and stop retrying', async () => {
      rt = await startRuntime();
      await deliver(rt.app, { events: [{ id: 'perm-1', behavior: { permanent: true } }, { id: 'always-1', behavior: { alwaysFail: true } }, { id: 'ign-1', behavior: { ignore: true } }] });
      const perm = await waitFor(async () => { const x = await eventByKey('perm-1'); return x.status === 'failed' && x; }, { label: 'permanent failed' });
      assert.equal(perm.attempts, 1);
      assert.equal(perm.last_error, 'fake.permanent_failure');
      const always = await waitFor(async () => { const x = await eventByKey('always-1'); return x.status === 'failed' && x; }, { timeout: 15000, label: 'exhausted' });
      assert.equal(always.attempts, 3, 'WEBHOOK_MAX_ATTEMPTS');
      assert.equal((await eventByKey('ign-1')).status, 'ignored');
      await sleep(2000);
      assert.equal((await eventByKey('always-1')).attempts, 3, 'no further attempts after failing');
    });

    test('Super Admin can list failed events (without payloads) and retry them; others cannot', async () => {
      let broken = true;
      const flaky = defineAdapter({
        id: 'flaky', displayName: 'Flaky', capabilities: {},
        verifyRequest: () => true,
        parseEvents: ({ rawBody }) => JSON.parse(rawBody.toString()).events.map(e => ({ eventKey: e.id, type: 'm', payload: e })),
        processEvent: async () => { if (broken) throw new ProviderError('flaky.down'); return { status: 'processed' }; },
        sendMessage: async () => ({})
      });
      rt = await startRuntime({}, { extraProviders: [flaky] });
      await request(rt.app).post('/webhooks/flaky').set('Content-Type', 'application/json').send('{"events":[{"id":"f-1","secretish":"customer data"}]}');
      const failed = await waitFor(async () => { const x = await eventByKey('f-1'); return x.status === 'failed' && x; }, { timeout: 15000, label: 'failed' });
      await h.createPlatformAdmin('root@platform.test');
      const admin = await h.platformLogin(rt.app, 'root@platform.test');
      const list = await admin.agent.get('/api/platform/webhook-events?status=failed');
      assert.equal(list.status, 200);
      assert.equal(list.body.counts.failed, 1);
      assert.equal(list.body.events[0].lastError, 'flaky.down');
      assert.ok(!JSON.stringify(list.body).includes('customer data'), 'payloads are not exposed');
      // Company owners cannot reach it.
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const owner = await h.login(rt.app, 'a@alpha.test');
      assert.equal((await owner.agent.get('/api/platform/webhook-events')).status, 403);
      broken = false;
      const retry = await admin.agent.post(`/api/platform/webhook-events/${failed.id}/retry`).set('X-CSRF-Token', admin.csrf);
      assert.equal(retry.status, 200);
      await waitFor(async () => (await eventByKey('f-1')).status === 'processed', { label: 'retried' });
      assert.equal((await admin.agent.post(`/api/platform/webhook-events/${failed.id}/retry`).set('X-CSRF-Token', admin.csrf)).body.code, 'webhooks.not_failed');
    });

    test('processing is idempotent under concurrent workers', async () => {
      rt = await startRuntime({ jobsEnabled: false });
      await deliver(rt.app, { events: [{ id: 'conc-1', behavior: { delayMs: 300 } }] });
      const e = await eventByKey('conc-1');
      const results = await Promise.all([...Array(5)].map(() => rt.processor.process(e.id)));
      assert.equal(results.filter(r => r.status === 'processed').length, 1);
      assert.equal(rt.providers.get('fake').processed.length, 1);
      assert.deepEqual((await rt.processor.process(e.id)), { skipped: 'processed' });
    });

    test('a lost queue message is recovered by the sweeper', async () => {
      let failSend = true;
      rt = await startRuntime();
      const realSend = rt.jobs.send.bind(rt.jobs);
      rt.jobs.send = async (...args) => { if (failSend) throw new Error('queue unavailable'); return realSend(...args); };
      const res = await deliver(rt.app, { events: [{ id: 'lost-1' }] });
      assert.equal(res.status, 200, 'still acknowledged: the event is durably stored');
      assert.equal((await eventByKey('lost-1')).status, 'received');
      failSend = false;
      await h.getDb().withContext({ system: true }, trx => trx('webhook_events').where({ event_key: 'lost-1' }).update({ received_at: trx.raw("now() - interval '5 minutes'") }));
      assert.equal(await rt.processor.sweep(rt.jobs), 1);
      await waitFor(async () => (await eventByKey('lost-1')).status === 'processed', { label: 'swept' });
    });

    test('retention clean-up removes old finished events but keeps failed ones', async () => {
      rt = await startRuntime({ jobsEnabled: false });
      await h.getDb().withContext({ system: true }, trx => trx('webhook_events').insert([
        { provider: 'fake', event_key: 'old-ok', payload: '{}', status: 'processed', received_at: trx.raw("now() - interval '40 days'") },
        { provider: 'fake', event_key: 'old-bad', payload: '{}', status: 'failed', received_at: trx.raw("now() - interval '40 days'") },
        { provider: 'fake', event_key: 'new-ok', payload: '{}', status: 'processed' }
      ]));
      assert.equal(await rt.processor.cleanup(), 1);
      assert.deepEqual((await events()).map(e => e.event_key).sort(), ['new-ok', 'old-bad']);
    });

    test('tenants can never read raw webhook events (RLS)', async () => {
      rt = await startRuntime({ jobsEnabled: false });
      await deliver(rt.app, { events: [{ id: 'rls-1' }] });
      const c = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const db = h.getDb();
      const count = ctx => db.withContext(ctx, trx => trx('webhook_events').count('* as n').first()).then(r => Number(r.n));
      assert.equal(await count({}), 0, 'no context');
      assert.equal(await count({ companyId: c.companyId, userId: c.ownerUserId }), 0, 'company context');
      assert.equal(await count({ system: true }), 1);
      assert.equal(await count({ platformAdmin: true }), 1);
      await assert.rejects(db.withContext({ companyId: c.companyId }, trx => trx('webhook_events').insert({ provider: 'fake', event_key: 'x', payload: '{}' })), /row-level security/);
    });
  });

  // ------------------------------------------------------------------ jobs
  describe('jobs', () => {
    test('schedules are registered once, however many instances start', async () => {
      await startRuntime();
      await startRuntime();
      const rows = await h.getDb().knex.raw('SELECT name, count(*)::int AS n FROM pgboss.schedule GROUP BY name ORDER BY name');
      assert.deepEqual(rows.rows, [{ name: 'channel.maintenance', n: 1 }, { name: 'message.sweep', n: 1 }, { name: 'subscription.maintenance', n: 1 }, { name: 'webhook.cleanup', n: 1 }, { name: 'webhook.sweep', n: 1 }]);
    });

    test('web role enqueues but does not process; worker role processes without HTTP', async () => {
      const web = await startRuntime({ processRole: 'web' });
      await deliver(web.app, { events: [{ id: 'role-1' }] });
      await sleep(1500);
      assert.equal((await eventByKey('role-1')).status, 'received', 'web role runs no workers');
      const worker = createRuntime(h.runtimeConfig({ processRole: 'worker' }), { db: h.getDb() });
      runtimes.push(worker);
      const started = await worker.start();
      assert.equal(started.port, undefined, 'worker has no HTTP listener');
      assert.equal(worker.realtime, null);
      await waitFor(async () => (await eventByKey('role-1')).status === 'processed', { label: 'worker processed' });
    });

    test('readiness reflects database, jobs and shutdown state', async () => {
      rt = await startRuntime();
      const ready = await request(rt.app).get('/api/ready');
      assert.equal(ready.status, 200);
      assert.deepEqual(ready.body, { ok: true, checks: { database: true, jobs: true, accepting: true } });
      rt.app.locals.runtimeState = 'stopping';
      assert.equal((await request(rt.app).get('/api/ready')).status, 503);
      rt.app.locals.runtimeState = 'running';
    });
  });

  // ------------------------------------------------------------------ realtime
  describe('Socket.IO real-time', () => {
    const connect = (url, { cookie, origin = 'http://localhost', auth, query } = {}) => {
      const socket = ioClient(url, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 4000,
        extraHeaders: { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) }, auth, query });
      // Listen immediately: "ready" can arrive before the test awaits it.
      socket.outcome = new Promise(resolve => {
        socket.once('ready', info => resolve({ ok: true, info }));
        socket.once('connect_error', err => resolve({ ok: false, code: err.data?.code || err.message }));
      });
      sockets.push(socket);
      return socket;
    };
    const outcome = socket => socket.outcome;
    const received = (socket, event, ms = 700) => new Promise(resolve => {
      const t = setTimeout(() => resolve(null), ms);
      socket.once(event, payload => { clearTimeout(t); resolve(payload ?? true); });
    });

    test('authentication: no cookie, bad cookie, bad origin are refused; valid session connects', async () => {
      rt = await startRuntime();
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      assert.deepEqual(await outcome(connect(rt.url)), { ok: false, code: 'auth.required' });
      assert.deepEqual(await outcome(connect(rt.url, { cookie: 'sscrm_session=forged-token-value' })), { ok: false, code: 'auth.required' });
      const cookie = await h.sessionCookie(rt.app, 'a@alpha.test');
      const badOrigin = await outcome(connect(rt.url, { cookie, origin: 'https://evil.example' }));
      assert.equal(badOrigin.ok, false, 'cross-site origin refused');
      const noOrigin = await outcome(connect(rt.url, { cookie, origin: null }));
      assert.equal(noOrigin.ok, false, 'missing origin refused');
      const ok = await outcome(connect(rt.url, { cookie }));
      assert.equal(ok.ok, true);
    });

    test('HTTP long-polling (used behind proxies): same-origin without Origin passes; cross-site and unproven are refused', async () => {
      rt = await startRuntime();
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const cookie = await h.sessionCookie(rt.app, 'a@alpha.test');
      const poll = headers => {
        const socket = ioClient(rt.url, { transports: ['polling'], reconnection: false, forceNew: true, timeout: 4000, extraHeaders: { Cookie: cookie, ...headers } });
        sockets.push(socket);
        return new Promise(resolve => {
          socket.once('ready', info => resolve({ ok: true, info }));
          socket.once('connect_error', err => resolve({ ok: false, code: err.data?.code || err.message }));
        });
      };
      assert.equal((await poll({ 'Sec-Fetch-Site': 'same-origin' })).ok, true, 'browser same-origin polling (no Origin header)');
      assert.equal((await poll({ Origin: 'http://localhost' })).ok, true, 'allow-listed Origin');
      assert.equal((await poll({ 'Sec-Fetch-Site': 'cross-site' })).ok, false, 'cross-site request refused');
      assert.equal((await poll({ 'Sec-Fetch-Site': 'same-site' })).ok, false, 'sibling subdomain refused');
      assert.equal((await poll({})).ok, false, 'no Origin and no browser proof refused');
      assert.equal((await poll({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' })).ok, false, 'a present Origin always wins');
    });

    test('pending / suspended companies and expired sessions cannot connect', async () => {
      rt = await startRuntime();
      await h.createCompanyFixture('Pending', 'p@pending.test', { status: 'pending' });
      const pending = await h.sessionCookie(rt.app, 'p@pending.test');
      assert.deepEqual(await outcome(connect(rt.url, { cookie: pending })), { ok: false, code: 'company.no_access' });
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const cookie = await h.sessionCookie(rt.app, 'a@alpha.test');
      await h.getDb().knex('sessions').update({ expires_at: new Date(Date.now() - 1000) });
      assert.deepEqual(await outcome(connect(rt.url, { cookie })), { ok: false, code: 'auth.required' });
    });

    test('company isolation and permission-gated events; client-supplied company ids are ignored', async () => {
      rt = await startRuntime();
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      await h.addMember(a.companyId, 'employee', 'e@alpha.test');
      const sa = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'a@alpha.test'), auth: { companyId: b.companyId }, query: { companyId: b.companyId } });
      const sb = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'b@beta.test') });
      const se = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'e@alpha.test') });
      const [ra, , ] = await Promise.all([outcome(sa), outcome(sb), outcome(se)]);
      assert.equal(ra.info.companyId, a.companyId, 'room scope comes from the session, not the client');

      const gotA = received(sa, 'audit:new'), gotB = received(sb, 'audit:new'), gotE = received(se, 'audit:new');
      rt.realtime.emitToCompany(a.companyId, 'audit:new', { id: 'x' }, { permission: 'audit.view' });
      assert.deepEqual(await gotA, { id: 'x' }, 'owner of company A receives');
      assert.equal(await gotB, null, 'company B never receives company A events');
      assert.equal(await gotE, null, 'employee without audit.view does not receive');

      const replyE = received(se, 'conv:new');
      rt.realtime.emitToCompany(a.companyId, 'conv:new', { id: 'y' }, { permission: 'conversations.reply' });
      assert.deepEqual(await replyE, { id: 'y' }, 'employee with the permission receives');
      assert.throws(() => rt.realtime.emitToCompany(a.companyId, 'x', {}), /permission/, 'emitting without a permission is not allowed');
    });

    test('unauthorised room subscriptions are refused; authorised ones are scoped to the session company', async () => {
      rt = await startRuntime();
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      const resourceId = '0f8fad5b-d9cb-469f-a165-70867728950e';
      const sa = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'a@alpha.test') });
      const sb = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'b@beta.test') });
      await Promise.all([outcome(sa), outcome(sb)]);
      const sub = (s, req) => new Promise(resolve => s.emit('subscribe', req, resolve));
      for (const req of [{ room: 'conversation', id: resourceId }, { room: 'company', id: b.companyId }, { room: 'platform', id: resourceId }, { room: '../x', id: 'y' }, null]) {
        assert.deepEqual(await sub(sa, req), { ok: false, code: 'realtime.forbidden' }, JSON.stringify(req));
      }
      // Phase 3.2 will register real authorisers; simulate one that only allows company A.
      rt.realtime.registerRoom('conversation', async (data, id) => data.companyId === a.companyId && id === resourceId);
      assert.deepEqual(await sub(sa, { room: 'conversation', id: resourceId }), { ok: true });
      assert.deepEqual(await sub(sb, { room: 'conversation', id: resourceId }), { ok: false, code: 'realtime.forbidden' });
      const gotA = received(sa, 'message:new'), gotB = received(sb, 'message:new');
      rt.realtime.emitToResource(a.companyId, 'conversation', resourceId, 'message:new', { id: 'm1' });
      rt.realtime.emitToResource(b.companyId, 'conversation', resourceId, 'message:new', { id: 'm2' });
      assert.deepEqual(await gotA, { id: 'm1' });
      assert.equal(await gotB, null);
    });

    test('Super Admin console sessions get only the platform room', async () => {
      rt = await startRuntime();
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      await h.createPlatformAdmin('root@platform.test');
      const sp = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'root@platform.test', h.PASSWORD, '/api/auth/platform-login') });
      const r = await outcome(sp);
      assert.equal(r.info.kind, 'platform');
      const plat = received(sp, 'platform:ping'); rt.realtime.emitToPlatform('platform:ping', { n: 1 });
      assert.deepEqual(await plat, { n: 1 });
      const comp = received(sp, 'audit:new'); rt.realtime.emitToCompany(a.companyId, 'audit:new', {}, { permission: 'audit.view' });
      assert.equal(await comp, null);
      assert.deepEqual(await new Promise(res => sp.emit('subscribe', { room: 'conversation', id: '0f8fad5b-d9cb-469f-a165-70867728950e' }, res)), { ok: false, code: 'realtime.forbidden' });
    });

    test('logout and suspension disconnect immediately; re-validation follows permission and session changes', async () => {
      rt = await startRuntime();
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const owner = await h.login(rt.app, 'a@alpha.test');
      const ownerCookie = owner.agent.jar.getCookies({ path: '/', domain: '127.0.0.1', secure: false, script: false }).map(c => `${c.name}=${c.value}`).join('; ')
        || await h.sessionCookie(rt.app, 'a@alpha.test');
      const s1 = connect(rt.url, { cookie: ownerCookie });
      await outcome(s1);
      const gone = new Promise(res => s1.once('disconnect', res));
      await owner.agent.post('/api/auth/logout').set('X-CSRF-Token', owner.csrf);
      await Promise.race([gone, sleep(3000).then(() => { throw new Error('not disconnected on logout'); })]);

      // Permission change → rooms refreshed at re-validation.
      const { membershipId } = await h.addMember(a.companyId, 'admin', 'adm@alpha.test');
      const sAdmin = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'adm@alpha.test') });
      await outcome(sAdmin);
      const before = received(sAdmin, 'audit:new'); rt.realtime.emitToCompany(a.companyId, 'audit:new', {}, { permission: 'audit.view' });
      assert.ok(await before);
      const changed = received(sAdmin, 'session:changed', 3000);
      await h.getDb().withContext({ companyId: a.companyId }, async trx => {
        const emp = await trx('roles').where({ company_id: a.companyId, key: 'employee' }).first();
        await trx('company_memberships').where({ id: membershipId }).update({ role_id: emp.id });
      });
      await rt.realtime.revalidate();
      assert.ok(await changed, 'client told to refresh');
      const after = received(sAdmin, 'audit:new'); rt.realtime.emitToCompany(a.companyId, 'audit:new', {}, { permission: 'audit.view' });
      assert.equal(await after, null, 'lost permission → no longer receives');

      // Session deleted out-of-band → disconnected at re-validation.
      const dropped = new Promise(res => sAdmin.once('disconnect', res));
      await h.getDb().knex('sessions').del();
      await rt.realtime.revalidate();
      await Promise.race([dropped, sleep(3000).then(() => { throw new Error('not disconnected'); })]);

      // Suspension disconnects the whole company at once.
      const s3 = connect(rt.url, { cookie: await h.sessionCookie(rt.app, 'a@alpha.test') });
      await outcome(s3);
      await h.createPlatformAdmin('root@platform.test');
      const admin = await h.platformLogin(rt.app, 'root@platform.test');
      const off = new Promise(res => s3.once('disconnect', res));
      await admin.agent.post(`/api/platform/companies/${a.companyId}/suspend`).set('X-CSRF-Token', admin.csrf).send({ reason: 'test' });
      await Promise.race([off, sleep(3000).then(() => { throw new Error('not disconnected on suspension'); })]);
    });

    test('multi-instance: events reach sockets on other instances via the PostgreSQL adapter', async () => {
      const r1 = await startRuntime({ realtime: { adapter: 'postgres' } });
      const r2 = await startRuntime({ realtime: { adapter: 'postgres' } });
      const a = await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const b = await h.createCompanyFixture('Beta', 'b@beta.test');
      const sa = connect(r1.url, { cookie: await h.sessionCookie(r1.app, 'a@alpha.test') });
      const sb = connect(r1.url, { cookie: await h.sessionCookie(r1.app, 'b@beta.test') });
      await Promise.all([outcome(sa), outcome(sb)]);
      await sleep(300);
      const gotA = received(sa, 'cross', 3000), gotB = received(sb, 'cross', 1500);
      r2.realtime.emitToCompany(a.companyId, 'cross', { from: 'instance-2' }, { permission: 'audit.view' });
      assert.deepEqual(await gotA, { from: 'instance-2' });
      assert.equal(await gotB, null, 'isolation holds across instances');
      const gone = new Promise(res => sa.once('disconnect', res));
      r2.realtime.disconnectCompany(a.companyId);
      await Promise.race([gone, sleep(3000).then(() => { throw new Error('cross-instance disconnect failed'); })]);
    });
  });

  // ------------------------------------------------------------------ shutdown
  describe('graceful shutdown', () => {
    test('stops accepting work, finishes the active job, closes sockets, then resolves (idempotent)', async () => {
      rt = await startRuntime();
      await h.createCompanyFixture('Alpha', 'a@alpha.test');
      const socket = ioClient(rt.url, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { Origin: 'http://localhost', Cookie: await h.sessionCookie(rt.app, 'a@alpha.test') } });
      sockets.push(socket);
      await new Promise(res => socket.once('ready', res));
      const socketClosed = new Promise(res => socket.once('disconnect', res));

      await deliver(rt.app, { events: [{ id: 'slow-1', behavior: { delayMs: 1500 } }] });
      await waitFor(async () => (await eventByKey('slow-1')).status === 'processing', { label: 'job started' });
      const t0 = Date.now();
      const stopping = rt.stop();
      assert.equal(rt.stop(), stopping, 'stop() is idempotent');
      assert.equal(rt.app.locals.runtimeState, 'stopping');
      await stopping;
      assert.ok(Date.now() - t0 >= 500, 'waited for the active job');
      assert.equal((await eventByKey('slow-1')).status, 'processed', 'in-flight job completed during shutdown');
      await socketClosed;
      assert.equal(rt.state(), 'stopped');
      await assert.rejects(fetch(`${rt.url}/api/health`), 'HTTP no longer accepted');
    });
  });

  // ------------------------------------------------------------------ encryption with the database
  describe('key rotation over stored values', () => {
    test('reencryptColumn rotates rows to the primary key with their own context', async () => {
      const crypto = require('crypto');
      const K1 = crypto.randomBytes(32).toString('base64'), K2 = crypto.randomBytes(32).toString('base64');
      const oldRing = createKeyRing({ keys: { k1: K1 }, primaryKeyId: 'k1' });
      const newRing = createKeyRing({ keys: { k1: K1, k2: K2 }, primaryKeyId: 'k2' });
      await h.getOwner().raw('DROP TABLE IF EXISTS tmp_secrets; CREATE TABLE tmp_secrets (id int primary key, company_id text, channel_id text, secret text); GRANT ALL ON tmp_secrets TO sscrm_app');
      const ctx = r => ({ purpose: 'test', companyId: r.company_id, channelId: r.channel_id });
      const rows = [1, 2, 3].map(i => ({ id: i, company_id: `c${i}`, channel_id: `ch${i}` }));
      await h.getDb().knex('tmp_secrets').insert(rows.map(r => ({ ...r, secret: oldRing.encrypt(`token-${r.id}`, ctx(r)) })));
      const res = await h.getDb().knex.transaction(trx => reencryptColumn(trx, newRing, { table: 'tmp_secrets', column: 'secret', contextFor: ctx, batchSize: 2 }));
      assert.deepEqual(res, { scanned: 3, rotated: 3 });
      const after = await h.getDb().knex('tmp_secrets').orderBy('id');
      for (const r of after) {
        assert.equal(newRing.keyIdOf(r.secret), 'k2');
        assert.equal(createKeyRing({ keys: { k2: K2 }, primaryKeyId: 'k2' }).decrypt(r.secret, ctx(r)), `token-${r.id}`);
      }
      const again = await h.getDb().knex.transaction(trx => reencryptColumn(trx, newRing, { table: 'tmp_secrets', column: 'secret', contextFor: ctx }));
      assert.deepEqual(again, { scanned: 3, rotated: 0 }, 'idempotent');
      await h.getOwner().raw('DROP TABLE tmp_secrets');
    });
  });

  test('migration grants: the app role may create objects only inside the pgboss schema', async () => {
    const r = await h.getDb().knex.raw(`SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS db,
      has_schema_privilege('public', 'CREATE') AS pub, has_schema_privilege('pgboss', 'CREATE') AS boss,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    assert.deepEqual(r.rows[0], { db: false, pub: false, boss: true, bypass: false });
  });
});
