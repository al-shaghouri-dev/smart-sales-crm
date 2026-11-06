#!/usr/bin/env node
/*
 * Local load test for the webhook → processing → inbox → send pipeline (development only).
 * Requires a running server with CHANNEL_PROVIDERS=fake and the same FAKE_PROVIDER_SECRET,
 * a company owner account and a connected fake channel (account id given with --account).
 *
 *   node scripts/load-test.js --url http://localhost:3000 --secret <FAKE_PROVIDER_SECRET> --account <id> \
 *        --events 2000 --concurrency 50 [--email owner@x --password ... --replies 300]
 *
 * Reports webhook acknowledgement latency (p50/p95/p99), throughput, the time until every event
 * is processed, and (optionally) the time to send replies through the queue. Never run against
 * production: the fake provider is refused there anyway.
 */
const crypto = require('crypto');
const { parseArgs } = require('./cli-utils');

const a = parseArgs(process.argv.slice(2));
const URL_ = a.url || 'http://localhost:3000';
const N = Number(a.events || 1000), C = Number(a.concurrency || 50), R = Number(a.replies || 0);
const pct = (arr, p) => arr.slice().sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

async function pool(n, c, fn) {
  let i = 0; const out = [];
  await Promise.all([...Array(c)].map(async () => { while (i < n) { const k = i++; out[k] = await fn(k); } }));
  return out;
}

(async () => {
  if (!a.secret || !a.account) { console.error('Usage: --secret <FAKE_PROVIDER_SECRET> --account <fake account id>'); process.exit(1); }
  const run = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  const lat = await pool(N, C, async k => {
    const body = JSON.stringify({ events: [{ id: `load-${run}-${k}`, type: 'message', account: a.account, data: { from: `cust-${k % 200}`, name: `Customer ${k % 200}`, messageId: `lm-${run}-${k}`, text: `load message ${k}` } }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', a.secret).update(body).digest('hex');
    const s = Date.now();
    const r = await fetch(`${URL_}/webhooks/fake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': sig }, body });
    if (r.status !== 200) throw new Error(`webhook ${k} → ${r.status}`);
    return Date.now() - s;
  });
  const ackSecs = (Date.now() - t0) / 1000;
  console.log(`webhooks: ${N} in ${ackSecs.toFixed(1)}s → ${(N / ackSecs).toFixed(0)}/s · ack p50 ${pct(lat, 0.5)}ms p95 ${pct(lat, 0.95)}ms p99 ${pct(lat, 0.99)}ms`);

  if (a.email) {
    const login = await fetch(`${URL_}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: a.email, password: a.password }) });
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const me = await (await fetch(`${URL_}/api/auth/me`, { headers: { cookie } })).json();
    const get = async p => (await fetch(`${URL_}${p}`, { headers: { cookie } })).json();
    // Wait until every event became an inbound message: each one adds 1 to a conversation's unread count.
    const deadline = Date.now() + 10 * 60 * 1000;
    const unreadTotal = async () => {
      let total = 0, cursor = null;
      do {
        const r = await get(`/api/conversations?status=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        total += r.conversations.reduce((s, c) => s + c.unreadCount, 0);
        cursor = r.nextCursor;
      } while (cursor);
      return total;
    };
    const before = Number(a['unread-before'] || 0);
    let unread = 0;
    while (Date.now() < deadline && (unread = await unreadTotal()) < before + N) await new Promise(res => setTimeout(res, 1000));
    console.log(`processed: ${unread - before}/${N} events in the inbox after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (R) {
      const convs = (await get('/api/conversations?status=all&limit=100')).conversations;
      const s1 = Date.now();
      const ids = await pool(R, Math.min(C, 20), async k => {
        const c = convs[k % convs.length];
        const r = await fetch(`${URL_}/api/conversations/${c.id}/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }, body: JSON.stringify({ text: `reply ${k}` }) });
        return { conv: c.id, id: (await r.json()).message?.id, status: r.status };
      });
      const accepted = ids.filter(x => x.status === 201).length;
      let sent = 0;
      const convIds = [...new Set(ids.map(x => x.conv))];
      while (Date.now() < deadline) {
        const msgs = (await pool(convIds.length, 5, i => get(`/api/conversations/${convIds[i]}/messages?limit=50`))).flatMap(x => x.messages);
        sent = msgs.filter(m => m.direction === 'out' && m.status === 'sent' && ids.some(x => x.id === m.id)).length;
        if (sent >= accepted) break;
        await new Promise(res => setTimeout(res, 2000));
      }
      console.log(`replies: ${accepted}/${R} accepted, ${sent} sent by the queue in ${((Date.now() - s1) / 1000).toFixed(1)}s`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
