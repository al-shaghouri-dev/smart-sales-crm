const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { createDb } = require('./db');
const { createStorage } = require('./storage');
const { loadSession, enforceSubscription } = require('./middleware/session');
const { createMailer } = require('./services/mailer');
const { AppError } = require('./errors');

const WEB_DIST = path.join(__dirname, '..', 'dist', 'web');

/**
 * Builds the Express app. `options.db` lets tests inject a database; otherwise one is created from config.
 */
function createApp(config, options = {}) {
  const db = options.db || createDb(config.databaseUrl);
  const storage = createStorage(config.uploadsDir);
  const mailer = options.mailer || createMailer(config.mail);
  const subscriptionGuard = enforceSubscription(db);
  const deps = { db, config, storage, mailer, onPolicyChange: subscriptionGuard.invalidate };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'smart-sales-crm' }));
  app.get('/api/ready', async (_req, res) => {
    try { await db.knex.raw('select 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: options.apiRateLimit || 600, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use('/uploads', express.static(config.uploadsDir, { dotfiles: 'deny', index: false, fallthrough: false }));
  app.use(loadSession(db));
  // Expired/suspended subscriptions: read-only or billing-only access to workspace APIs (never data deletion).
  app.use(['/api/company', '/api/team', '/api/roles', '/api/audit', '/api/billing', '/api/notifications'], subscriptionGuard);

  app.use('/api/public', require('./routes/platform').publicRoutes(deps));
  app.use('/api/public', require('./routes/platform-registrations').publicRegistrationRoutes(deps));
  app.use('/api/auth', require('./routes/auth')(deps));
  app.use('/api/me', require('./routes/me')(deps));
  app.use('/api/company', require('./routes/company')(deps));
  app.use('/api/team', require('./routes/team')(deps));
  app.use('/api/roles', require('./routes/roles')(deps));
  app.use('/api/audit', require('./routes/audit')(deps));
  app.use('/api/billing', require('./routes/billing').billingRoutes(deps));
  app.use('/api/notifications', require('./routes/billing').notificationRoutes(deps));
  app.use('/api/platform', require('./routes/platform').platformRoutes(deps));
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'common.not_found', 'Not found')));

  // Built React app (production). In development Vite serves the frontend and proxies /api.
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    if (error instanceof AppError) {
      return res.status(error.status).json({ ok: false, code: error.code, error: error.message, details: error.details });
    }
    if (error.type === 'entity.parse.failed') return res.status(400).json({ ok: false, code: 'common.bad_request', error: 'Malformed JSON' });
    if (error instanceof multer.MulterError) return res.status(400).json({ ok: false, code: 'upload.invalid_image', error: 'Invalid or too large file' });
    if (error.status === 404 || error.statusCode === 404) return res.status(404).json({ ok: false, code: 'common.not_found', error: 'Not found' });
    if (error.code === '42501') { // RLS / privilege violation — treat as forbidden, never leak details
      return res.status(403).json({ ok: false, code: 'auth.forbidden', error: 'Forbidden' });
    }
    if (error.code === '23505') return res.status(409).json({ ok: false, code: 'common.conflict', error: 'Already exists' });
    console.error('[error]', req.method, req.originalUrl, error);
    res.status(500).json({ ok: false, code: 'common.server_error', error: 'Internal server error' });
  });

  app.locals.db = db;
  app.locals.mailer = mailer;
  return app;
}

module.exports = { createApp };
