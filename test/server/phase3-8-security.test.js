const { test, describe, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const h = require('./helpers');
const { createRuntime } = require('../../server/runtime');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';

describe('Phase 3.8 security regression checks', { skip }, () => {
  const runtimes = [];
  before(async () => { await h.setupDatabase(); });
  beforeEach(() => h.resetDatabase());
  afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop().catch(() => {}); });
  after(() => h.teardown());
  async function start() {
    const r = createRuntime(h.runtimeConfig({ webhookSecretKey: 'security-test-key-0123456789abcdefghij', publicUrl: 'https://crm.example.test' }), { db: h.getDb(), apiRateLimit: 100000, port: 0 });
    runtimes.push(r);
    await r.start();
    return r;
  }

  test('security headers on pages and APIs', async () => {
    const rt = await start();
    for (const path of ['/api/health', '/api/public/branding']) {
      const res = await request(rt.app).get(path);
      assert.equal(res.headers['x-powered-by'], undefined);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.match(res.headers['content-security-policy'], /default-src 'self'/);
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.match(res.headers['strict-transport-security'] || '', /max-age=\d+/);
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal((await request(rt.app).get('/api/health')).headers['cache-control'], 'no-store');
  });

  test('every new write endpoint requires authentication and a CSRF token', async () => {
    const rt = await start();
    await h.createCompanyFixture('Acme', 'owner@acme.test');
    const s = await h.login(rt.app, 'owner@acme.test');
    const id = crypto.randomUUID();
    const writes = [
      ['post', '/api/channels/fake/connect'], ['post', `/api/channels/${id}/test`], ['delete', `/api/channels/${id}`], ['patch', `/api/channels/${id}`],
      ['post', `/api/channels/oauth/sessions/${id}/connect`], ['post', '/api/channels/whatsapp/embedded-signup'],
      ['post', `/api/conversations/${id}/messages`], ['post', `/api/conversations/${id}/read`], ['post', `/api/conversations/${id}/assign`],
      ['patch', `/api/conversations/${id}`], ['post', `/api/conversations/${id}/messages/${id}/retry`],
      ['patch', `/api/platform/channels/outbound/${id}`]
    ];
    for (const [m, u] of writes) {
      assert.equal((await request(rt.app)[m](u).send({})).status, 401, `${m} ${u} without session`);
      const r = await s.agent[m](u).send({});
      assert.equal(r.status, 403, `${m} ${u} without CSRF → ${r.status}`);
    }
    for (const u of ['/api/conversations', '/api/channels', `/api/conversations/${id}/attachments/${id}`, '/api/platform/channels']) {
      assert.equal((await request(rt.app).get(u)).status, 401, `GET ${u} without session`);
    }
  });

  test('signed media links expire and cannot be forged', async () => {
    const rt = await start();
    const m = rt.messaging;
    const key = `companies/${crypto.randomUUID()}/media/2026-11/${crypto.randomUUID()}.png`;
    const expired = new URL(m.signedMediaUrl({ key, contentType: 'image/png' }, -10));
    assert.equal((await request(rt.app).get(expired.pathname)).status, 404);
    const valid = new URL(m.signedMediaUrl({ key, contentType: 'image/png' }, 60));
    const [payload] = valid.pathname.split('/').pop().split('.');
    const other = Buffer.from(JSON.stringify({ k: key.replace('.png', '.jpg'), e: Math.floor(Date.now() / 1000) + 60, t: 'image/png' })).toString('base64url');
    assert.equal((await request(rt.app).get(`/media/${other}.${valid.pathname.split('.').pop()}`)).status, 404, 'signature bound to payload');
    assert.ok(payload);
    assert.equal((await request(rt.app).get('/media/not-a-token')).status, 404);
  });
});
