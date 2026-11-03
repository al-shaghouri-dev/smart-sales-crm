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
    encryptionKey: env.APP_ENCRYPTION_KEY || ''
  };
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (config.isProd && !config.encryptionKey) throw new Error('APP_ENCRYPTION_KEY is required in production');
  return config;
}

module.exports = { loadConfig };
