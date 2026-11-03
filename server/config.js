require('dotenv').config();
const { loadKeyRingFromEnv } = require('./security/secrets');

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const port = Number(env.PORT || 3000);
  const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const config = {
    env: nodeEnv,
    isProd,
    port,
    trustProxy: env.TRUST_PROXY === 'true',
    databaseUrl: env.DATABASE_URL,
    // Optional non-pooled connection for features needing a session-pinned connection
    // (pg-boss, LISTEN/NOTIFY). Use it when DATABASE_URL points at a transaction-mode pooler.
    databaseDirectUrl: env.DATABASE_DIRECT_URL || env.DATABASE_URL,
    uploadsDir: env.UPLOADS_DIR || require('path').join(__dirname, '..', 'uploads'),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT || 10),
    encryptionKey: env.APP_ENCRYPTION_KEY || '',
    keyRing: loadKeyRingFromEnv(env),
    // Public base URL used in invitation / password-reset links.
    appUrl,
    platformSessionTtlHours: Number(env.PLATFORM_SESSION_TTL_HOURS || 4),
    mail: {
      driver: env.MAIL_DRIVER || (env.SMTP_HOST ? 'smtp' : 'none'),
      from: env.MAIL_FROM || '',
      smtp: {
        host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER, pass: env.SMTP_PASSWORD
      }
    },

    // ---- Process roles: "all" (single process), "web" (HTTP + Socket.IO), "worker" (jobs only) ----
    processRole: env.PROCESS_ROLE || 'all',
    jobsEnabled: env.JOBS_ENABLED !== 'false',
    jobs: {
      schema: env.JOBS_SCHEMA || 'pgboss',
      pollingIntervalSeconds: Number(env.JOBS_POLLING_INTERVAL_SECONDS || 2),
      poolMax: int(env.JOBS_POOL_MAX, 4)
    },
    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 25000),

    // ---- Real-time (Socket.IO) ----
    realtime: {
      enabled: env.REALTIME_ENABLED !== 'false',
      // "none" = single instance; "postgres" = @socket.io/postgres-adapter (LISTEN/NOTIFY) for several instances.
      adapter: env.REALTIME_ADAPTER || 'none',
      // Browsers must present one of these Origins; defaults to APP_URL (same-origin deployment).
      allowedOrigins: list(env.REALTIME_ALLOWED_ORIGINS).length ? list(env.REALTIME_ALLOWED_ORIGINS) : [appUrl],
      revalidateSeconds: int(env.REALTIME_REVALIDATE_SECONDS, 60)
    },

    // ---- Webhooks / channel providers ----
    webhooks: {
      bodyLimit: env.WEBHOOK_BODY_LIMIT || '1mb',
      maxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 5),
      retryDelaySeconds: int(env.WEBHOOK_RETRY_DELAY_SECONDS, 30),
      retentionDays: int(env.WEBHOOK_RETENTION_DAYS, 30),
      rateLimitPerMinute: int(env.WEBHOOK_RATE_LIMIT_PER_MINUTE, 1200)
    },
    // Enabled provider adapters. Real providers arrive in Phase 3.3+; "fake" is for local tests only.
    channelProviders: list(env.CHANNEL_PROVIDERS),
    fakeProviderSecret: env.FAKE_PROVIDER_SECRET || ''
  };

  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (isProd && !config.keyRing) throw new Error('APP_ENCRYPTION_KEYS (or APP_ENCRYPTION_KEY) is required in production');
  if (!['all', 'web', 'worker'].includes(config.processRole)) throw new Error('PROCESS_ROLE must be all, web or worker');
  if (!['none', 'postgres'].includes(config.realtime.adapter)) throw new Error('REALTIME_ADAPTER must be none or postgres');
  if (isProd && config.channelProviders.includes('fake')) throw new Error('The fake channel provider cannot be enabled in production');
  return config;
}

module.exports = { loadConfig };
