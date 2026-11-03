const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { createApp, ROLES } = require('../server');

const APP_SECRET = 'test-app-secret';
const PASSWORD = 'Str0ngPassw0rd!';

function setup({ env = {}, fetch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-'));
  const calls = [];
  const fakeFetch = fetch || (async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'x', name: 'Page' }) };
  });
  const app = createApp({ dataDir: path.join(dir, 'data'), uploadsDir: path.join(dir, 'uploads'), env: { NODE_ENV: 'test', ...env }, fetch: fakeFetch, loginLimit: 1000 });
  const { readData, writeData, hashPassword } = app.locals;
  writeData('employees', [
    { id: 'm1', name: 'Manager', username: 'manager', role: ROLES.MANAGER, status: 'نشط', passwordHash: hashPassword(PASSWORD) },
    { id: 'e1', name: 'Employee', username: 'employee', role: ROLES.SALES, status: 'نشط', passwordHash: hashPassword(PASSWORD) },
    { id: 'legacy', name: 'Legacy', username: 'legacy', role: ROLES.MANAGER, status: 'نشط', password: PASSWORD }
  ]);
  return { app, readData, writeData, calls, dir };
}

async function login(app, username) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ username, password: PASSWORD });
  assert.equal(res.status, 200, `login ${username}`);
  return { agent, csrf: res.body.csrfToken };
}

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

describe('authentication', () => {
  test('protected endpoints reject anonymous requests', async () => {
    const { app } = setup();
    const checks = [
      ['get', '/api/settings'], ['post', '/api/settings'], ['get', '/api/customers'], ['get', '/api/messages'],
      ['get', '/api/orders'], ['get', '/api/employees'], ['post', '/api/employees'], ['put', '/api/employees/m1/password'],
      ['delete', '/api/employees/e1'], ['get', '/api/export/excel'], ['post', '/api/reset-demo'], ['post', '/api/send-message'],
      ['post', '/api/settings/test-connection'], ['get', '/api/status'], ['post', '/api/settings/logo']
    ];
    for (const [method, url] of checks) {
      const res = await request(app)[method](url).send({});
      assert.equal(res.status, 401, `${method.toUpperCase()} ${url} should be 401, got ${res.status}`);
    }
  });

  test('public branding endpoint exposes no secrets', async () => {
    const { app, writeData } = setup();
    writeData('settings', { companyName: 'Acme', pageAccessToken: 'secret-token', verifyToken: 'vt', appSecret: 's' });
    const res = await request(app).get('/api/branding');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['businessType', 'companyName', 'logoUrl', 'primaryColor']);
  });

  test('login sets an httpOnly session cookie and /api/me works', async () => {
    const { app } = setup();
    const agent = request.agent(app);
    const res = await agent.post('/api/login').send({ username: 'MANAGER', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.passwordHash, undefined);
    const cookie = res.headers['set-cookie'].join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const me = await agent.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'manager');
  });

  test('wrong password and legacy plaintext passwords are rejected', async () => {
    const { app } = setup();
    assert.equal((await request(app).post('/api/login').send({ username: 'manager', password: 'nope' })).status, 401);
    assert.equal((await request(app).post('/api/login').send({ username: 'legacy', password: PASSWORD })).status, 401);
    assert.equal((await request(app).post('/api/login').send({ username: 'ghost', password: PASSWORD })).status, 401);
  });

  test('no default admin account is created', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-'));
    const app = createApp({ dataDir: dir, uploadsDir: path.join(dir, 'u'), env: {} });
    assert.equal((await request(app).post('/api/login').send({ username: 'admin', password: 'Admin@2026' })).status, 401);
    assert.deepEqual(app.locals.readData('employees'), []);
  });

  test('state-changing requests require the CSRF token', async () => {
    const { app } = setup();
    const { agent, csrf } = await login(app, 'manager');
    assert.equal((await agent.post('/api/settings').send({ companyName: 'X' })).status, 403);
    assert.equal((await agent.post('/api/settings').set('X-CSRF-Token', 'wrong').send({ companyName: 'X' })).status, 403);
    assert.equal((await agent.post('/api/settings').set('X-CSRF-Token', csrf).send({ companyName: 'X' })).status, 200);
  });

  test('logout invalidates the session', async () => {
    const { app } = setup();
    const { agent, csrf } = await login(app, 'manager');
    assert.equal((await agent.post('/api/logout').set('X-CSRF-Token', csrf)).status, 200);
    assert.equal((await agent.get('/api/customers')).status, 401);
  });

  test('deactivating an employee ends their sessions', async () => {
    const { app } = setup();
    const m = await login(app, 'manager');
    const e = await login(app, 'employee');
    assert.equal((await e.agent.get('/api/customers')).status, 200);
    assert.equal((await m.agent.put('/api/employees/e1').set('X-CSRF-Token', m.csrf).send({ status: 'غير نشط' })).status, 200);
    assert.equal((await e.agent.get('/api/customers')).status, 401);
  });
});

describe('authorization', () => {
  test('employees cannot perform manager actions', async () => {
    const { app } = setup();
    const { agent, csrf } = await login(app, 'employee');
    const checks = [
      ['post', '/api/settings'], ['post', '/api/employees'], ['put', '/api/employees/m1'], ['put', '/api/employees/m1/password'],
      ['delete', '/api/employees/m1'], ['post', '/api/reset-demo'], ['post', '/api/settings/test-connection']
    ];
    for (const [method, url] of checks) {
      const res = await agent[method](url).set('X-CSRF-Token', csrf).send({ password: 'hijacked-password', confirm: 'DELETE' });
      assert.equal(res.status, 403, `${method.toUpperCase()} ${url}`);
    }
    assert.equal((await agent.get('/api/export/excel')).status, 403);
  });

  test('employees get limited settings and colleague data', async () => {
    const { app, writeData } = setup();
    writeData('settings', { companyName: 'Acme', pageAccessToken: 'secret-token', pageId: '123' });
    const { agent } = await login(app, 'employee');
    const s = (await agent.get('/api/settings')).body;
    assert.equal(s.pageAccessToken, undefined);
    assert.equal(s.pageId, undefined);
    const staff = (await agent.get('/api/employees')).body;
    assert.ok(staff.every(x => x.username === undefined && x.passwordHash === undefined));
  });

  test('manager settings mask every secret', async () => {
    const { app, writeData } = setup();
    writeData('settings', { pageAccessToken: 'tok', appSecret: 'sec', verifyToken: 'vt', whatsappAccessToken: 'wa' });
    const { agent } = await login(app, 'manager');
    const s = (await agent.get('/api/settings')).body;
    for (const k of ['pageAccessToken', 'appSecret', 'verifyToken', 'whatsappAccessToken']) assert.match(s[k], /^•+$/);
  });

  test('the last active manager cannot be demoted, deactivated or deleted', async () => {
    const { app, writeData, readData } = setup();
    writeData('employees', readData('employees').filter(e => e.id !== 'legacy'));
    const { agent, csrf } = await login(app, 'manager');
    assert.equal((await agent.put('/api/employees/m1').set('X-CSRF-Token', csrf).send({ role: ROLES.SALES })).status, 409);
    assert.equal((await agent.put('/api/employees/m1').set('X-CSRF-Token', csrf).send({ status: 'غير نشط' })).status, 409);
    assert.equal((await agent.delete('/api/employees/m1').set('X-CSRF-Token', csrf)).status, 409);
  });

  test('generic resources ignore non-whitelisted fields', async () => {
    const { app } = setup();
    const { agent, csrf } = await login(app, 'employee');
    const res = await agent.post('/api/customers').set('X-CSRF-Token', csrf).send({ name: 'A', id: 'forced', isAdmin: true, key: 'x' });
    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, 'forced');
    assert.equal(res.body.isAdmin, undefined);
    assert.equal(res.body.key, undefined);
  });

  test('new employee passwords need 8+ characters and are hashed', async () => {
    const { app, readData } = setup();
    const { agent, csrf } = await login(app, 'manager');
    assert.equal((await agent.post('/api/employees').set('X-CSRF-Token', csrf).send({ name: 'N', username: 'n1', password: 'short' })).status, 400);
    const ok = await agent.post('/api/employees').set('X-CSRF-Token', csrf).send({ name: 'N', username: 'n1', password: 'longenough' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.employee.passwordHash, undefined);
    assert.match(readData('employees').find(e => e.username === 'n1').passwordHash, /^scrypt:/);
  });

  test('reset-demo requires explicit confirmation', async () => {
    const { app, writeData, readData } = setup();
    writeData('customers', [{ id: 'c1' }]);
    const { agent, csrf } = await login(app, 'manager');
    assert.equal((await agent.post('/api/reset-demo').set('X-CSRF-Token', csrf).send({})).status, 400);
    assert.equal(readData('customers').length, 1);
    assert.equal((await agent.post('/api/reset-demo').set('X-CSRF-Token', csrf).send({ confirm: 'DELETE' })).status, 200);
    assert.equal(readData('customers').length, 0);
  });
});

describe('webhooks', () => {
  const arabicPayload = () => JSON.stringify({ object: 'page', entry: [{ id: 'p', messaging: [{ sender: { id: 'u1' }, recipient: { id: 'p' }, message: { mid: 'mid-1', text: 'مرحبا مرحبا' } }] }] })
    // Meta escapes non-ASCII characters; re-serialising the parsed body would not reproduce these bytes.
    .replace(/[\u0080-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const wait = () => new Promise(r => setTimeout(r, 30));

  test('valid signature over raw bytes (escaped Arabic) is accepted', async () => {
    const { app, readData } = setup({ env: { META_APP_SECRET: APP_SECRET } });
    const body = arabicPayload();
    const res = await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
    assert.equal(res.status, 200);
    await wait();
    const msgs = readData('messages');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'مرحبا مرحبا');
  });

  test('missing or invalid signatures are rejected', async () => {
    const { app, readData } = setup({ env: { META_APP_SECRET: APP_SECRET } });
    const body = arabicPayload();
    assert.equal((await request(app).post('/webhook').set('Content-Type', 'application/json').send(body)).status, 403);
    assert.equal((await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send(body)).status, 403);
    assert.equal(readData('messages').length, 0);
  });

  test('without an app secret webhooks are rejected (unless dev override)', async () => {
    const { app } = setup();
    assert.equal((await request(app).post('/webhook').send({ object: 'page', entry: [] })).status, 403);
    const dev = setup({ env: { ALLOW_UNSIGNED_WEBHOOKS: 'true' } });
    assert.equal((await request(dev.app).post('/webhook').send({ object: 'page', entry: [] })).status, 200);
    const prod = setup({ env: { ALLOW_UNSIGNED_WEBHOOKS: 'true', NODE_ENV: 'production' } });
    assert.equal((await request(prod.app).post('/webhook').send({ object: 'page', entry: [] })).status, 403);
  });

  test('duplicate deliveries are stored once', async () => {
    const { app, readData } = setup({ env: { META_APP_SECRET: APP_SECRET } });
    const body = arabicPayload();
    for (let i = 0; i < 3; i++) {
      await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
      await wait();
    }
    assert.equal(readData('messages').length, 1);
  });

  test('verify handshake requires a configured token', async () => {
    const { app } = setup();
    assert.equal((await request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'c' })).status, 403);
    const ok = setup({ env: { META_VERIFY_TOKEN: 'my-token' } });
    const res = await request(ok.app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'my-token', 'hub.challenge': 'abc' });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'abc');
    assert.equal((await request(ok.app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'creative_kids_2026', 'hub.challenge': 'abc' })).status, 403);
  });
});

describe('messaging', () => {
  test('replies go to the stored customer and tokens are not put in URLs', async () => {
    const { app, writeData, calls, readData } = setup({ env: { META_PAGE_ACCESS_TOKEN: 'page-token' } });
    writeData('customers', [{ id: 'c1', externalId: 'psid-1', channel: 'Messenger', name: 'C' }]);
    const { agent, csrf } = await login(app, 'employee');
    const res = await agent.post('/api/send-message').set('X-CSRF-Token', csrf).send({ customerId: 'c1', text: 'hi', recipientId: 'attacker', channel: 'WhatsApp' });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].url, /page-token|access_token/);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer page-token');
    assert.equal(JSON.parse(calls[0].init.body).recipient.id, 'psid-1');
    assert.equal(readData('messages')[0].employeeId, 'e1');
  });

  test('marking a customer read clears all of their unread messages', async () => {
    const { app, writeData, readData } = setup();
    writeData('customers', [{ id: 'c1', unread: 2 }]);
    writeData('messages', [{ id: '1', customerId: 'c1', unread: true }, { id: '2', customerId: 'c1', unread: true }, { id: '3', customerId: 'c2', unread: true }]);
    const { agent, csrf } = await login(app, 'employee');
    assert.equal((await agent.post('/api/customers/c1/read').set('X-CSRF-Token', csrf)).status, 200);
    assert.deepEqual(readData('messages').map(m => m.unread), [false, false, true]);
  });
});

describe('excel export', () => {
  test('never includes credentials and neutralises formulas', async () => {
    const { app, writeData } = setup();
    writeData('customers', [{ id: 'c1', name: '=HYPERLINK("http://evil","x")', last: new Date().toISOString() }]);
    const { agent } = await login(app, 'manager');
    const res = await agent.get('/api/export/excel').query({ type: 'all' }).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const all = [];
    wb.eachSheet(sheet => sheet.eachRow(row => all.push(...row.values.map(v => String(v ?? '')))));
    const text = all.join('|');
    assert.doesNotMatch(text, /passwordHash|scrypt:|Str0ngPassw0rd/);
    assert.ok(all.includes(`'=HYPERLINK("http://evil","x")`));
  });

  test('rejects unknown export types', async () => {
    const { app } = setup();
    const { agent } = await login(app, 'manager');
    assert.equal((await agent.get('/api/export/excel').query({ type: 'sessions' })).status, 400);
  });
});

describe('settings & uploads', () => {
  test('rejects javascript: logo URLs and invalid values', async () => {
    const { app } = setup();
    const { agent, csrf } = await login(app, 'manager');
    assert.equal((await agent.post('/api/settings').set('X-CSRF-Token', csrf).send({ logoUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await agent.post('/api/settings').set('X-CSRF-Token', csrf).send({ primaryColor: 'red' })).status, 400);
    assert.equal((await agent.post('/api/settings').set('X-CSRF-Token', csrf).send({ logoUrl: 'https://cdn.example.com/a.png' })).status, 200);
  });

  test('logo upload checks file content, not the declared type', async () => {
    const { app } = setup();
    const { agent, csrf } = await login(app, 'manager');
    const fake = await agent.post('/api/settings/logo').set('X-CSRF-Token', csrf).attach('logo', Buffer.from('<svg onload=alert(1)>'), { filename: 'x.png', contentType: 'image/png' });
    assert.equal(fake.status, 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const ok = await agent.post('/api/settings/logo').set('X-CSRF-Token', csrf).attach('logo', png, { filename: '../../evil.html', contentType: 'text/html' });
    assert.equal(ok.status, 200);
    assert.match(ok.body.logoUrl, /^\/uploads\/\d+-[0-9a-f]+\.png$/);
  });

  test('security headers include a CSP that blocks inline scripts', async () => {
    const { app } = setup();
    const res = await request(app).get('/');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.match(res.headers['content-security-policy'], /script-src-attr 'none'/);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('login is rate limited', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscrm-'));
    const app = createApp({ dataDir: dir, uploadsDir: path.join(dir, 'u'), env: {}, loginLimit: 3 });
    for (let i = 0; i < 3; i++) await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    assert.equal((await request(app).post('/api/login').send({ username: 'a', password: 'b' })).status, 429);
  });
});

describe('frontend hardening', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'app.js'), 'utf8');
  test('no eval and no inline event handlers', () => {
    assert.doesNotMatch(src, /\beval\(/);
    assert.doesNotMatch(src, /\son[a-z]+="/);
  });
  test('no hardcoded company branding or personal copyright', () => {
    assert.doesNotMatch(src, /Creative Kids|شخاشيرو|'CK'/);
  });
});
