const { test, describe, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { createRuntime } = require('../../server/runtime');
const { defineAdapter, ProviderError } = require('../../server/channels/adapter');
const { runChannelMaintenance } = require('../../server/services/channel-maintenance');
const { readCredentials } = require('../../server/services/channels');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';

describe('Phase 3.7 channel operations', { skip }, () => {
  const runtimes = [];
  let refreshMode = 'ok';
  const refreshing = defineAdapter({
    id: 'refreshing', displayName: 'Refreshing', capabilities: { inbound: true, outbound: true, media: false },
    verifyRequest: () => true, parseEvents: () => [], processEvent: async () => ({ status: 'ignored' }), sendMessage: async () => ({ externalMessageId: 'x' }),
    async connect({ input }) { return { displayName: input.name, externalAccountId: input.name, credentials: { accessToken: 'old' }, expiresAt: new Date(Date.now() + Number(input.days) * 86400000) }; },
    async refreshCredentials() {
      if (refreshMode === 'revoked') throw new ProviderError('provider.token_invalid', { retryable: false });
      return { credentials: { accessToken: 'new' }, expiresAt: new Date(Date.now() + 60 * 86400000) };
    }
  });
  const noRefresh = defineAdapter({ ...refreshing, id: 'norefresh', displayName: 'NoRefresh', refreshCredentials: undefined });

  before(async () => { await h.setupDatabase(); });
  beforeEach(async () => { await h.resetDatabase(); refreshMode = 'ok'; });
  afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop().catch(() => {}); });
  after(() => h.teardown());

  async function start() {
    const r = createRuntime(h.runtimeConfig(), { db: h.getDb(), apiRateLimit: 100000, port: 0, extraProviders: [refreshing, noRefresh] });
    runtimes.push(r);
    await r.start();
    return r;
  }
  async function session(app, email, platform = false) {
    const s = platform ? await h.platformLogin(app, email) : await h.login(app, email);
    return { ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  const rows = (companyId, table, where = {}) => h.getDb().withContext({ companyId }, trx => trx(table).where(where));

  test('maintenance refreshes expiring tokens, flags expired/revoked ones and notifies channel managers once per day', async () => {
    const rt = await start();
    const c = await h.createCompanyFixture('Acme', 'owner@acme.test');
    await h.addMember(c.companyId, 'employee', 'emp@acme.test');
    const o = await session(rt.app, 'owner@acme.test');
    const soon = (await o.call('post', '/api/channels/refreshing/connect', { name: 'soon', days: 3 })).body.channel;
    const far = (await o.call('post', '/api/channels/refreshing/connect', { name: 'far', days: 40 })).body.channel;
    const expired = (await o.call('post', '/api/channels/norefresh/connect', { name: 'gone', days: 2 })).body.channel;
    await h.getDb().withContext({ companyId: c.companyId }, trx => trx('channel_credentials').where({ channel_id: expired.id }).update({ expires_at: new Date(Date.now() - 1000) }));
    const deps = { db: h.getDb(), config: h.runtimeConfig(), providers: rt.providers, logger: { error() {} } };
    const r1 = await runChannelMaintenance(deps);
    assert.equal(r1.refreshed, 1);
    assert.equal(r1.flagged, 1);
    const creds = await h.getDb().withContext({ companyId: c.companyId }, async trx => readCredentials(trx, h.TEST_KEY_RING, await trx('channels').where({ id: soon.id }).first()));
    assert.equal(creds.accessToken, 'new');
    const chans = await rows(c.companyId, 'channels');
    assert.equal(chans.find(x => x.id === expired.id).status, 'needs_reconnect');
    assert.equal(chans.find(x => x.id === expired.id).last_error, 'provider.token_expired');
    assert.equal(chans.find(x => x.id === far.id).status, 'active');
    const notes = await h.getDb().withContext({ platformAdmin: true }, trx => trx('notifications').where({ company_id: c.companyId }));
    assert.equal(notes.length, 1, 'only the owner (channels.manage) is notified, not the employee');
    assert.equal(notes[0].type, 'channel_needs_attention');
    const r2 = await runChannelMaintenance(deps);
    assert.equal(r2.notified, 0, 'de-duplicated per day');
    // Revoked refresh → flagged.
    refreshMode = 'revoked';
    await h.getDb().withContext({ companyId: c.companyId }, trx => trx('channel_credentials').where({ channel_id: far.id }).update({ expires_at: new Date(Date.now() + 86400000) }));
    await runChannelMaintenance(deps);
    assert.equal((await rows(c.companyId, 'channels', { id: far.id }))[0].status, 'needs_reconnect');
    const list = await o.agent.get('/api/channels');
    assert.equal(list.body.channels.find(x => x.id === far.id).tokenExpiringSoon, true);
  });

  test('Super Admin channel dashboard and per-company kill switch / daily cap', async () => {
    const rt = await start();
    const c = await h.createCompanyFixture('Acme', 'owner@acme.test');
    const o = await session(rt.app, 'owner@acme.test');
    await o.call('post', '/api/channels/fake/connect', { accountId: 'acc', displayName: 'Acme fake' });
    assert.equal((await o.agent.get('/api/platform/channels')).status, 403, 'workspace sessions are refused');
    assert.equal((await o.call('patch', `/api/platform/channels/outbound/${c.companyId}`, { paused: true })).status, 403);
    await h.createPlatformAdmin('root@platform.test');
    const a = await session(rt.app, 'root@platform.test', true);
    const dash = await a.agent.get('/api/platform/channels');
    assert.equal(dash.status, 200);
    assert.equal(dash.body.channels.length, 1);
    assert.equal(dash.body.channels[0].company.name, 'Acme');
    assert.equal(JSON.stringify(dash.body).includes('ciphertext'), false);
    assert.equal(dash.body.summary.active, 1);
    const paused = await a.call('patch', `/api/platform/channels/outbound/${c.companyId}`, { paused: true, dailyLimit: 100 });
    assert.deepEqual({ paused: paused.body.paused, dailyLimit: paused.body.dailyLimit }, { paused: true, dailyLimit: 100 });
    const route = (await h.getDb().knex.raw('SELECT * FROM app_channel_route(?, ?)', ['fake', 'acc'])).rows[0];
    await rt.messaging.recordInbound(route, { externalUserId: 'u', body: 'hi', externalMessageId: 'x1', type: 'text' });
    const conv = (await rows(c.companyId, 'conversations'))[0];
    assert.equal((await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'x' })).body.code, 'messages.outbound_paused');
    await a.call('patch', `/api/platform/channels/outbound/${c.companyId}`, { paused: false });
    assert.equal((await o.call('post', `/api/conversations/${conv.id}/messages`, { text: 'x' })).status, 201);
    const state = await a.agent.get(`/api/platform/channels/outbound/${c.companyId}`);
    assert.equal(state.body.sentToday, 1);
    const audits = await h.getDb().withContext({ platformAdmin: true }, trx => trx('audit_logs').where({ action: 'company.outbound_updated' }));
    assert.equal(audits.length, 2);
    assert.equal((await a.call('patch', `/api/platform/channels/outbound/${crypto.randomUUID()}`, { paused: true })).status, 404);
  });
});
