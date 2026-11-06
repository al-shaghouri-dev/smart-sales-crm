const { test, describe, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const h = require('./helpers');
const { createRuntime } = require('../../server/runtime');
const { defineAdapter, ProviderError } = require('../../server/channels/adapter');
const { signHmacSha256 } = require('../../server/webhooks/signatures');
const { createKeyRing, reencryptColumn } = require('../../server/security/secrets');
const { createLocalDriver, createS3Driver, detect } = require('../../server/media/storage');
const { classifySendError } = require('../../server/messaging');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';
const SECRET = 'fake-test-secret';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);

async function waitFor(fn, { timeout = 10000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('Phase 3.2 messaging core', { skip }, () => {
  const runtimes = [];
  const sockets = [];
  before(async () => { await h.setupDatabase(); });
  beforeEach(() => h.resetDatabase());
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const r of runtimes.splice(0)) await r.stop().catch(() => {});
  });
  after(() => h.teardown());

  const db = () => h.getDb();
  async function startRuntime(overrides = {}, options = {}) {
    const r = createRuntime(h.runtimeConfig(overrides), { db: db(), apiRateLimit: 100000, port: 0, ...options });
    runtimes.push(r);
    const { port } = await r.start();
    r.url = `http://localhost:${port}`;
    return r;
  }
  const deliver = (app, events) => {
    const body = Buffer.from(JSON.stringify({ events }));
    return request(app).post('/webhooks/fake').set('Content-Type', 'application/json').set('X-Fake-Signature', signHmacSha256(body, SECRET)).send(body.toString('utf8'));
  };
  const inbound = (account, from, text, extra = {}) => ({ id: extra.id || `evt-${crypto.randomUUID()}`, type: 'message', account, data: { from, name: extra.name || `User ${from}`, messageId: extra.messageId || `m-${crypto.randomUUID()}`, text, ...extra.data } });
  async function session(app, email) {
    const s = await h.login(app, email);
    return { ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  let adminCreated = false;
  beforeEach(() => { adminCreated = false; });
  async function admin(app) {
    if (!adminCreated) { await h.createPlatformAdmin('root@platform.test'); adminCreated = true; }
    const s = await h.platformLogin(app, 'root@platform.test');
    return { ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  async function setPlan(app, companyId, body) {
    const a = await admin(app);
    const r = await a.call('post', '/api/platform/plans', { name: { en: 'P' }, interval: 'month', price: 10, isActive: true, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const s = await a.call('put', `/api/platform/companies/${companyId}/subscription`, { planId: r.body.plan.id });
    assert.ok([200, 201].includes(s.status), JSON.stringify(s.body));
    return r.body.plan;
  }
  const tenantRows = (companyId, table, where = {}) => db().withContext({ companyId }, trx => trx(table).where(where));
  const allRows = (table, where = {}) => db().withContext({ platformAdmin: true }, trx => trx(table).where(where));

  /** Company with an owner session and one connected fake channel. */
  async function setup(app, name = 'Acme', account = `acc-${name.toLowerCase()}`) {
    const c = await h.createCompanyFixture(name, `owner@${name.toLowerCase()}.test`);
    const owner = await session(app, `owner@${name.toLowerCase()}.test`);
    const res = await owner.call('post', '/api/channels/fake/connect', { accountId: account, displayName: `${name} channel` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { ...c, owner, channel: res.body.channel, account };
  }
  async function firstConversation(companyId) {
    return waitFor(async () => (await tenantRows(companyId, 'conversations'))[0], { label: 'conversation' });
  }

  // ------------------------------------------------------------------ channels
  describe('channels', () => {
    test('connect stores credentials encrypted and never returns them; disconnect deletes them', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      assert.equal(JSON.stringify(a.channel).includes('fake-token'), false);
      const [cred] = await tenantRows(a.companyId, 'channel_credentials');
      assert.ok(cred.ciphertext.startsWith('v2:t1:'));
      assert.equal(cred.ciphertext.includes('fake-token'), false);
      assert.equal(cred.key_id, 't1');
      const list = await a.owner.agent.get('/api/channels');
      assert.equal(JSON.stringify(list.body).includes('ciphertext'), false);
      assert.equal((await a.owner.call('post', `/api/channels/${a.channel.id}/test`)).body.ok, true);
      const del = await a.owner.call('delete', `/api/channels/${a.channel.id}`);
      assert.equal(del.status, 200);
      assert.equal((await tenantRows(a.companyId, 'channel_credentials')).length, 0);
      const audits = await tenantRows(a.companyId, 'audit_logs');
      assert.deepEqual(audits.map(x => x.action).filter(x => x.startsWith('channel.')).sort(), ['channel.connected', 'channel.disconnected']);
      assert.equal(JSON.stringify(audits).includes('fake-token'), false);
    });

    test('plan channel limit holds under 6 simultaneous connects (limit 2)', async () => {
      const rt = await startRuntime();
      const c = await h.createCompanyFixture('Acme', 'owner@acme.test');
      await setPlan(rt.app, c.companyId, { maxChannels: 2 });
      const owner = await session(rt.app, 'owner@acme.test');
      const results = await Promise.all([...Array(6)].map((_, i) => owner.call('post', '/api/channels/fake/connect', { accountId: `acc-${i}`, displayName: `C${i}` })));
      assert.equal(results.filter(r => r.status === 201).length, 2, results.map(r => r.status).join(','));
      assert.ok(results.filter(r => r.status !== 201).every(r => r.body.code === 'channels.plan_limit'));
      assert.equal((await tenantRows(c.companyId, 'channels')).length, 2);
      // Reconnecting an existing account does not use a new slot.
      const again = await owner.call('post', '/api/channels/fake/connect', { accountId: results.find(r => r.status === 201).body.channel.externalAccountId, displayName: 'Renamed' });
      assert.equal(again.status, 200);
      assert.equal(again.body.reconnected, true);
    });

    test('plan provider restriction and cross-company account protection', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app, 'Acme', 'shared-acc');
      const b = await h.createCompanyFixture('Beta', 'owner@beta.test');
      const ob = await session(rt.app, 'owner@beta.test');
      const taken = await ob.call('post', '/api/channels/fake/connect', { accountId: 'shared-acc', displayName: 'Steal' });
      assert.equal(taken.status, 409);
      assert.equal(taken.body.code, 'channels.account_in_use');
      assert.equal(JSON.stringify(taken.body).includes(a.companyId), false);
      const r = await (await admin(rt.app)).call('post', '/api/platform/plans', { name: { en: 'X' }, interval: 'month', price: 1, isActive: true, allowedProviders: ['bogus'] });
      assert.equal(r.status, 400);
      const plan = await setPlan(rt.app, b.companyId, { allowedProviders: ['telegram'] });
      assert.deepEqual(plan.allowedProviders, ['telegram']);
      const denied = await ob.call('post', '/api/channels/fake/connect', { accountId: 'other', displayName: 'X' });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, 'channels.provider_not_allowed');
    });

    test('channel management requires channels.manage', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      await h.addMember(a.companyId, 'employee', 'emp@acme.test');
      const emp = await session(rt.app, 'emp@acme.test');
      assert.equal((await emp.call('post', '/api/channels/fake/connect', { accountId: 'x', displayName: 'x' })).status, 403);
      assert.equal((await emp.call('delete', `/api/channels/${a.channel.id}`)).status, 403);
      const list = await emp.agent.get('/api/channels');
      assert.equal(list.status, 200);
      assert.equal(list.body.channels[0].lastError, undefined, 'inbox users see names only');
    });
  });

  // ------------------------------------------------------------------ inbound
  describe('inbound messages', () => {
    test('a message creates contact, identity and conversation; duplicates are stored once', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      const evt = inbound(a.account, 'u1', 'مرحبا', { messageId: 'm-1', id: 'e-1' });
      assert.equal((await deliver(rt.app, [evt])).status, 200);
      await deliver(rt.app, [evt]); // same event again
      await deliver(rt.app, [{ ...evt, id: 'e-1b' }]); // provider redelivers the same message under a new event id
      const conv = await firstConversation(a.companyId);
      await waitFor(async () => (await allRows('webhook_events')).every(e => e.status === 'processed'), { label: 'processed' });
      assert.equal((await tenantRows(a.companyId, 'messages')).length, 1);
      assert.equal((await tenantRows(a.companyId, 'conversations', { id: conv.id }))[0].unread_count, 1);
      const [contact] = await tenantRows(a.companyId, 'contacts');
      assert.equal(contact.display_name, 'User u1');
      const res = await a.owner.agent.get('/api/conversations');
      assert.equal(res.body.conversations.length, 1);
      assert.equal(res.body.conversations[0].lastMessagePreview, 'مرحبا');
      assert.equal(res.body.counts.unread, 1);
    });

    test('10 simultaneous first messages from one sender: one contact and conversation, 10 messages', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      await Promise.all([...Array(10)].map((_, i) => deliver(rt.app, [inbound(a.account, 'same-user', `msg ${i}`)])));
      await waitFor(async () => (await tenantRows(a.companyId, 'messages')).length === 10, { label: '10 messages' });
      assert.equal((await tenantRows(a.companyId, 'contacts')).length, 1);
      assert.equal((await tenantRows(a.companyId, 'contact_identities')).length, 1);
      const convs = await tenantRows(a.companyId, 'conversations');
      assert.equal(convs.length, 1);
      assert.equal(convs[0].unread_count, 10);
    });

    test('same person on two channels stays two contacts (no automatic merge); unknown accounts are ignored', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      const second = await a.owner.call('post', '/api/channels/fake/connect', { accountId: 'acc-2', displayName: 'Second' });
      await deliver(rt.app, [inbound(a.account, 'u1', 'hi', { name: 'Sara' }), inbound('acc-2', 'u1', 'hi', { name: 'Sara' }), inbound('nobody', 'u1', 'x')]);
      await waitFor(async () => (await tenantRows(a.companyId, 'messages')).length === 2, { label: 'messages' });
      assert.equal(second.status, 201);
      assert.equal((await tenantRows(a.companyId, 'contacts')).length, 2);
      const ignored = await waitFor(async () => (await allRows('webhook_events')).find(e => e.external_account_id === 'nobody' && e.status === 'ignored'), { label: 'ignored' });
      assert.equal(ignored.last_error, 'channel.not_found');
    });

    test('a closed conversation re-opens when the customer writes again; read resets unread', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      await deliver(rt.app, [inbound(a.account, 'u1', 'one')]);
      const conv = await firstConversation(a.companyId);
      assert.equal((await a.owner.call('patch', `/api/conversations/${conv.id}`, { status: 'closed' })).body.conversation.status, 'closed');
      await deliver(rt.app, [inbound(a.account, 'u1', 'two')]);
      await waitFor(async () => (await tenantRows(a.companyId, 'conversations'))[0].status === 'open', { label: 'reopened' });
      assert.equal((await a.owner.call('post', `/api/conversations/${conv.id}/read`)).status, 200);
      assert.equal((await tenantRows(a.companyId, 'conversations'))[0].unread_count, 0);
      const msgs = await a.owner.agent.get(`/api/conversations/${conv.id}/messages`);
      assert.deepEqual(msgs.body.messages.map(m => m.body), ['one', 'two']);
    });
  });

  // ------------------------------------------------------------------ isolation & permissions
  describe('isolation and permissions', () => {
    test('another company cannot see, read, reply to, assign or download anything (404)', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app, 'Acme');
      const b = await setup(rt.app, 'Beta');
      await deliver(rt.app, [inbound(a.account, 'u1', 'secret', { data: { media: { name: 'p.png', base64: PNG.toString('base64') } } })]);
      const conv = await firstConversation(a.companyId);
      const [msg] = await waitFor(async () => { const m = await tenantRows(a.companyId, 'messages'); return m.length && m; }, { label: 'msg' });
      const att = msg.attachments[0];
      assert.equal((await b.owner.agent.get('/api/conversations')).body.conversations.length, 0);
      for (const [m, u, body] of [['get', `/api/conversations/${conv.id}`], ['get', `/api/conversations/${conv.id}/messages`], ['post', `/api/conversations/${conv.id}/messages`, { text: 'x' }],
        ['post', `/api/conversations/${conv.id}/read`], ['post', `/api/conversations/${conv.id}/assign`, { membershipId: null }], ['patch', `/api/conversations/${conv.id}`, { status: 'closed' }],
        ['get', `/api/conversations/${conv.id}/attachments/${att.id}`], ['post', `/api/channels/${a.channel.id}/test`], ['delete', `/api/channels/${a.channel.id}`]]) {
        const r = await b.owner.call(m, u, body);
        assert.equal(r.status, 404, `${m} ${u} → ${r.status}`);
      }
      // Database layer: no context sees no messaging data; B's context sees none of A's rows.
      for (const table of ['channels', 'channel_credentials', 'contacts', 'contact_identities', 'conversations', 'messages']) {
        assert.equal((await db().withContext({}, trx => trx(table))).length, 0, `${table} without context`);
        assert.equal((await tenantRows(b.companyId, table)).filter(r => r.company_id === a.companyId).length, 0, table);
      }
      await assert.rejects(db().withContext({ companyId: b.companyId }, trx => trx('messages').insert({
        company_id: a.companyId, conversation_id: conv.id, channel_id: a.channel.id, direction: 'out', sender_type: 'system', status: 'queued'
      })), /row-level security/);
    });

    test('view_assigned members see only their conversations; assignment is recorded and enforced', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      const emp = await h.addMember(a.companyId, 'employee', 'emp@acme.test');
      await h.addMember(a.companyId, 'supervisor', 'sup@acme.test');
      const e = await session(rt.app, 'emp@acme.test');
      const sup = await session(rt.app, 'sup@acme.test');
      await deliver(rt.app, [inbound(a.account, 'u1', 'hello'), inbound(a.account, 'u2', 'hey')]);
      await waitFor(async () => (await tenantRows(a.companyId, 'conversations')).length === 2, { label: '2 conversations' });
      const [c1] = await tenantRows(a.companyId, 'conversations');
      assert.equal((await e.agent.get('/api/conversations')).body.conversations.length, 0);
      assert.equal((await e.agent.get(`/api/conversations/${c1.id}`)).status, 404);
      assert.equal((await e.call('post', `/api/conversations/${c1.id}/assign`, { membershipId: emp.membershipId })).status, 403);
      const assigned = await sup.call('post', `/api/conversations/${c1.id}/assign`, { membershipId: emp.membershipId, reason: 'shift' });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      assert.equal(assigned.body.conversation.assigneeName, 'emp');
      const mine = await e.agent.get('/api/conversations');
      assert.deepEqual(mine.body.conversations.map(c => c.id), [c1.id]);
      assert.equal((await e.call('post', `/api/conversations/${c1.id}/messages`, { text: 'on it' })).status, 201);
      const history = await sup.agent.get(`/api/conversations/${c1.id}/assignments`);
      assert.equal(history.body.assignments.length, 1);
      assert.equal(history.body.assignments[0].reason, 'shift');
      // Reassign away: the employee loses access immediately.
      await sup.call('post', `/api/conversations/${c1.id}/assign`, { membershipId: null });
      assert.equal((await e.agent.get(`/api/conversations/${c1.id}`)).status, 404);
      // Members without inbox permissions are not assignable; assignment to another company's member fails.
      const outsider = await h.createCompanyFixture('Other', 'owner@other.test');
      const otherMember = await db().withContext({ companyId: outsider.companyId }, trx => trx('company_memberships').first('id'));
      assert.equal((await sup.call('post', `/api/conversations/${c1.id}/assign`, { membershipId: otherMember.id })).body.code, 'conversations.invalid_assignee');
      const audits = await tenantRows(a.companyId, 'audit_logs', { action: 'conversation.assigned' });
      assert.equal(audits.length, 2);
    });

    test('members without any inbox permission are refused', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      await db().withContext({ companyId: a.companyId }, async trx => {
        const role = await trx('roles').where({ company_id: a.companyId, key: 'employee' }).first();
        await trx('role_permissions').where({ role_id: role.id }).whereIn('permission_key', ['conversations.view_assigned']).del();
      });
      await h.addMember(a.companyId, 'employee', 'emp@acme.test');
      const e = await session(rt.app, 'emp@acme.test');
      assert.equal((await e.agent.get('/api/conversations')).status, 403);
    });
  });

  // ------------------------------------------------------------------ sending
  describe('outbound sending', () => {
    async function withConversation(rt, opts) {
      const a = await setup(rt.app, opts?.name);
      await deliver(rt.app, [inbound(a.account, 'u1', 'hi')]);
      const conv = await firstConversation(a.companyId);
      return { ...a, conv };
    }
    const messageById = (companyId, id) => tenantRows(companyId, 'messages', { id }).then(r => r[0]);

    test('reply is queued, sent by the worker, and idempotent on clientMessageId', async () => {
      const rt = await startRuntime();
      const a = await withConversation(rt);
      const r1 = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'Hello!', clientMessageId: 'client-0001' });
      assert.equal(r1.status, 201);
      assert.equal(r1.body.message.status, 'queued');
      const r2 = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'Hello!', clientMessageId: 'client-0001' });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.duplicate, true);
      assert.equal(r2.body.message.id, r1.body.message.id);
      const sent = await waitFor(async () => { const m = await messageById(a.companyId, r1.body.message.id); return m.status === 'sent' && m; }, { label: 'sent' });
      assert.equal(sent.attempts, 1);
      assert.match(sent.external_message_id, /^fake-/);
      const outbox = rt.providers.get('fake').outbox;
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].to, 'u1');
      assert.equal(outbox[0].credentials, '[present]', 'decrypted credentials reach the adapter');
      const jobs = await db().knex.raw("SELECT data FROM pgboss.job WHERE name = 'message.send'");
      assert.deepEqual(Object.keys(jobs.rows[0].data).sort(), ['companyId', 'messageId']);
      // Delivery receipts move forward only.
      await deliver(rt.app, [{ id: 'st-read', type: 'status', account: a.account, data: { messageId: sent.external_message_id, status: 'read' } }]);
      await waitFor(async () => (await messageById(a.companyId, sent.id)).status === 'read', { label: 'read' });
      await deliver(rt.app, [{ id: 'st-del', type: 'status', account: a.account, data: { messageId: sent.external_message_id, status: 'delivered' } }]);
      await waitFor(async () => (await allRows('webhook_events', { event_key: 'st-del' }))[0]?.status === 'processed', { label: 'late receipt' });
      const final = await messageById(a.companyId, sent.id);
      assert.equal(final.status, 'read');
      assert.ok(final.delivered_at && final.read_at);
    });

    test('transient failures retry then succeed; rate limits exhaust attempts; token errors flag the channel', async () => {
      const rt = await startRuntime();
      const a = await withConversation(rt);
      const flaky = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'retry me #fail:flaky2' });
      const limited = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'slow down #fail:rate_limited' });
      const net = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'network #fail:network' });
      const bad = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'bad #fail:permanent' });
      const ok = await waitFor(async () => { const m = await messageById(a.companyId, flaky.body.message.id); return m.status === 'sent' && m; }, { label: 'flaky sent' });
      assert.equal(ok.attempts, 3);
      const failed = await waitFor(async () => { const m = await messageById(a.companyId, limited.body.message.id); return m.status === 'failed' && m; }, { label: 'rate limited failed' });
      assert.equal(failed.attempts, 3);
      assert.equal(failed.error_code, 'provider.rate_limited');
      const netFailed = await waitFor(async () => { const m = await messageById(a.companyId, net.body.message.id); return m.status === 'failed' && m; }, { label: 'network failed' });
      assert.equal(netFailed.error_code, 'provider.network_error');
      const perm = await waitFor(async () => { const m = await messageById(a.companyId, bad.body.message.id); return m.status === 'failed' && m; }, { label: 'permanent failed' });
      assert.equal(perm.attempts, 1, 'permanent errors are not retried');
      // Manual retry of a failed message reuses the same row.
      const retried = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages/${perm.id}/retry`);
      assert.equal(retried.body.message.status, 'queued');
      assert.equal((await a.owner.call('post', `/api/conversations/${a.conv.id}/messages/${ok.id}/retry`)).status, 404, 'sent messages cannot be re-sent');

      const tok = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'x #fail:token_invalid' });
      const tokFailed = await waitFor(async () => { const m = await messageById(a.companyId, tok.body.message.id); return m.status === 'failed' && m; }, { label: 'token failed' });
      assert.equal(tokFailed.attempts, 1);
      const [ch] = await tenantRows(a.companyId, 'channels');
      assert.equal(ch.status, 'needs_reconnect');
      const blocked = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'more' });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'messages.channel_unavailable');
    });

    test('kill switch, daily limit, validation, and permission to reply', async () => {
      const rt = await startRuntime();
      const a = await withConversation(rt);
      assert.equal((await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: '   ' })).body.code, 'messages.empty');
      assert.equal((await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'x'.repeat(4097) })).status, 400);
      await db().withContext({ platformAdmin: true }, trx => trx('companies').where({ id: a.companyId }).update({ outbound_daily_limit: 1 }));
      assert.equal((await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'one' })).status, 201);
      const capped = await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'two' });
      assert.equal(capped.status, 429);
      assert.equal(capped.body.code, 'messages.daily_limit');
      await db().withContext({ platformAdmin: true }, trx => trx('companies').where({ id: a.companyId }).update({ outbound_daily_limit: null, outbound_paused: true }));
      assert.equal((await a.owner.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'x' })).body.code, 'messages.outbound_paused');
      await db().withContext({ platformAdmin: true }, trx => trx('companies').where({ id: a.companyId }).update({ outbound_paused: false }));
      // Company admins cannot lift the kill switch themselves through settings.
      await a.owner.call('patch', '/api/company', { outboundPaused: false, outbound_paused: false });
      // Supervisor with reply; a role without conversations.reply cannot send.
      await db().withContext({ companyId: a.companyId }, async trx => {
        const role = await trx('roles').where({ company_id: a.companyId, key: 'supervisor' }).first();
        await trx('role_permissions').where({ role_id: role.id, permission_key: 'conversations.reply' }).del();
      });
      await h.addMember(a.companyId, 'supervisor', 'sup@acme.test');
      const sup = await session(rt.app, 'sup@acme.test');
      assert.equal((await sup.call('post', `/api/conversations/${a.conv.id}/messages`, { text: 'x' })).status, 403);
      assert.equal((await sup.agent.get(`/api/conversations/${a.conv.id}`)).status, 200);
    });

    test('provider reply window is enforced before queueing', async () => {
      const outbox = [];
      const windowed = defineAdapter({
        id: 'windowed', displayName: 'Windowed', capabilities: { inbound: true, outbound: true, media: false, replyWindowHours: 24 },
        verifyRequest: () => true, parseEvents: () => [], processEvent: async () => ({ status: 'ignored' }),
        async connect() { return { displayName: 'W', externalAccountId: 'w-1', credentials: { t: 'x' } }; },
        async sendMessage(r) { outbox.push(r); return { externalMessageId: `w-${outbox.length}` }; }
      });
      const rt = await startRuntime({}, { extraProviders: [windowed] });
      const c = await h.createCompanyFixture('Acme', 'owner@acme.test');
      const owner = await session(rt.app, 'owner@acme.test');
      const ch = await owner.call('post', '/api/channels/windowed/connect', {});
      assert.equal(ch.status, 201);
      const route = (await db().knex.raw('SELECT * FROM app_channel_lookup(?)', [ch.body.channel.id])).rows[0];
      await rt.messaging.recordInbound(route, { externalUserId: 'x1', body: 'old', externalMessageId: 'o1', type: 'text', timestamp: new Date(Date.now() - 25 * 3600 * 1000) });
      const conv = await firstConversation(c.companyId);
      const detail = await owner.agent.get(`/api/conversations/${conv.id}`);
      assert.equal(detail.body.conversation.replyWindow.open, false);
      const closed = await owner.call('post', `/api/conversations/${conv.id}/messages`, { text: 'late' });
      assert.equal(closed.status, 409);
      assert.equal(closed.body.code, 'messages.window_closed');
      await rt.messaging.recordInbound(route, { externalUserId: 'x1', body: 'new', externalMessageId: 'o2', type: 'text' });
      assert.equal((await owner.call('post', `/api/conversations/${conv.id}/messages`, { text: 'now ok' })).status, 201);
      const unsupported = await owner.agent.post(`/api/conversations/${conv.id}/messages`).set('X-CSRF-Token', owner.csrf).attach('file', PNG, 'a.png');
      assert.equal(unsupported.body.code, 'messages.media_unsupported');
      await waitFor(() => outbox.length === 1, { label: 'windowed sent' });
    });

    test('sweeper fails stuck "sending" rows (never re-sends) and re-queues lost jobs', async () => {
      const rt = await startRuntime({ processRole: 'web' });
      // Web role: no workers run, so the rows below stay exactly as inserted.
      const c = await h.createCompanyFixture('Zeta', 'owner@zeta.test');
      const owner = await session(rt.app, 'owner@zeta.test');
      const ch = (await owner.call('post', '/api/channels/fake/connect', { accountId: 'z', displayName: 'Z' })).body.channel;
      const route = (await db().knex.raw('SELECT * FROM app_channel_lookup(?)', [ch.id])).rows[0];
      await rt.messaging.recordInbound(route, { externalUserId: 'u', body: 'hi', externalMessageId: 'z1', type: 'text' });
      const conv = (await tenantRows(c.companyId, 'conversations'))[0];
      const ins = (status, ageMin) => db().withContext({ companyId: c.companyId }, trx => trx('messages').insert({
        company_id: c.companyId, conversation_id: conv.id, channel_id: ch.id, direction: 'out', sender_type: 'member', body: status, status,
        created_at: trx.raw(`now() - interval '${ageMin} minutes'`), updated_at: trx.raw(`now() - interval '${ageMin} minutes'`)
      }).returning('id')).then(r => r[0].id);
      const stuck = await ins('sending', 11);
      const lost = await ins('queued', 6);
      const fresh = await ins('queued', 1);
      const r = await rt.messaging.sweep();
      assert.deepEqual(r, { requeued: 1, failedUnknown: 1 });
      const rows = await tenantRows(c.companyId, 'messages');
      assert.equal(rows.find(m => m.id === stuck).status, 'failed');
      assert.equal(rows.find(m => m.id === stuck).error_code, 'send.unknown_outcome');
      const jobs = (await db().knex.raw("SELECT data FROM pgboss.job WHERE name = 'message.send'")).rows.map(j => j.data.messageId);
      assert.ok(jobs.includes(lost));
      assert.ok(!jobs.includes(fresh));
    });

    test('error classification', () => {
      assert.deepEqual(classifySendError(new ProviderError('provider.rate_limited')), { code: 'provider.rate_limited', retryable: true, reconnect: false });
      assert.deepEqual(classifySendError(new ProviderError('provider.token_expired')), { code: 'provider.token_expired', retryable: false, reconnect: true });
      assert.deepEqual(classifySendError(new ProviderError('provider.bad_request', { retryable: false })), { code: 'provider.bad_request', retryable: false, reconnect: false });
      assert.deepEqual(classifySendError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), { code: 'provider.network_error', retryable: true, reconnect: false });
      assert.deepEqual(classifySendError(Object.assign(new Error('x'), { name: 'SecretError' })), { code: 'channel.credentials_unreadable', retryable: false, reconnect: true });
    });
  });

  // ------------------------------------------------------------------ attachments & storage
  describe('attachments and storage', () => {
    test('upload, send and authorised download with safe headers; content is checked by bytes', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      await deliver(rt.app, [inbound(a.account, 'u1', 'hi')]);
      const conv = await firstConversation(a.companyId);
      const up = await a.owner.agent.post(`/api/conversations/${conv.id}/messages`).set('X-CSRF-Token', a.owner.csrf).field('text', 'see').attach('file', PNG, '../../evil name.png');
      assert.equal(up.status, 201, JSON.stringify(up.body));
      const att = up.body.message.attachments[0];
      assert.equal(att.kind, 'image');
      assert.equal(att.key, undefined, 'storage keys are never exposed');
      assert.equal(att.name, 'evil name.png');
      await waitFor(() => rt.providers.get('fake').outbox.length === 1, { label: 'media sent' });
      assert.equal(rt.providers.get('fake').outbox[0].attachments[0].size, PNG.length);
      const dl = await a.owner.agent.get(`/api/conversations/${conv.id}/attachments/${att.id}`);
      assert.equal(dl.status, 200);
      assert.equal(dl.headers['content-type'], 'image/png');
      assert.equal(dl.headers['x-content-type-options'], 'nosniff');
      assert.match(dl.headers['content-security-policy'], /sandbox/);
      assert.ok(Buffer.compare(dl.body, PNG) === 0);
      const html = await a.owner.agent.post(`/api/conversations/${conv.id}/messages`).set('X-CSRF-Token', a.owner.csrf).attach('file', Buffer.from('<html><script>alert(1)</script>'), 'x.png');
      assert.equal(html.status, 400);
      assert.equal(html.body.code, 'media.unsupported_type');
      const big = await a.owner.agent.post(`/api/conversations/${conv.id}/messages`).set('X-CSRF-Token', a.owner.csrf).attach('file', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'big.png');
      assert.equal(big.body.code, 'media.too_large');
      // Files live outside the public uploads folder.
      assert.equal((await request(rt.app).get(`/uploads/companies/${a.companyId}/media`)).status, 404);
      // Unauthenticated access is refused.
      assert.equal((await request(rt.app).get(`/api/conversations/${conv.id}/attachments/${att.id}`)).status, 401);
    });

    test('local driver confines keys; content detection', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-media-'));
      const local = createLocalDriver({ dir });
      const cid = crypto.randomUUID();
      const { key } = await local.put({ companyId: cid, buffer: PNG, ext: 'png' });
      assert.match(key, new RegExp(`^companies/${cid}/media/\\d{4}-\\d{2}/[0-9a-f-]{36}\\.png$`));
      assert.ok(Buffer.compare(await local.get(key), PNG) === 0);
      for (const bad of ['../etc/passwd', `companies/${cid}/media/2026-01/../../x.png`, '/abs/path', `companies/${cid}/../x`]) await assert.rejects(local.get(bad), /invalid media key/);
      await assert.rejects(local.put({ companyId: '../x', buffer: PNG, ext: 'png' }));
      await local.remove(key);
      await assert.rejects(local.get(key));
      assert.equal(detect(Buffer.from('%PDF-1.7 ...')).ext, 'pdf');
      assert.equal(detect(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'a.docx').ext, 'docx');
      assert.equal(detect(Buffer.from('MZ executable')), null);
    });

    test('S3-compatible driver signs requests and round-trips objects (mock S3 server)', async () => {
      const store = new Map();
      const seen = [];
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const url = req.url.split('?')[0];
          seen.push({ method: req.method, url, auth: req.headers.authorization || '' });
          if (req.method === 'PUT') { store.set(url, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"x"' }); return res.end(); }
          if (req.method === 'GET' && store.has(url)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(store.get(url)); }
          if (req.method === 'DELETE') { store.delete(url); res.writeHead(204); return res.end(); }
          res.writeHead(404, { 'Content-Type': 'application/xml' }); res.end('<Error><Code>NoSuchKey</Code></Error>');
        });
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      try {
        const s3 = createS3Driver({ bucket: 'media', region: 'us-east-1', endpoint: `http://127.0.0.1:${server.address().port}`, accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret', forcePathStyle: true });
        const cid = crypto.randomUUID();
        const { key } = await s3.put({ companyId: cid, buffer: PNG, ext: 'png', contentType: 'image/png' });
        assert.ok(seen[0].url.startsWith(`/media/companies/${cid}/media/`));
        assert.match(seen[0].auth, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
        assert.ok(Buffer.compare(await s3.get(key), PNG) === 0);
        await s3.remove(key);
        await assert.rejects(s3.get(key));
        await assert.rejects(s3.get('../../other-bucket/x'), /invalid media key/);
      } finally { server.close(); }
    });
  });

  // ------------------------------------------------------------------ realtime
  describe('real-time', () => {
    function connect(rt, cookie) {
      const s = ioClient(rt.url, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie, origin: 'http://localhost' }, reconnection: false, forceNew: true });
      sockets.push(s);
      const ready = new Promise((resolve, reject) => { s.once('ready', resolve); s.once('connect_error', reject); });
      return { s, ready };
    }
    const subscribe = (s, id) => new Promise(r => s.emit('subscribe', { room: 'conversation', id }, r));

    test('conversation rooms are authorised; message events reach only authorised members', async () => {
      const rt = await startRuntime();
      const a = await setup(rt.app);
      const b = await setup(rt.app, 'Beta');
      const emp = await h.addMember(a.companyId, 'employee', 'emp@acme.test');
      await deliver(rt.app, [inbound(a.account, 'u1', 'first')]);
      const conv = await firstConversation(a.companyId);

      const owner = connect(rt, await h.sessionCookie(rt.app, 'owner@acme.test'));
      const employee = connect(rt, await h.sessionCookie(rt.app, 'emp@acme.test'));
      const other = connect(rt, await h.sessionCookie(rt.app, 'owner@beta.test'));
      await Promise.all([owner.ready, employee.ready, other.ready]);
      assert.deepEqual(await subscribe(owner.s, conv.id), { ok: true });
      assert.equal((await subscribe(employee.s, conv.id)).ok, false, 'not assigned');
      assert.equal((await subscribe(other.s, conv.id)).ok, false, 'other company');

      const got = { owner: [], employee: [], other: [], list: [] };
      owner.s.on('message:new', p => got.owner.push(p));
      employee.s.on('message:new', p => got.employee.push(p));
      other.s.on('message:new', p => got.other.push(p));
      other.s.on('conversation:updated', p => got.list.push(p));
      employee.s.on('conversation:updated', p => got.list.push({ ...p, who: 'employee' }));
      await deliver(rt.app, [inbound(a.account, 'u1', 'second')]);
      await waitFor(() => got.owner.length === 1, { label: 'owner event' });
      assert.equal(got.owner[0].message.body, 'second');
      assert.equal(JSON.stringify(got.owner[0]).includes('key'), false);

      // Assignment: the employee gets a list update and may now subscribe.
      await a.owner.call('post', `/api/conversations/${conv.id}/assign`, { membershipId: emp.membershipId });
      await waitFor(() => got.list.some(x => x.who === 'employee'), { label: 'employee notified' });
      assert.deepEqual(await subscribe(employee.s, conv.id), { ok: true });
      await deliver(rt.app, [inbound(a.account, 'u1', 'third')]);
      await waitFor(() => got.employee.length === 1, { label: 'employee message' });
      // Unassign: the employee is removed from the room and stops receiving messages.
      await a.owner.call('post', `/api/conversations/${conv.id}/assign`, { membershipId: null });
      await sleep(200);
      await deliver(rt.app, [inbound(a.account, 'u1', 'fourth')]);
      await waitFor(() => got.owner.length === 3, { label: 'owner fourth' });
      await sleep(300);
      assert.equal(got.employee.length, 1);
      assert.equal(got.other.length, 0);
      assert.equal(got.list.filter(x => !x.who).length, 0, 'other company never notified');
    });
  });

  // ------------------------------------------------------------------ key rotation
  test('channel credentials survive key rotation and stay bound to their channel', async () => {
    const rt = await startRuntime();
    const a = await setup(rt.app);
    const second = (await a.owner.call('post', '/api/channels/fake/connect', { accountId: 'acc-2', displayName: 'Two' })).body.channel;
    const ring2 = createKeyRing({ keys: { t1: h.TEST_KEY, t2: crypto.randomBytes(32).toString('base64') }, primaryKeyId: 't2' });
    const field = { table: 'channel_credentials', column: 'ciphertext', idColumn: 'channel_id', keyIdColumn: 'key_id',
      contextFor: row => ({ purpose: 'channel_credential', companyId: row.company_id, channelId: row.channel_id }) };
    const r1 = await db().withContext({ system: true, platformAdmin: true }, trx => reencryptColumn(trx, ring2, field));
    assert.deepEqual(r1, { scanned: 2, rotated: 2 });
    const r2 = await db().withContext({ system: true, platformAdmin: true }, trx => reencryptColumn(trx, ring2, field));
    assert.deepEqual(r2, { scanned: 2, rotated: 0 }, 'idempotent');
    const rows = await tenantRows(a.companyId, 'channel_credentials');
    assert.ok(rows.every(x => x.key_id === 't2' && x.ciphertext.startsWith('v2:t2:')));
    const one = rows.find(x => x.channel_id === a.channel.id);
    const ctx = id => ({ purpose: 'channel_credential', companyId: a.companyId, channelId: id });
    assert.deepEqual(JSON.parse(ring2.decrypt(one.ciphertext, ctx(a.channel.id))), { accessToken: `fake-token-${a.account}` });
    // A ciphertext copied onto another channel cannot be decrypted (context binding).
    assert.throws(() => ring2.decrypt(one.ciphertext, ctx(second.id)), /authenticated/);
    // The old ring alone can no longer read rotated values.
    assert.throws(() => h.TEST_KEY_RING.decrypt(one.ciphertext, ctx(a.channel.id)));
  });
});
