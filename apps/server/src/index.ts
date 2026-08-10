// ============================================================
// SERVER ENTRY POINT
// ============================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { redis, pingRedis } from './lib/redis.js';
import { sql, pingDb } from './lib/db.js';
import { SubscriptionManager } from './lib/subscription-manager.js';
import { createMarketWebSocketServer } from './ws/server.js';
import { AngelOneProvider } from './providers/angel-one/index.js';
import { createAuthRoutes } from './api/auth.js';
import { createInstrumentRoutes } from './api/instruments.js';
import { createMarketDataRoutes } from './api/market.js';
import { createOptionChainRoutes } from './api/option-chain.js';
import { createFuturesRoutes } from './api/futures.js';
import { createAlertRoutes } from './api/alerts.js';
import { startAlertScanner } from './services/alerts.js';
import { createAiAssistantRoutes } from './api/ai-assistant.js';

// --- Initialize Provider + Subscription Manager ---

const provider = new AngelOneProvider();
const subscriptionManager = new SubscriptionManager(provider);

// --- Express App ---

const app = express();

// Railway (and most hosts) sit behind a reverse proxy — trust its single hop
// so express-rate-limit reads the real client IP from X-Forwarded-For instead
// of rejecting the header as spoofed.
app.set('trust proxy', 1);

// --- Middleware ---

app.use(helmet({
  contentSecurityPolicy: false, // Allow frontend to connect
}));

app.use(cors({
  origin: config.cors.origins,
  credentials: true,
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});
app.use('/api/', limiter);

// Request logging
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'Request');
  next();
});

// --- API Routes ---

app.use('/api/auth', createAuthRoutes(provider));
app.use('/api/instruments', createInstrumentRoutes(provider));
app.use('/api/market', createMarketDataRoutes(provider));
app.use('/api/option-chain', createOptionChainRoutes(provider));
app.use('/api/futures', createFuturesRoutes(provider));
app.use('/api/alerts', createAlertRoutes());
app.use('/api/ai-assistant', createAiAssistantRoutes(provider));

// --- Health Check ---

app.get('/api/health', async (_req, res) => {
  const [redisHealth, dbHealth] = await Promise.all([pingRedis(), pingDb()]);
  const wsStatus = subscriptionManager.getStatus();

  const services = {
    api: 'HEALTHY' as const,
    provider: {
      name: provider.name,
      authenticated: provider.isAuthenticated(),
    },
    redis: redisHealth.healthy
      ? { status: 'HEALTHY' as const, latencyMs: redisHealth.latencyMs }
      : { status: 'DOWN' as const, error: redisHealth.error },
    database: dbHealth.healthy
      ? { status: 'HEALTHY' as const, latencyMs: dbHealth.latencyMs }
      : { status: 'DOWN' as const, error: dbHealth.error },
    websocket: {
      status: wsStatus.connected ? ('HEALTHY' as const) : ('DOWN' as const),
      ...wsStatus,
    },
  };

  const overall =
    services.redis.status === 'HEALTHY' && services.database.status === 'HEALTHY'
      ? 'HEALTHY'
      : 'DEGRADED';

  res.json({
    success: true,
    data: {
      status: overall,
      uptime: process.uptime(),
      timestamp: Date.now(),
      services,
      version: '0.1.0',
    },
  });
});

// --- 404 Handler ---

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
  });
});

// --- Error Handler ---

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
});

// --- Start Server ---

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(
    { port: config.server.port, host: config.server.host, env: config.server.nodeEnv },
    '🚀 F&O Terminal Server started'
  );
});

createMarketWebSocketServer(server, subscriptionManager);

// --- Boot-time Angel One Authentication ---
// Single-user, read-only terminal: credentials live in env vars, not a
// frontend login flow. If they're present we auth automatically and keep
// the session alive; if not, REST endpoints that don't need auth still work.

const TOKEN_REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // refresh well before ~24h expiry

async function authenticateOnBoot(): Promise<void> {
  const { apiKey, clientId, password, totpSecret } = config.angelOne;
  if (!apiKey || !clientId || !password) {
    logger.warn('ANGEL_ONE_* credentials not set — starting without a live provider session');
    return;
  }

  const result = await provider.authenticate({ apiKey, clientId, password, totpSecret });
  if (!result.success) {
    logger.error({ error: result.error }, 'Angel One boot-time authentication failed');
    return;
  }

  logger.info('Angel One authenticated — connecting subscription manager');
  try {
    await subscriptionManager.connect();
  } catch (err: any) {
    logger.error({ error: err.message }, 'Subscription manager failed to connect');
  }
}

authenticateOnBoot();
startAlertScanner(provider);

setInterval(() => {
  if (provider.isAuthenticated()) {
    provider.refreshAuth().catch((err) =>
      logger.error({ error: err.message }, 'Scheduled Angel One token refresh failed')
    );
  }
}, TOKEN_REFRESH_INTERVAL_MS);

// --- Graceful Shutdown ---

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down...');

  server.close(() => {
    logger.info('HTTP server closed');
  });

  subscriptionManager.disconnect();

  try {
    await provider.logout();
  } catch {
    // Best effort
  }

  try {
    await sql.end({ timeout: 5 });
    redis.disconnect();
  } catch {
    // Best effort
  }

  setTimeout(() => {
    logger.warn('Forced shutdown');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
