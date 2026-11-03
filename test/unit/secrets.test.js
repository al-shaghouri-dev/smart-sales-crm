const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createKeyRing, loadKeyRingFromEnv, encryptSecret, decryptSecret } = require('../../server/security/secrets');

const key = () => crypto.randomBytes(32).toString('base64');
const K1 = key(), K2 = key(), LEGACY = key();
const ctx = { purpose: 'channel_credential', companyId: '11111111-1111-4111-8111-111111111111', channelId: '22222222-2222-4222-8222-222222222222' };
const ring1 = createKeyRing({ keys: { k1: K1 }, primaryKeyId: 'k1' });

describe('credential encryption v2 (AES-256-GCM + AAD + key versions)', () => {
  test('round trip; format carries version and key id; random IV', () => {
    const a = ring1.encrypt('EAAG-secret-token', ctx);
    const b = ring1.encrypt('EAAG-secret-token', ctx);
    assert.match(a, /^v2:k1:[^:]+:[^:]+:[^:]+$/);
    assert.notEqual(a, b, 'same plaintext must not produce the same ciphertext');
    assert.equal(ring1.decrypt(a, ctx), 'EAAG-secret-token');
    assert.ok(!a.includes('EAAG'), 'plaintext not visible');
  });

  test('AAD binding: another company, channel or purpose cannot decrypt', () => {
    const value = ring1.encrypt('token-A', ctx);
    for (const other of [
      { ...ctx, companyId: '33333333-3333-4333-8333-333333333333' },
      { ...ctx, channelId: '44444444-4444-4444-8444-444444444444' },
      { ...ctx, purpose: 'webhook_secret' }
    ]) {
      assert.throws(() => ring1.decrypt(value, other), e => e.code === 'secrets.auth_failed');
    }
  });

  test('tampering with ciphertext, tag, iv or key id is detected', () => {
    const value = ring1.encrypt('token-A', ctx);
    const [v, id, iv, tag, data] = value.split(':');
    const flip = s => { const b = Buffer.from(s, 'base64'); b[0] ^= 1; return b.toString('base64'); };
    for (const bad of [
      [v, id, iv, tag, flip(data)].join(':'),
      [v, id, iv, flip(tag), data].join(':'),
      [v, id, flip(iv), tag, data].join(':')
    ]) assert.throws(() => ring1.decrypt(bad, ctx), e => e.code === 'secrets.auth_failed');
    // Re-labelling with another configured key id fails too (key id is also inside the AAD).
    const ring2 = createKeyRing({ keys: { k1: K1, k2: K2 }, primaryKeyId: 'k1' });
    assert.throws(() => ring2.decrypt([v, 'k2', iv, tag, data].join(':'), ctx), e => e.code === 'secrets.auth_failed');
  });

  test('context is mandatory and validated', () => {
    assert.throws(() => ring1.encrypt('x', null), e => e.code === 'secrets.context_required');
    assert.throws(() => ring1.encrypt('x', { purpose: 'p', companyId: '' , channelId: 'c' }), e => e.code === 'secrets.context_invalid');
    assert.throws(() => ring1.encrypt('x', { purpose: 'p|x', companyId: 'a', channelId: 'c' }), e => e.code === 'secrets.context_invalid', 'separator injection refused');
    assert.throws(() => ring1.encrypt('', ctx), e => e.code === 'secrets.empty');
  });

  test('key versions and rotation', () => {
    const old = ring1.encrypt('rotate-me', ctx);
    const rotating = createKeyRing({ keys: { k1: K1, k2: K2 }, primaryKeyId: 'k2' });
    assert.equal(rotating.decrypt(old, ctx), 'rotate-me', 'old key still readable after adding a new primary');
    assert.equal(rotating.needsRotation(old), true);
    const fresh = rotating.rotate(old, ctx);
    assert.equal(rotating.keyIdOf(fresh), 'k2');
    assert.equal(rotating.needsRotation(fresh), false);
    const retired = createKeyRing({ keys: { k2: K2 }, primaryKeyId: 'k2' });
    assert.equal(retired.decrypt(fresh, ctx), 'rotate-me');
    assert.throws(() => retired.decrypt(old, ctx), e => e.code === 'secrets.unknown_key', 'retired key no longer configured');
  });

  test('legacy v1 values: readable only with explicit opt-in, then upgradable to v2', () => {
    const v1 = encryptSecret('legacy-token', LEGACY);
    assert.equal(decryptSecret(v1, LEGACY), 'legacy-token', 'old helper still works');
    const ring = createKeyRing({ keys: { k1: K1 }, primaryKeyId: 'k1', legacyKey: LEGACY });
    assert.throws(() => ring.decrypt(v1, ctx), e => e.code === 'secrets.legacy_not_allowed');
    assert.equal(ring.decrypt(v1, { ...ctx, allowLegacy: true }), 'legacy-token');
    assert.equal(ring.needsRotation(v1), true);
    const upgraded = ring.rotate(v1, { ...ctx, allowLegacy: true });
    assert.match(upgraded, /^v2:k1:/);
    assert.equal(ring.decrypt(upgraded, ctx), 'legacy-token');
    assert.throws(() => createKeyRing({ keys: { k1: K1 }, primaryKeyId: 'k1' }).decrypt(v1, { ...ctx, allowLegacy: true }), e => e.code === 'secrets.no_legacy_key');
  });

  test('configuration errors are explicit and never echo key material', () => {
    assert.throws(() => createKeyRing({ keys: {}, primaryKeyId: 'k1' }), e => e.code === 'secrets.no_keys');
    assert.throws(() => createKeyRing({ keys: { k1: K1 }, primaryKeyId: 'k9' }), e => e.code === 'secrets.no_primary');
    assert.throws(() => createKeyRing({ keys: { 'bad id!': K1 }, primaryKeyId: 'bad id!' }), e => e.code === 'secrets.bad_key_id');
    const short = Buffer.alloc(16).toString('base64');
    assert.throws(() => createKeyRing({ keys: { k1: short }, primaryKeyId: 'k1' }), e => e.code === 'secrets.bad_key' && !e.message.includes(short));
    assert.throws(() => ring1.decrypt('garbage', ctx), e => e.code === 'secrets.bad_format');
    try { ring1.decrypt(ring1.encrypt('top-secret-value', ctx), { ...ctx, purpose: 'x' }); } catch (e) {
      assert.ok(!e.message.includes('top-secret-value') && !e.message.includes(K1));
    }
  });

  test('environment loading: key ring, primary id, Phase 0-2 single key compatibility', () => {
    assert.equal(loadKeyRingFromEnv({}), null);
    const multi = loadKeyRingFromEnv({ APP_ENCRYPTION_KEYS: `a1:${K1}, b2:${K2}`, APP_ENCRYPTION_PRIMARY_KEY_ID: 'b2' });
    assert.deepEqual(multi.keyIds().sort(), ['a1', 'b2']);
    assert.equal(multi.primaryKeyId, 'b2');
    const single = loadKeyRingFromEnv({ APP_ENCRYPTION_KEY: K1 });
    assert.equal(single.primaryKeyId, 'k1');
    assert.equal(single.decrypt(single.encrypt('x', ctx), ctx), 'x');
    assert.equal(single.decrypt(encryptSecret('v1', K1), { ...ctx, allowLegacy: true }), 'v1', 'old single key reads v1 values');
    assert.throws(() => loadKeyRingFromEnv({ APP_ENCRYPTION_KEYS: 'no-colon' }), e => e.code === 'secrets.bad_env');
  });
});
