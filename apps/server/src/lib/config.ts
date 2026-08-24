// ============================================================
// CONFIGURATION
// ============================================================

import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
dotenv.config(); // Also check local .env

export const config = {
  server: {
    // Most hosts (Railway, Render, Heroku) inject PORT and expect the app to
    // bind to it; SERVER_PORT remains the override for local/other hosts.
    port: parseInt(process.env.PORT || process.env.SERVER_PORT || '4000'),
    host: process.env.SERVER_HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  angelOne: {
    apiKey: process.env.ANGEL_ONE_API_KEY || '',
    clientId: process.env.ANGEL_ONE_CLIENT_ID || '',
    password: process.env.ANGEL_ONE_PASSWORD || '',
    totpSecret: process.env.ANGEL_ONE_TOTP_SECRET || '',
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://fno_user:fno_dev_password@localhost:5432/fno_terminal',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production-min-32-chars',
    expiry: process.env.JWT_EXPIRY || '24h',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(','),
  },
} as const;

// Validate critical config in production — warn instead of hard crash to prevent container restart loops
if (config.server.nodeEnv === 'production') {
  const warnings: string[] = [];
  if (!config.angelOne.apiKey) {
    warnings.push('ANGEL_ONE_API_KEY is not set — broker endpoints will operate in offline/mock mode');
  }
  if (!config.jwt.secret || config.jwt.secret.includes('dev-') || config.jwt.secret.includes('change-in-production')) {
    warnings.push('JWT_SECRET is unset or using the dev default — please set a secure random string in production');
  }
  if (!config.database.url || config.database.url.includes('fno_dev_password')) {
    warnings.push('DATABASE_URL is unset or using the dev default — please configure your production Postgres URL');
  }

  for (const warning of warnings) {
    console.warn(`[CONFIG WARNING] ${warning}`);
  }
}
