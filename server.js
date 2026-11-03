require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

/*
 * Smart Sales CRM — legacy single-workspace server (Phase 0 hardened).
 * Storage is still JSON files; Phase 1 moves everything to PostgreSQL.
 */

const ROLES = { MANAGER: 'مدير', SALES: 'موظف مبيعات', SUPPORT: 'خدمة عملاء' };
const VALID_ROLES = Object.values(ROLES);
const ACTIVE = 'نشط';
const INACTIVE = 'غير نشط';
const VALID_STATUSES = [ACTIVE, INACTIVE];
const SESSION_COOKIE = 'sscrm_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;
const MASK = '••••••••••••••••';

const FILES = {
  settings: 'settings.json',
  customers: 'customers.json',
  messages: 'messages.json',
  orders: 'orders.json',
  employees: 'employees.json',
  sessions: 'sessions.json'
};

const DEFAULT_SETTINGS = {
  companyName: '',
  businessType: '',
  logoUrl: '',
  primaryColor: '#6366f1',
  currency: 'USD',
  tax: 0,
  shipping: 0,
  pageId: '',
  pageAccessToken: '',
  verifyToken: '',
  appSecret: '',
  graphVersion: 'v26.0',
  instagramAccountId: '',
  whatsappPhoneNumberId: '',
  whatsappAccessToken: '',
  whatsappBusinessAccountId: '',
  whatsappEnabled: false,
  autoReplyEnabled: false,
  quickReplies: []
};

// Fields an API client may write on generic resources (prevents mass assignment).
const WRITABLE = {
  customers: ['name', 'phone', 'email', 'status', 'notes', 'tags'],
  orders: ['customer', 'customerId', 'employee', 'items', 'total', 'shipping', 'status', 'notes', 'date'],
  messages: []
};

// Columns allowed in Excel exports (never credentials).
const EXPORT_COLUMNS = {
  customers: ['id', 'name', 'channel', 'status', 'phone', 'email', 'messages', 'unread', 'last', 'createdAt'],
  orders: ['id', 'customer', 'employee', 'total', 'shipping', 'status', 'date', 'createdAt'],
  messages: ['id', 'customerId', 'name', 'channel', 'direction', 'text', 'time'],
  employees: ['id', 'name', 'username', 'role', 'status', 'shift', 'createdAt']
};

function createApp(options = {}) {
  const env = options.env || process.env;
  const isProd = env.NODE_ENV === 'production';
  const DATA = options.dataDir || path.join(__dirname, 'data');
  const UPLOADS = options.uploadsDir || path.join(__dirname, 'public', 'uploads');
  const FRONTEND = path.join(__dirname, 'frontend');
  const fetchImpl = options.fetch || globalThis.fetch;
  const allowUnsignedWebhooks = env.ALLOW_UNSIGNED_WEBHOOKS === 'true' && !isProd;

  for (const dir of [DATA, UPLOADS]) fs.mkdirSync(dir, { recursive: true });

  // ---------- JSON storage ----------
  const dataFile = name => {
    if (!FILES[name]) throw new Error(`Unknown data file: ${name}`);
    return path.join(DATA, FILES[name]);
  };
  const defaults = name => (name === 'settings' ? { ...DEFAULT_SETTINGS } : []);
  function readData(name) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
      if (parsed === null || parsed === undefined) throw new Error('empty');
      return parsed;
    } catch {
      const value = defaults(name);
      writeData(name, value);
      return value;
    }
  }
  function writeData(name, value) {
    const target = dataFile(name);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  }

  // Secrets come from the environment first; settings.json only fills gaps.
  function getSettings() {
    const s = { ...DEFAULT_SETTINGS, ...readData('settings') };
    return {
      ...s,
      pageId: s.pageId || env.META_PAGE_ID || '',
      pageAccessToken: env.META_PAGE_ACCESS_TOKEN || s.pageAccessToken || '',
      verifyToken: env.META_VERIFY_TOKEN || s.verifyToken || '',
      appSecret: env.META_APP_SECRET || s.appSecret || '',
      graphVersion: s.graphVersion || env.META_GRAPH_VERSION || DEFAULT_SETTINGS.graphVersion,
      instagramAccountId: s.instagramAccountId || env.INSTAGRAM_ACCOUNT_ID || '',
      whatsappPhoneNumberId: s.whatsappPhoneNumberId || env.WHATSAPP_PHONE_NUMBER_ID || '',
      whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN || s.whatsappAccessToken || '',
      whatsappBusinessAccountId: s.whatsappBusinessAccountId || env.WHATSAPP_BUSINESS_ACCOUNT_ID || ''
    };
  }
  // Branding only — safe before login.
  function brandingSettings() {
    const s = getSettings();
    return { companyName: s.companyName, businessType: s.businessType, logoUrl: s.logoUrl, primaryColor: s.primaryColor };
  }
  function managerSettings() {
    const s = getSettings();
    return {
      ...s,
      pageAccessToken: s.pageAccessToken ? MASK : '',
      appSecret: s.appSecret ? MASK : '',
      verifyToken: s.verifyToken ? MASK : '',
      whatsappAccessToken: s.whatsappAccessToken ? MASK : ''
    };
  }
  function employeeSettings() {
    const s = getSettings();
    return { ...brandingSettings(), currency: s.currency, quickReplies: s.quickReplies };
  }

  // ---------- Passwords ----------
  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }
  // Only scrypt hashes are accepted; legacy plaintext passwords no longer authenticate.
  function verifyPassword(password, stored) {
    if (!stored || !String(stored).startsWith('scrypt:')) return false;
    const [, salt, expected] = String(stored).split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const exp = Buffer.from(expected, 'hex');
    return exp.length === actual.length && crypto.timingSafeEqual(actual, exp);
  }
  const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

  const sanitizeUser = user => {
    if (!user) return user;
    const { password, passwordHash, ...safe } = user;
    return safe;
  };
  const id = () => `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');

  // ---------- Sessions ----------
  function createSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const sessions = readData('sessions').filter(s => s.expiresAt > now);
    sessions.push({ id: sha256(token), userId: String(user.id), csrf, createdAt: now, expiresAt: now + SESSION_TTL_MS });
    writeData('sessions', sessions);
    return { token, csrf };
  }
  function destroySessions(predicate) {
    writeData('sessions', readData('sessions').filter(s => !predicate(s)));
  }
  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: isProd, path: '/', maxAge: SESSION_TTL_MS };

  function loadSession(req, _res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return next();
    const session = readData('sessions').find(s => s.id === sha256(token) && s.expiresAt > Date.now());
    if (!session) return next();
    const user = readData('employees').find(u => String(u.id) === session.userId);
    if (!user || user.status !== ACTIVE) return next();
    req.session = session;
    req.user = user;
    next();
  }
  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ ok: false, error: 'يجب تسجيل الدخول' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = String(req.get('x-csrf-token') || '');
      const a = Buffer.from(header), b = Buffer.from(req.session.csrf);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ ok: false, error: 'رمز الحماية غير صالح، أعد تحميل الصفحة' });
      }
    }
    next();
  }
  const isManager = user => user && user.role === ROLES.MANAGER;
  function requireManager(req, res, next) {
    if (!isManager(req.user)) return res.status(403).json({ ok: false, error: 'هذه العملية متاحة للمدير فقط' });
    next();
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === 'true' ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    }
  }));

  app.get('/api/health', (_, res) => res.json({ ok: true, service: 'smart-sales-crm', time: new Date().toISOString() }));

  // Keep the raw body so webhook signatures are computed over the exact bytes Meta signed.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/uploads', express.static(UPLOADS, { dotfiles: 'deny', index: false }));
  app.use(express.static(FRONTEND, { index: 'index.html' }));
  app.use(loadSession);

  const limiterOpts = { standardHeaders: 'draft-7', legacyHeaders: false };
  const loginLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, limit: options.loginLimit || 10, message: { ok: false, error: 'محاولات كثيرة، حاول لاحقاً' } });
  const apiLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, limit: 600 });
  const webhookLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, limit: 1200 });
  app.use('/api', apiLimiter);

  // ---------- Authentication ----------
  app.get('/api/branding', (_, res) => res.json(brandingSettings()));

  app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    const normalized = String(username || '').trim().toLowerCase();
    const user = readData('employees').find(x => String(x.username || '').trim().toLowerCase() === normalized);
    const valid = verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !valid) return res.status(401).json({ ok: false, error: 'بيانات الدخول غير صحيحة' });
    if (user.status !== ACTIVE) return res.status(403).json({ ok: false, error: 'هذا الحساب غير نشط حالياً' });
    const { token, csrf } = createSession(user);
    res.cookie(SESSION_COOKIE, token, cookieOptions);
    res.json({ ok: true, user: sanitizeUser(user), csrfToken: csrf });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false });
    res.json({ ok: true, user: sanitizeUser(req.user), csrfToken: req.session.csrf });
  });

  app.post('/api/logout', requireAuth, (req, res) => {
    destroySessions(s => s.id === req.session.id);
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true });
  });

  app.post('/api/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || String(newPassword || '').length < MIN_PASSWORD) {
      return res.status(400).json({ ok: false, error: `كلمة المرور الجديدة يجب أن تكون ${MIN_PASSWORD} أحرف على الأقل` });
    }
    const users = readData('employees');
    const user = users.find(x => String(x.id) === String(req.user.id));
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(401).json({ ok: false, error: 'كلمة المرور الحالية غير صحيحة' });
    }
    user.passwordHash = hashPassword(newPassword);
    user.updatedAt = new Date().toISOString();
    writeData('employees', users);
    destroySessions(s => s.userId === String(user.id) && s.id !== req.session.id);
    res.json({ ok: true });
  });

  // ---------- Settings ----------
  app.get('/api/settings', requireAuth, (req, res) => res.json(isManager(req.user) ? managerSettings() : employeeSettings()));

  app.post('/api/settings', requireAuth, requireManager, (req, res) => {
    const body = req.body || {};
    const next = { ...DEFAULT_SETTINGS, ...readData('settings') };
    const strings = ['companyName', 'businessType', 'logoUrl', 'primaryColor', 'currency', 'pageId', 'graphVersion',
      'instagramAccountId', 'whatsappPhoneNumberId', 'whatsappBusinessAccountId'];
    for (const key of strings) if (body[key] !== undefined) next[key] = String(body[key]).trim().slice(0, 300);
    for (const key of ['pageAccessToken', 'appSecret', 'whatsappAccessToken', 'verifyToken']) {
      if (body[key] && !String(body[key]).includes('••••')) next[key] = String(body[key]).trim();
    }
    if (body.tax !== undefined) next.tax = Math.max(0, Number(body.tax) || 0);
    if (body.shipping !== undefined) next.shipping = Math.max(0, Number(body.shipping) || 0);
    if (body.whatsappEnabled !== undefined) next.whatsappEnabled = Boolean(body.whatsappEnabled);
    if (body.autoReplyEnabled !== undefined) next.autoReplyEnabled = Boolean(body.autoReplyEnabled);
    if (Array.isArray(body.quickReplies)) {
      next.quickReplies = body.quickReplies.map(String).map(x => x.trim().slice(0, 1000)).filter(Boolean).slice(0, 20);
    }
    if (!/^#[0-9a-f]{6}$/i.test(next.primaryColor)) return res.status(400).json({ ok: false, error: 'لون النظام غير صالح' });
    if (next.logoUrl && !/^(\/uploads\/[\w.-]+|https:\/\/[^\s"'<>]+)$/i.test(next.logoUrl)) {
      return res.status(400).json({ ok: false, error: 'رابط الشعار غير صالح' });
    }
    if (!/^[A-Z]{3}$/.test(next.currency)) return res.status(400).json({ ok: false, error: 'العملة غير صالحة' });
    if (!/^v\d+\.\d+$/.test(next.graphVersion)) return res.status(400).json({ ok: false, error: 'إصدار Graph API غير صالح' });
    writeData('settings', next);
    res.json({ ok: true, settings: managerSettings() });
  });

  const IMAGE_SIGNATURES = [
    { ext: 'png', test: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: 'gif', test: b => b.slice(0, 4).toString('ascii') === 'GIF8' },
    { ext: 'webp', test: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' }
  ];
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.post('/api/settings/logo', requireAuth, requireManager, upload.single('logo'), (req, res) => {
    const match = req.file && IMAGE_SIGNATURES.find(sig => sig.test(req.file.buffer));
    if (!match) return res.status(400).json({ ok: false, error: 'يرجى اختيار صورة PNG/JPG/WEBP/GIF صالحة' });
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${match.ext}`;
    fs.writeFileSync(path.join(UPLOADS, filename), req.file.buffer);
    const s = { ...DEFAULT_SETTINGS, ...readData('settings'), logoUrl: `/uploads/${filename}` };
    writeData('settings', s);
    res.json({ ok: true, logoUrl: s.logoUrl });
  });

  // Access tokens go in the Authorization header, never in URLs (URLs end up in logs).
  async function graphRequest(url, token, init = {}) {
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!response.ok) {
      const error = new Error(body?.error?.message || `Meta API returned HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
  const graphUrl = (s, p) => `https://graph.facebook.com/${encodeURIComponent(s.graphVersion)}/${p}`;

  app.post('/api/settings/test-connection', requireAuth, requireManager, async (req, res) => {
    const channel = String(req.body?.channel || 'messenger').toLowerCase();
    const s = getSettings();
    try {
      if (channel === 'whatsapp') {
        if (!s.whatsappAccessToken || !s.whatsappPhoneNumberId) throw new Error('بيانات WhatsApp Phone Number ID وAccess Token غير مكتملة');
        const data = await graphRequest(graphUrl(s, `${encodeURIComponent(s.whatsappPhoneNumberId)}?fields=id,display_phone_number,verified_name`), s.whatsappAccessToken);
        return res.json({ ok: true, channel: 'whatsapp', data });
      }
      if (!s.pageAccessToken || !s.pageId) throw new Error('Page ID وPage Access Token غير مكتملين');
      const data = await graphRequest(graphUrl(s, `${encodeURIComponent(s.pageId)}?fields=id,name`), s.pageAccessToken);
      res.json({ ok: true, channel: 'messenger', data });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message, details: error.body?.error ? { type: error.body.error.type, code: error.body.error.code } : undefined });
    }
  });

  app.get('/api/status', requireAuth, requireManager, (_, res) => {
    const s = getSettings();
    res.json({
      ok: true,
      pageConfigured: Boolean(s.pageId && s.pageAccessToken),
      webhookSignatureConfigured: Boolean(s.appSecret),
      verifyTokenConfigured: Boolean(s.verifyToken),
      instagramAccountConfigured: Boolean(s.instagramAccountId),
      whatsappConfigured: Boolean(s.whatsappPhoneNumberId && s.whatsappAccessToken),
      whatsappEnabled: Boolean(s.whatsappEnabled),
      autoReplyEnabled: Boolean(s.autoReplyEnabled),
      webhook: '/webhook'
    });
  });

  // ---------- Generic REST resources (authenticated, field whitelist) ----------
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj && obj[k] !== undefined).map(k => [k, obj[k]]));
  function resourceRoutes(name, { writeRole } = {}) {
    const guardWrite = writeRole === 'manager' ? [requireAuth, requireManager] : [requireAuth];
    app.get(`/api/${name}`, requireAuth, (req, res) => {
      let rows = readData(name);
      if (req.query.search) {
        const q = String(req.query.search).toLowerCase();
        rows = rows.filter(row => JSON.stringify(row).toLowerCase().includes(q));
      }
      rows = rows.slice(0, Math.min(Number(req.query.limit) || 1000, 1000));
      res.json(rows);
    });
    app.get(`/api/${name}/:id`, requireAuth, (req, res) => {
      const row = readData(name).find(x => String(x.id) === String(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: 'العنصر غير موجود' });
      res.json(row);
    });
    if (!WRITABLE[name].length) return;
    app.post(`/api/${name}`, ...guardWrite, (req, res) => {
      const rows = readData(name);
      const row = { id: id(), createdAt: new Date().toISOString(), createdBy: String(req.user.id), ...pick(req.body, WRITABLE[name]) };
      rows.unshift(row);
      writeData(name, rows);
      res.status(201).json(row);
    });
    app.patch(`/api/${name}/:id`, ...guardWrite, (req, res) => {
      const rows = readData(name);
      const index = rows.findIndex(x => String(x.id) === String(req.params.id));
      if (index < 0) return res.status(404).json({ ok: false, error: 'العنصر غير موجود' });
      rows[index] = { ...rows[index], ...pick(req.body, WRITABLE[name]), updatedAt: new Date().toISOString() };
      writeData(name, rows);
      res.json(rows[index]);
    });
    app.delete(`/api/${name}/:id`, requireAuth, requireManager, (req, res) => {
      const rows = readData(name);
      const index = rows.findIndex(x => String(x.id) === String(req.params.id));
      if (index < 0) return res.status(404).json({ ok: false, error: 'العنصر غير موجود' });
      const [deleted] = rows.splice(index, 1);
      writeData(name, rows);
      res.json({ ok: true, deleted });
    });
  }
  resourceRoutes('customers');
  resourceRoutes('orders');

  // ---------- Staff & User Management ----------
  app.get('/api/employees', requireAuth, (req, res) => {
    const rows = readData('employees').map(sanitizeUser);
    // Non-managers only see colleagues' names/roles.
    res.json(isManager(req.user) ? rows : rows.map(x => ({ id: x.id, name: x.name, role: x.role, status: x.status })));
  });

  app.post('/api/employees', requireAuth, requireManager, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 100);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || ROLES.SALES).trim();
    const status = String(body.status || ACTIVE).trim();
    if (!name || !username || !password) return res.status(400).json({ ok: false, error: 'الاسم واسم المستخدم وكلمة المرور مطلوبة' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ ok: false, error: `كلمة المرور يجب أن تكون ${MIN_PASSWORD} أحرف على الأقل` });
    if (!/^[^\s@]{2,64}(?:@[^\s@]+)?$/.test(username)) return res.status(400).json({ ok: false, error: 'اسم المستخدم غير صالح' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ ok: false, error: 'الدور الوظيفي غير صالح' });
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'حالة الحساب غير صالحة' });
    const employees = readData('employees');
    if (employees.some(x => String(x.username || '').toLowerCase() === username)) {
      return res.status(409).json({ ok: false, error: 'اسم المستخدم مستخدم بالفعل' });
    }
    const employee = { id: id(), name, username, role, status, shift: '', createdAt: new Date().toISOString(), passwordHash: hashPassword(password) };
    employees.unshift(employee);
    writeData('employees', employees);
    res.status(201).json({ ok: true, employee: sanitizeUser(employee) });
  });

  app.put('/api/employees/:id', requireAuth, requireManager, (req, res) => {
    const employees = readData('employees');
    const employee = employees.find(x => String(x.id) === String(req.params.id));
    if (!employee) return res.status(404).json({ ok: false, error: 'الموظف غير موجود' });
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 100);
      if (!name) return res.status(400).json({ ok: false, error: 'الاسم لا يمكن أن يكون فارغاً' });
      employee.name = name;
    }
    if (body.role !== undefined && !VALID_ROLES.includes(String(body.role))) return res.status(400).json({ ok: false, error: 'الدور الوظيفي غير صالح' });
    if (body.status !== undefined && !VALID_STATUSES.includes(String(body.status))) return res.status(400).json({ ok: false, error: 'حالة الحساب غير صالحة' });
    if (body.shift !== undefined) employee.shift = String(body.shift).trim().slice(0, 100);
    const nextRole = body.role !== undefined ? String(body.role) : employee.role;
    const nextStatus = body.status !== undefined ? String(body.status) : employee.status;
    // Never allow the workspace to lose its last active manager.
    const otherActiveManagers = employees.filter(x => x !== employee && x.role === ROLES.MANAGER && x.status === ACTIVE).length;
    if (employee.role === ROLES.MANAGER && (nextRole !== ROLES.MANAGER || nextStatus !== ACTIVE) && otherActiveManagers === 0) {
      return res.status(409).json({ ok: false, error: 'يجب أن يبقى مدير نشط واحد على الأقل' });
    }
    employee.role = nextRole;
    employee.status = nextStatus;
    employee.updatedAt = new Date().toISOString();
    writeData('employees', employees);
    if (employee.status !== ACTIVE) destroySessions(s => s.userId === String(employee.id));
    res.json({ ok: true, employee: sanitizeUser(employee) });
  });

  app.put('/api/employees/:id/password', requireAuth, requireManager, (req, res) => {
    const employees = readData('employees');
    const employee = employees.find(x => String(x.id) === String(req.params.id));
    if (!employee) return res.status(404).json({ ok: false, error: 'الموظف غير موجود' });
    const password = String(req.body?.password || '');
    if (password.length < MIN_PASSWORD) return res.status(400).json({ ok: false, error: `كلمة المرور يجب أن تكون ${MIN_PASSWORD} أحرف على الأقل` });
    employee.passwordHash = hashPassword(password);
    delete employee.password;
    employee.updatedAt = new Date().toISOString();
    writeData('employees', employees);
    destroySessions(s => s.userId === String(employee.id) && s.id !== req.session.id);
    res.json({ ok: true, employee: sanitizeUser(employee) });
  });

  app.delete('/api/employees/:id', requireAuth, requireManager, (req, res) => {
    const employees = readData('employees');
    const index = employees.findIndex(x => String(x.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ ok: false, error: 'الموظف غير موجود' });
    if (String(employees[index].id) === String(req.user.id)) return res.status(409).json({ ok: false, error: 'لا يمكنك حذف حسابك الحالي' });
    const target = employees[index];
    const otherActiveManagers = employees.filter(x => x !== target && x.role === ROLES.MANAGER && x.status === ACTIVE).length;
    if (target.role === ROLES.MANAGER && otherActiveManagers === 0) return res.status(409).json({ ok: false, error: 'يجب أن يبقى مدير نشط واحد على الأقل' });
    const [deleted] = employees.splice(index, 1);
    writeData('employees', employees);
    destroySessions(s => s.userId === String(deleted.id));
    res.json({ ok: true, deleted: sanitizeUser(deleted) });
  });

  // ---------- Messages ----------
  app.get('/api/messages', requireAuth, (req, res) => {
    res.json(readData('messages').slice(0, Math.min(Number(req.query.limit) || 1000, 5000)));
  });

  // Marks every unread message from a customer as read.
  app.post('/api/customers/:id/read', requireAuth, (req, res) => {
    const messages = readData('messages');
    let changed = 0;
    for (const m of messages) if (String(m.customerId) === String(req.params.id) && m.unread) { m.unread = false; changed++; }
    if (changed) writeData('messages', messages);
    const customers = readData('customers');
    const customer = customers.find(c => String(c.id) === String(req.params.id));
    if (customer && customer.unread) { customer.unread = 0; writeData('customers', customers); }
    res.json({ ok: true, changed });
  });

  function findCustomer(channel, senderId, name) {
    const customers = readData('customers');
    const key = `${channel}:${senderId}`;
    let customer = customers.find(x => x.key === key);
    if (!customer) {
      customer = { id: id(), key, externalId: senderId, name: String(name || `${channel} Customer`).slice(0, 200), channel, status: 'لم يطلب', createdAt: new Date().toISOString(), messages: 0, unread: 0 };
      customers.unshift(customer);
    }
    customer.last = new Date().toISOString();
    customer.messages = (customer.messages || 0) + 1;
    customer.unread = (customer.unread || 0) + 1;
    writeData('customers', customers);
    return customer;
  }

  function appendMessage(message) {
    const rows = readData('messages');
    rows.unshift({ id: id(), time: new Date().toISOString(), ...message });
    writeData('messages', rows);
  }

  async function sendReply(channel, recipientId, text) {
    const s = getSettings();
    if (channel === 'WhatsApp') {
      if (!s.whatsappAccessToken || !s.whatsappPhoneNumberId) throw new Error('بيانات WhatsApp غير مكتملة');
      return graphRequest(graphUrl(s, `${encodeURIComponent(s.whatsappPhoneNumberId)}/messages`), s.whatsappAccessToken, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: recipientId, type: 'text', text: { body: text } })
      });
    }
    if (channel === 'Instagram') {
      if (!s.pageAccessToken || !s.instagramAccountId) throw new Error('بيانات Instagram/Page غير مكتملة');
      return graphRequest(graphUrl(s, `${encodeURIComponent(s.instagramAccountId)}/messages`), s.pageAccessToken, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
      });
    }
    if (!s.pageAccessToken) throw new Error('Page Access Token غير مضبوط');
    return graphRequest(graphUrl(s, 'me/messages'), s.pageAccessToken, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } })
    });
  }

  app.post('/api/send-message', requireAuth, async (req, res) => {
    const { text, customerId } = req.body || {};
    const cleanText = String(text || '').trim().slice(0, 2000);
    // Recipient and channel are taken from the stored customer, not from the client.
    const customer = readData('customers').find(c => String(c.id) === String(customerId));
    if (!customer || !cleanText) return res.status(400).json({ ok: false, error: 'العميل ونص الرسالة مطلوبان' });
    try {
      const result = await sendReply(customer.channel, String(customer.externalId), cleanText);
      appendMessage({ customerId: customer.id, externalUserId: customer.externalId, name: customer.name, channel: customer.channel, text: cleanText, direction: 'outbound', unread: false, manual: true, employee: req.user.name, employeeId: String(req.user.id) });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  // ---------- Webhooks ----------
  function verifyMetaSignature(req) {
    const s = getSettings();
    if (!s.appSecret) return allowUnsignedWebhooks;
    const signature = String(req.get('x-hub-signature-256') || '');
    if (!signature.startsWith('sha256=') || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', s.appSecret).update(req.rawBody).digest();
    const given = Buffer.from(signature.slice(7), 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  app.get('/webhook', webhookLimiter, (req, res) => {
    const s = getSettings();
    const token = String(req.query['hub.verify_token'] || '');
    if (req.query['hub.mode'] === 'subscribe' && s.verifyToken && token.length === s.verifyToken.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s.verifyToken))) {
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  const processing = new Set();
  app.post('/webhook', webhookLimiter, (req, res) => {
    if (!verifyMetaSignature(req)) return res.sendStatus(403);
    if (!Array.isArray(req.body?.entry)) return res.sendStatus(400);
    res.sendStatus(200);
    for (const event of normalizeWebhookEvents(req.body)) {
      processIncomingEvent(event).catch(error => console.error('[Webhook]', error.message));
    }
  });

  function normalizeWebhookEvents(payload) {
    const events = [];
    const channel = payload.object === 'instagram' ? 'Instagram' : payload.object === 'whatsapp_business_account' ? 'WhatsApp' : 'Messenger';
    for (const entry of payload.entry || []) {
      if (channel === 'WhatsApp') {
        for (const change of entry.changes || []) {
          for (const msg of change.value?.messages || []) {
            if (!msg.from || msg.type !== 'text') continue;
            events.push({
              channel, senderId: String(msg.from), text: String(msg.text?.body || ''), mid: msg.id || null,
              profileName: change.value?.contacts?.find(c => c.wa_id === msg.from)?.profile?.name || 'WhatsApp Customer'
            });
          }
        }
        continue;
      }
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo || !event.sender?.id || !event.message.text) continue;
        events.push({ channel, senderId: String(event.sender.id), text: String(event.message.text), mid: event.message.mid || null });
      }
    }
    return events;
  }

  function autoReply(text, settings) {
    const t = String(text).trim().toLowerCase();
    const q = settings.quickReplies || [];
    if (/^(سلام|السلام|اهلا|أهلا|هاي|hello|hi|صباح الخير|مساء الخير)/i.test(t)) return q[0] || null;
    if (/سعر|الاسعار|الأسعار|بكام|بكم|price/i.test(t)) return q[1] || null;
    if (/الشحن|توصيل|delivery|shipping/i.test(t)) return q[2] || null;
    if (/اطلب|طلب|order|buy/i.test(t)) return q[3] || null;
    return null;
  }

  async function processIncomingEvent(event) {
    // Meta retries deliveries; ignore message IDs we have already stored.
    if (event.mid) {
      if (processing.has(event.mid) || readData('messages').some(m => m.externalMessageId === event.mid)) return;
      processing.add(event.mid);
    }
    try {
      const settings = getSettings();
      const customer = findCustomer(event.channel, event.senderId, event.profileName);
      appendMessage({ externalMessageId: event.mid, customerId: customer.id, externalUserId: event.senderId, name: customer.name, channel: event.channel, text: event.text.slice(0, 5000), direction: 'inbound', unread: true });
      if (!settings.autoReplyEnabled) return;
      const reply = autoReply(event.text, settings);
      if (!reply) return;
      try {
        await sendReply(event.channel, event.senderId, reply);
        appendMessage({ customerId: customer.id, externalUserId: event.senderId, name: customer.name, channel: event.channel, text: reply, direction: 'outbound', unread: false, auto: true });
      } catch (error) {
        console.error('[Meta send]', error.message);
      }
    } finally {
      if (event.mid) processing.delete(event.mid);
    }
  }

  // ---------- Excel export (managers only, whitelisted columns) ----------
  const dayStart = v => { const d = new Date(`${v}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d; };
  const dayEnd = v => { const d = new Date(`${v}T23:59:59.999`); return Number.isNaN(d.getTime()) ? null : d; };
  function getExportRange(q) {
    const period = String(q.period || 'all');
    const now = new Date();
    if (period === 'today') return [new Date(now.getFullYear(), now.getMonth(), now.getDate()), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)];
    if (period === 'date' && q.date) { const a = dayStart(q.date), b = dayEnd(q.date); return a && b ? [a, b] : null; }
    if (period === 'range' && q.from && q.to) { const a = dayStart(q.from), b = dayEnd(q.to); return a && b ? [a, b] : null; }
    if (period === 'month') {
      if (!/^\d{4}-\d{2}$/.test(String(q.month || ''))) return null;
      const [y, m] = String(q.month).split('-').map(Number);
      return [new Date(y, m - 1, 1), new Date(y, m, 0, 23, 59, 59, 999)];
    }
    return null;
  }
  function filterRowsByDate(rows, key, range) {
    if (!range) return rows;
    return rows.filter(row => { const d = new Date(row[key]); return !Number.isNaN(d.getTime()) && d >= range[0] && d <= range[1]; });
  }
  // Prevent spreadsheet formula injection from customer-controlled text.
  function safeCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  }

  app.get('/api/export/excel', requireAuth, requireManager, async (req, res) => {
    const ExcelJS = require('exceljs');
    const type = String(req.query.type || 'all');
    if (!['all', ...Object.keys(EXPORT_COLUMNS)].includes(type)) return res.status(400).json({ ok: false, error: 'نوع التصدير غير صالح' });
    const range = getExportRange(req.query);
    if (['date', 'range', 'month'].includes(String(req.query.period || '')) && !range) return res.status(400).json({ ok: false, error: 'نطاق التاريخ غير صالح' });
    const employee = String(req.query.employee || '');
    const data = {
      customers: filterRowsByDate(readData('customers'), 'last', range),
      orders: filterRowsByDate(readData('orders'), 'date', range).filter(x => !employee || String(x.employee || '') === employee),
      messages: filterRowsByDate(readData('messages'), 'time', range).filter(x => !employee || String(x.employee || '') === employee),
      employees: readData('employees').map(sanitizeUser)
    };
    const selected = type === 'all' ? Object.keys(EXPORT_COLUMNS) : [type];
    const labels = { customers: 'العملاء', orders: 'الأوردرات', messages: 'المحادثات', employees: 'الموظفون' };
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Smart Sales CRM';
    workbook.created = new Date();
    for (const key of selected) {
      const rows = data[key];
      const columns = EXPORT_COLUMNS[key];
      const sheet = workbook.addWorksheet(labels[key]);
      sheet.views = [{ rightToLeft: true }];
      if (!rows.length) { sheet.addRow(['لا توجد بيانات ضمن الفترة المحددة']); continue; }
      sheet.columns = columns.map(c => ({ header: c, key: c, width: Math.min(Math.max(c.length + 4, 14), 32) }));
      rows.forEach(row => sheet.addRow(columns.map(c => safeCell(row[c]))));
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="crm-export-${stamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  // Clears business data only; users/settings remain. Requires explicit confirmation text.
  app.post('/api/reset-demo', requireAuth, requireManager, (req, res) => {
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ ok: false, error: 'التأكيد مطلوب' });
    writeData('customers', []);
    writeData('messages', []);
    writeData('orders', []);
    res.json({ ok: true });
  });

  app.use('/api', (_, res) => res.status(404).json({ ok: false, error: 'غير موجود' }));
  app.get('/{*splat}', (_, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'طلب غير صالح' });
    if (error instanceof multer.MulterError) return res.status(400).json({ ok: false, error: 'ملف غير صالح أو كبير جداً' });
    console.error(error);
    res.status(500).json({ ok: false, error: 'حدث خطأ داخلي في الخادم' });
  });

  app.locals.hashPassword = hashPassword;
  app.locals.readData = readData;
  app.locals.writeData = writeData;
  return app;
}

module.exports = { createApp, ROLES };

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  createApp().listen(PORT, () => console.log(`Smart Sales CRM running at http://localhost:${PORT}`));
}
