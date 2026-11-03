require('dotenv').config();

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const config = {
    env: nodeEnv,
    isProd: nodeEnv === 'production',
    port: Number(env.PORT || 3000),
    trustProxy: env.TRUST_PROXY === 'true',
    databaseUrl: env.DATABASE_URL,
    uploadsDir: env.UPLOADS_DIR || require('path').join(__dirname, '..', 'uploads'),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT || 10),
    encryptionKey: env.APP_ENCRYPTION_KEY || '',
    // Public base URL used in invitation / password-reset links.
    appUrl: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
    platformSessionTtlHours: Number(env.PLATFORM_SESSION_TTL_HOURS || 4),
    mail: {
      driver: env.MAIL_DRIVER || (env.SMTP_HOST ? 'smtp' : 'none'),
      from: env.MAIL_FROM || '',
      smtp: {
        host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER, pass: env.SMTP_PASSWORD
      }
    },
    jobsEnabled: env.JOBS_ENABLED !== 'false'
  };
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (config.isProd && !config.encryptionKey) throw new Error('APP_ENCRYPTION_KEY is required in production');
  return config;
}

module.exports = { loadConfig };
