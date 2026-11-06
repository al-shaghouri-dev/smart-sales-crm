require('dotenv').config();
const { loadKeyRingFromEnv } = require('./security/secrets');

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
function deriveAppUrl(env) {
  if (!env.DATABASE_MIGRATION_URL || !env.APP_DB_ROLE || !env.APP_DB_PASSWORD) return undefined;
  try {
    const u = new URL(env.DATABASE_MIGRATION_URL);
    u.username = env.APP_DB_ROLE;
    u.password = env.APP_DB_PASSWORD;
    return u.toString();
  } catch { return undefined; }
}
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const port = Number(env.PORT || 3000);
  // On Render, RENDER_EXTERNAL_URL (https://<service>.onrender.com) is provided automatically.
  const appUrl = (env.APP_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const config = {
    env: nodeEnv,
    isProd,
    port,
    // Number of reverse proxies in front of the app ("true" = 1). Needed for correct client IPs
    // (rate limits, audit log). Example: browser → Vercel rewrite → host load balancer → app = 2.
    // Never set higher than the real number of proxies, or clients could spoof their IP.
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : (/^[1-9]$/.test(String(env.TRUST_PROXY || '')) ? Number(env.TRUST_PROXY) : false),
    // Application connection (restricted role, RLS applies). If unset, it is derived from the
    // owner connection with APP_DB_ROLE / APP_DB_PASSWORD (lets hosting blueprints wire it automatically).
    databaseUrl: env.DATABASE_URL || deriveAppUrl(env),
    // Optional non-pooled connection for features needing a session-pinned connection
    // (pg-boss, LISTEN/NOTIFY). Use it when DATABASE_URL points at a transaction-mode pooler.
    databaseDirectUrl: env.DATABASE_DIRECT_URL || env.DATABASE_URL || deriveAppUrl(env),
    uploadsDir: env.UPLOADS_DIR || require('path').join(__dirname, '..', 'uploads'),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT || 10),
    // Requests per minute per client IP for /api (protects against scraping and brute force).
    apiRateLimit: int(env.API_RATE_LIMIT_PER_MINUTE, 600),
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
      poolMax: int(env.JOBS_POOL_MAX, 4),
      batchSize: int(env.JOBS_BATCH_SIZE, 10)
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
    // ---- Messaging & media ----
    messaging: {
      sendMaxAttempts: int(env.MESSAGE_SEND_MAX_ATTEMPTS, 5),
      sendRetryDelaySeconds: int(env.MESSAGE_SEND_RETRY_DELAY_SECONDS, 10),
      maxMediaBytes: int(env.MEDIA_MAX_BYTES, 10 * 1024 * 1024)
    },
    media: {
      // "local" (private folder on disk; needs a persistent disk) or "s3" (any S3-compatible service).
      driver: env.MEDIA_DRIVER || 'local',
      dir: env.MEDIA_DIR || '',
      s3: {
        bucket: env.MEDIA_S3_BUCKET, region: env.MEDIA_S3_REGION, endpoint: env.MEDIA_S3_ENDPOINT,
        accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID, secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE !== 'false'
      }
    },
    // Public https origin that providers call (webhooks, OAuth redirects). Defaults to APP_URL.
    publicUrl: (env.PUBLIC_URL || appUrl).replace(/\/+$/, ''),
    // Server secret used to derive per-channel webhook secrets (e.g. Telegram secret_token).
    // Required in production; a random per-process value is used in development.
    webhookSecretKey: env.WEBHOOK_SECRET_KEY || (isProd ? '' : require('crypto').randomBytes(32).toString('base64')),
    telegram: {
      // Only for local mock servers in development/tests; production always uses the official API.
      apiBase: (!isProd && env.TELEGRAM_API_BASE) ? env.TELEGRAM_API_BASE.replace(/\/+$/, '') : 'https://api.telegram.org'
    },
    // Meta (Messenger / Instagram / WhatsApp). Base URLs can point at mock servers only outside production.
    meta: {
      graphVersion: env.META_GRAPH_VERSION || 'v24.0',
      graphBase: (!isProd && env.META_GRAPH_BASE) ? env.META_GRAPH_BASE.replace(/\/+$/, '') : 'https://graph.facebook.com',
      igGraphBase: (!isProd && env.META_IG_GRAPH_BASE) ? env.META_IG_GRAPH_BASE.replace(/\/+$/, '') : 'https://graph.instagram.com',
      igApiBase: (!isProd && env.META_IG_API_BASE) ? env.META_IG_API_BASE.replace(/\/+$/, '') : 'https://api.instagram.com',
      appId: env.META_APP_ID || '',
      appSecret: env.META_APP_SECRET || '',
      verifyToken: env.META_VERIFY_TOKEN || '',
      // Instagram API with Instagram Login uses the Instagram app id/secret shown in the Meta app dashboard.
      igAppId: env.META_IG_APP_ID || '',
      igAppSecret: env.META_IG_APP_SECRET || '',
      // WhatsApp Embedded Signup (requires Tech Provider status). Disabled while empty.
      waConfigId: env.META_WA_CONFIG_ID || ''
    },
    // Enabled provider adapters. Real providers arrive in Phase 3.3+; "fake" is for local tests only.
    channelProviders: list(env.CHANNEL_PROVIDERS),
    fakeProviderSecret: env.FAKE_PROVIDER_SECRET || ''
  };

  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (isProd && !config.keyRing) throw new Error('APP_ENCRYPTION_KEYS (or APP_ENCRYPTION_KEY) is required in production');
  if (!['all', 'web', 'worker'].includes(config.processRole)) throw new Error('PROCESS_ROLE must be all, web or worker');
  if (!['none', 'postgres'].includes(config.realtime.adapter)) throw new Error('REALTIME_ADAPTER must be none or postgres');
  if (!['local', 's3'].includes(config.media.driver)) throw new Error('MEDIA_DRIVER must be local or s3');
  if (config.media.driver === 's3' && !config.media.s3.bucket) throw new Error('MEDIA_S3_BUCKET is required when MEDIA_DRIVER=s3');
  if (isProd && config.channelProviders.includes('fake')) throw new Error('The fake channel provider cannot be enabled in production');
  if (isProd && config.channelProviders.some(p => p !== 'fake') && String(config.webhookSecretKey).length < 32) {
    throw new Error('WEBHOOK_SECRET_KEY (at least 32 characters, e.g. openssl rand -base64 32) is required in production when channel providers are enabled');
  }
  if (isProd && config.channelProviders.length && !/^https:\/\//.test(config.publicUrl)) throw new Error('PUBLIC_URL (or APP_URL) must be https in production when channel providers are enabled');
  return config;
}

module.exports = { loadConfig };
