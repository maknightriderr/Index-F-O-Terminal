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
import { refreshAuthWithRetry } from './lib/auth-refresh.js';
import { serviceSupervisor, type ServiceSpec } from './lib/service-supervisor.js';
import { rehydrateFromPostgres } from './services/state-recovery.js';
import { isMarketOpen } from '@fno/shared';
import { notifyOperationalAlert } from './services/telegram.js';
import { runInteractive } from './lib/request-priority.js';
import { startHolidayCalendarCheck } from './services/holiday-calendar-check.js';
import { startSystemLearningAudit } from './services/system-learning-audit.js';
import { createMarketWebSocketServer } from './ws/server.js';
import { AngelOneProvider } from './providers/angel-one/index.js';
import { createAuthRoutes } from './api/auth.js';
import { createInstrumentRoutes } from './api/instruments.js';
import { createMarketDataRoutes } from './api/market.js';
import { createOptionChainRoutes } from './api/option-chain.js';
import { createFuturesRoutes } from './api/futures.js';
import { createAlertRoutes } from './api/alerts.js';
import { startAlertScanner } from './services/alerts.js';
import { startPatternScanner } from './services/chart-patterns.js';
import { createAiAssistantRoutes } from './api/ai-assistant.js';
import { createInstitutionalFlowRoutes } from './api/institutional-flow.js';
import { createBacktestingRoutes } from './api/backtesting.js';
import { createLearningRoutes } from './api/learning.js';
import { createLossAttributionRoutes } from './api/loss-attribution.js';
import { createStructureRoutes } from './api/structure.js';
import { createPaperTradesRoutes } from './api/paper-trades.js';
import { orderFlowFeedStatus } from './services/dhan-feed.js';
import { STRUCTURE, STRUCTURE_ENTRY_TF, STRUCTURE_ENTRY_TF_REJECTED, STRUCTURE_PARAMS, INDICATOR_CONFIDENCE_MODE, INDICATOR_CONFIDENCE_MODE_REJECTED, INDICATOR_LOCATION_MODE, INDICATOR_LOCATION_MODE_REJECTED, RESEARCH_PAPER_TRADING } from './config/trading-flags.js';
import { startAbandonedSetupSweep } from './services/backtesting.js';
import { createNewsRoutes } from './api/news.js';
import { createCorporateActionsRoutes } from './api/corporate-actions.js';
import { startInstitutionalFlowScanner } from './services/institutional-flow-scanner.js';
import { startTradeSetupPriceMonitor } from './services/trade-setup-monitor.js';
import { createMarketScannerRoutes } from './api/market-scanner.js';
import { createStrategyScannerRoutes } from './api/strategy-scanner.js';
import { startStrategyTracker } from './services/strategy-tracker.js';
import { startMarketScanner } from './services/market-scanner.js';
import { createFiiDiiRoutes } from './api/fii-dii.js';
import { startFiiDiiTracker } from './services/fii-dii.js';
import { startOiCloseSnapshot } from './services/oi-close-snapshot.js';
import { startCacheWarmer } from './services/cache-warmer.js';
import { startPositionalStockScan } from './services/positional-stock-scan.js';
import { startBackgroundBiasEvaluator } from './services/background-bias-evaluator.js';
import { startMarketStateCapture } from './services/market-state-capture.js';
import { startMissedWinnerAudit } from './services/missed-winner-audit.js';
import { startSetupEventsGrading } from './services/setup-events-grading.js';
import { startOpportunityCensus } from './services/opportunity-census-job.js';
import { orderFlowFeedActive, startOrderFlowFeed } from './services/dhan-feed.js';
import { createDiagnosticsRoutes } from './api/diagnostics.js';
import { ensureCaptureSchema } from './services/ensure-capture-schema.js';

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

// Terminal API requests jump the broker request queue ahead of background
// jobs — see lib/request-priority.ts.
app.use('/api/', (_req, _res, next) => runInteractive(next));

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
app.use('/api/institutional-flow', createInstitutionalFlowRoutes(provider));
app.use('/api/backtesting', createBacktestingRoutes(provider));
app.use('/api/news', createNewsRoutes());
app.use('/api/corporate-actions', createCorporateActionsRoutes());
app.use('/api/market-scanner', createMarketScannerRoutes(provider));
app.use('/api/strategy-scanner', createStrategyScannerRoutes());
app.use('/api/fii-dii', createFiiDiiRoutes());
app.use('/api/learning', createLearningRoutes());
app.use('/api/loss-attribution', createLossAttributionRoutes());
app.use('/api/structure', createStructureRoutes());
app.use('/api/diagnostics', createDiagnosticsRoutes());
app.use('/api/paper-trades', createPaperTradesRoutes());

// --- Health Check ---

// A probe that can't answer IS the answer. When the Postgres volume filled up
// on 17 Sep the database stopped accepting connections, pingDb() sat on a
// connect timeout, and /api/health hung for 30s+ instead of reporting the
// outage — so the System Health page showed nothing at the one moment it
// mattered.
const HEALTH_PROBE_TIMEOUT_MS = 3000;

function withProbeTimeout<T extends { healthy: boolean; error?: string }>(probe: Promise<T>, label: string): Promise<T | { healthy: false; error: string }> {
  return Promise.race([
    probe.catch((err: any) => ({ healthy: false as const, error: err?.message ?? String(err) })),
    new Promise<{ healthy: false; error: string }>((resolve) =>
      setTimeout(() => resolve({ healthy: false, error: `${label} did not respond within ${HEALTH_PROBE_TIMEOUT_MS}ms` }), HEALTH_PROBE_TIMEOUT_MS).unref()
    ),
  ]);
}

app.get('/api/health', async (_req, res) => {
  const [redisHealth, dbHealth] = await Promise.all([
    withProbeTimeout(pingRedis(), 'Redis'),
    withProbeTimeout(pingDb(), 'Database'),
  ]);
  const wsStatus = subscriptionManager.getStatus();
  // Phase 5: every tick-feed token's data state (asOf / source / status as in Phase 2 dataQuality).
  const feed = { ...wsStatus.feed, perToken: subscriptionManager.getFeedStates() };

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
      status: wsStatus.connected ? (feed.upstreamDown || feed.byState.DATA_GAP > 0 ? ('DEGRADED' as const) : ('HEALTHY' as const)) : ('DOWN' as const),
      ...wsStatus,
    },
  };

  // Phase 6: every supervised service, and the critical ones that are not RUNNING.
  const supervisor = { services: serviceSupervisor.snapshot(), degradedCritical: serviceSupervisor.degradedCritical().map((s) => s.name) };
  // The feed counts only while it is down in session (a token gap is shown per token, not as an outage);
  // a critical service that is not RUNNING degrades the whole system.
  const overall =
    services.redis.status === 'HEALTHY' && services.database.status === 'HEALTHY' && !feed.upstreamDown && supervisor.degradedCritical.length === 0
      ? 'HEALTHY'
      : 'DEGRADED';

  // Read-only evidence for the System Health page: the exchange sessions at this instant (so a closed market is not
  // read as a failed feed) and the Dhan order-flow feed's own status. In-memory state only; nothing is fetched.
  const nowMs = Date.now();
  const sessions = (['NSE', 'BSE', 'MCX'] as const).map((exchange) => ({ exchange, open: isMarketOpen(exchange, nowMs) }));

  res.json({
    success: true,
    data: {
      status: overall,
      uptime: process.uptime(),
      timestamp: nowMs,
      services,
      feed,
      supervisor,
      sessions,
      orderFlow: orderFlowFeedStatus(),
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
  logger.info(
    { structure: STRUCTURE, entryTimeframe: STRUCTURE_ENTRY_TF, closingGuardMin: STRUCTURE_PARAMS.STRUCTURE_CLOSING_GUARD_MIN },
    'Structure engine: entry timeframe and closing guard'
  );
  if (STRUCTURE_ENTRY_TF_REJECTED != null) {
    logger.warn({ value: STRUCTURE_ENTRY_TF_REJECTED, using: STRUCTURE_ENTRY_TF }, "STRUCTURE_ENTRY_TF is not '5m' or '15m' — using the default");
  }
  logger.info({ mode: INDICATOR_CONFIDENCE_MODE }, 'Indicator engine: confidence mode (EVIDENCE = evidence only; LEGACY = the old 75 gate)');
  logger.info({ mode: INDICATOR_LOCATION_MODE }, 'Indicator engine: location mode (EVIDENCE = recorded only; LEGACY = the old POOR_LOCATION gate)');
  logger.info({ enabled: RESEARCH_PAPER_TRADING }, 'Research paper trading: trigger families A2–F3 compete for the paper slot as PAPER_RESEARCH (off = SHADOW, recorded only)');
  if (INDICATOR_LOCATION_MODE_REJECTED != null) {
    logger.warn({ value: INDICATOR_LOCATION_MODE_REJECTED, using: INDICATOR_LOCATION_MODE }, 'INDICATOR_LOCATION_MODE is not EVIDENCE or LEGACY — using the default');
  }
  if (INDICATOR_CONFIDENCE_MODE_REJECTED != null) {
    logger.warn({ value: INDICATOR_CONFIDENCE_MODE_REJECTED, using: INDICATOR_CONFIDENCE_MODE }, 'INDICATOR_CONFIDENCE_MODE is not EVIDENCE or LEGACY — using the default');
  }
});

createMarketWebSocketServer(server, subscriptionManager);

// --- Boot-time Angel One Authentication ---
// Single-user, read-only terminal: credentials live in env vars, not a
// frontend login flow. If they're present we auth automatically and keep
// the session alive; if not, REST endpoints that don't need auth still work.

// Shorter than the 24h token expiry so a single silently-failed attempt
// (Angel One's refresh-token flow can return a non-error "no token" response
// with no exception to catch) still leaves multiple retries before the
// session actually lapses, rather than one shot at ~20h with no recovery.
const TOKEN_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;

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
// --- Background services: started, watched and stopped by the ServiceSupervisor (Phase 6) ---
// The 18 existing start*() jobs, unchanged, each registered with its
// criticality and timeouts (heartbeat 0 = derived from the job's own
// interval). Plus two COMPONENT registrations for work that is not one of the
// 18 (see their notes). Critical: tradeSetupPriceMonitor, signalEngine,
// setupLifecycle — any of them not RUNNING makes /api/health DEGRADED.
//
// The schema has to be ensured first for the four capture jobs, and it cannot
// be assumed: the deploy start command is `node dist/index.js` and runs no
// migration. Capture is instrumentation — a failed check still starts them.
// PostgreSQL is the source of truth: Redis is rebuilt from it (state-recovery)
// before the trade-setup monitor starts.
const schemaReady = ensureCaptureSchema().catch((err: any) => {
  logger.error({ error: err.message }, 'Capture schema check failed — starting capture anyway');
});
const recoveryReady = schemaReady
  .then(() => Promise.race([rehydrateFromPostgres(), new Promise((r) => setTimeout(r, 20_000).unref())]))
  .catch((err: any) => logger.error({ error: err.message }, 'State recovery failed — Redis left as it was'));
const anySession = (now: number) => isMarketOpen('NSE', now) || isMarketOpen('BSE', now) || isMarketOpen('MCX', now);

serviceSupervisor.setLogger(logger);
const timerService = (name: string, start: () => unknown, opts: Partial<ServiceSpec> = {}): ServiceSpec => ({
  name, critical: false, startupTimeoutMs: 30_000, heartbeatIntervalMs: 0, kind: 'TIMER', start, ...opts,
});
for (const spec of [
  timerService('alertScanner', () => startAlertScanner(provider)),
  timerService('patternScanner', () => startPatternScanner(provider)),
  timerService('institutionalFlowScanner', () => startInstitutionalFlowScanner(provider)),
  timerService('tradeSetupPriceMonitor', () => startTradeSetupPriceMonitor(provider, subscriptionManager), { critical: true, ready: () => recoveryReady }),
  timerService('marketScanner', () => startMarketScanner(provider)),
  timerService('fiiDiiTracker', () => startFiiDiiTracker()),
  timerService('abandonedSetupSweep', () => startAbandonedSetupSweep()),
  timerService('oiCloseSnapshot', () => startOiCloseSnapshot(provider)),
  timerService('cacheWarmer', () => startCacheWarmer(provider)),
  timerService('strategyTracker', () => startStrategyTracker(provider)),
  timerService('positionalStockScan', () => startPositionalStockScan(provider)),
  // Non-NSE dashboard symbols (SENSEX, CRUDEOIL, GOLD by default) evaluated on a timer — flag BACKGROUND_BIAS.
  timerService('backgroundBiasEvaluator', () => startBackgroundBiasEvaluator(provider)),
  timerService('marketStateCapture', () => startMarketStateCapture(provider), { ready: () => schemaReady }),
  timerService('missedWinnerAudit', () => startMissedWinnerAudit(provider), { ready: () => schemaReady }),
  timerService('setupEventsGrading', () => startSetupEventsGrading(provider), { ready: () => schemaReady }),
  timerService('opportunityCensus', () => startOpportunityCensus(provider), { ready: () => schemaReady }),
  timerService('holidayCalendarCheck', () => startHolidayCalendarCheck()),
  // The self-audit: it can change what the system NOTICES, never what it DOES.
  timerService('systemLearningAudit', () => startSystemLearningAudit(provider)),
  {
    name: 'signalEngine', critical: true, startupTimeoutMs: 5_000, heartbeatIntervalMs: 10 * 60_000, kind: 'COMPONENT' as const, start: () => undefined, activeWhen: anySession,
    note: 'Extra: the bias / signal computation (computeMarketBias) runs from browser polls, marketScanner and backgroundBiasEvaluator — no single one of the 18 represents it. Heartbeat = a completed computation.',
  },
  {
    name: 'setupLifecycle', critical: true, startupTimeoutMs: 5_000, heartbeatIntervalMs: 20 * 60_000, kind: 'COMPONENT' as const, start: () => undefined, activeWhen: (now: number) => isMarketOpen('NSE', now) || isMarketOpen('MCX', now),
    note: 'Extra: the structure lifecycle advance runs inside the signal computation, not as one of the 18. Heartbeat = a completed advance.',
  },
  {
    name: 'orderFlowFeed', critical: false, startupTimeoutMs: 5_000, heartbeatIntervalMs: 5 * 60_000, kind: 'COMPONENT' as const, start: () => startOrderFlowFeed(), activeWhen: orderFlowFeedActive,
    note: 'Extra: the Dhan market-data feed for Order Flow (OF1 shadow) — data only, never orders. Active only with DHAN credentials during the NSE session. Heartbeat = a feed packet.',
  },
] satisfies ServiceSpec[]) serviceSupervisor.register(spec);
void serviceSupervisor.startAll();

const authRefreshTimer = setInterval(() => {
  const { apiKey, clientId, password, totpSecret } = config.angelOne;
  if (!apiKey || !clientId || !password) return;

  // Gating this on isAuthenticated() meant a session that had already
  // expired (e.g. because the previous scheduled attempt silently failed)
  // never got retried — isAuthenticated() would just keep returning false
  // forever. Always attempt something: refresh if the current token is
  // still technically valid, otherwise a full fresh TOTP login.
  // Phase 5: retried with backoff, alerted when every attempt fails, and on
  // success the tick feed reconnects with the new feed token — every token
  // re-subscribed and RECOVERING until its switchover gap is checked.
  void refreshAuthWithRetry({
    attempt: () => (provider.isAuthenticated() ? provider.refreshAuth() : provider.authenticate({ apiKey, clientId, password, totpSecret })),
    onSuccess: () => subscriptionManager.refreshConnection(),
    alert: (message) => notifyOperationalAlert(message),
    log: logger,
  });
}, TOKEN_REFRESH_INTERVAL_MS);

// --- Graceful Shutdown ---

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down...');

  // Phase 6 order: the supervisor and every service timer first, then the
  // HTTP server, the upstream WS, the broker session, Postgres, Redis.
  serviceSupervisor.stopAll();
  clearInterval(authRefreshTimer);

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
