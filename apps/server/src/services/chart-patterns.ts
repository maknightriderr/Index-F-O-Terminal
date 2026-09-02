// ============================================================
// CHART PATTERN SCANNER
// ============================================================
// Background job (same shape as alerts.ts's startAlertScanner):
// real swing-point pattern detection (@fno/analytics/patterns)
// across 15m and 1h candles, scoped ONLY to the ~13 symbols the
// Dashboard actually shows — the 5 curated indices plus the
// current top-8 F&O stocks by score (same set, same ordering, as
// the Dashboard's own F&O Activity Scanner panel).
//
// Historical-candle fetches are the endpoint Angel One rate-limits
// hardest (see market-bias.ts) — this is exactly why the scope is
// bounded rather than "every symbol" and why the scan interval is
// much longer than the alert/quote scanners. Each symbol's fetch
// reuses market-bias.ts's own cache key (`hist:{exchange}:{token}:*`),
// so if a user already has that asset's tab open this tick can be a
// free Redis hit instead of a new broker call.
// ============================================================

import { detectPattern } from '@fno/analytics';
import type { DetectedChartPattern, Exchange, HistoricalParams, OHLCV } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken } from './option-chain.js';
import { scanFnoUniverse } from './fno-scanner.js';
import { INDEX_LIST } from './indices.js';
import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const SCAN_INTERVAL_MS = 25 * 60 * 1000; // 25 minutes — deliberately far longer than the 2-minute alert scanner
const INITIAL_DELAY_MS = 45_000;
const HISTORICAL_CACHE_TTL_SECONDS = 90; // matches market-bias.ts's own historical cache TTL — same keys, shared cache
const RESULT_CACHE_TTL_SECONDS = 60 * 60; // survives one missed/slow tick before the Dashboard would show nothing
const RESULT_KEY = 'chart_patterns:latest';
const TOP_FNO_COUNT = 8; // matches the Dashboard's own "top 8 by score" F&O panel
const INTER_CALL_DELAY_MS = 1200; // same stagger market-bias.ts uses between its own two historical calls
const INTER_SYMBOL_DELAY_MS = 500;

let scannerStarted = false;

export function startPatternScanner(provider: MarketDataProvider): void {
  if (scannerStarted) return;
  scannerStarted = true;

  const tick = () => {
    runPatternScan(provider).catch((err) => logger.error({ error: err.message }, 'Chart pattern scan tick failed'));
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, 'Chart pattern scanner started');
}

export async function getCachedPatterns(): Promise<DetectedChartPattern[]> {
  try {
    const raw = await redis.get(RESULT_KEY);
    return raw ? (JSON.parse(raw) as DetectedChartPattern[]) : [];
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Chart pattern cache read failed');
    return [];
  }
}

async function runPatternScan(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const targets = await resolveTargets(provider);
  if (targets.length === 0) return;

  const results: DetectedChartPattern[] = [];

  for (const target of targets) {
    try {
      results.push(...(await scanOneSymbol(provider, target)));
    } catch (err: any) {
      logger.warn({ error: err.message, symbol: target.symbol }, 'Chart pattern scan failed for one symbol');
    }
    await sleep(INTER_SYMBOL_DELAY_MS);
  }

  try {
    await redis.set(RESULT_KEY, JSON.stringify(results), 'EX', RESULT_CACHE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Chart pattern cache write failed');
  }

  logger.info({ symbolsScanned: targets.length, patternsFound: results.length }, 'Chart pattern scan complete');
}

async function resolveTargets(provider: MarketDataProvider): Promise<Array<{ symbol: string; exchange: Exchange }>> {
  let topStocks: Array<{ symbol: string; exchange: Exchange }> = [];
  try {
    // Same cache key alerts.ts's OI/IV check reads — if that tick already
    // warmed it, this is a pure Redis read, not a fresh universe scan.
    const rows = await cached('fno-scanner:NSE', 180, () => scanFnoUniverse(provider, 'NSE'));
    topStocks = rows.slice(0, TOP_FNO_COUNT).map((r) => ({ symbol: r.symbol, exchange: r.exchange }));
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Chart pattern scan: F&O universe unavailable, scanning indices only this tick');
  }

  return [...INDEX_LIST, ...topStocks];
}

async function scanOneSymbol(
  provider: MarketDataProvider,
  target: { symbol: string; exchange: Exchange }
): Promise<DetectedChartPattern[]> {
  const { symbol, exchange } = target;
  const token = await resolveSpotToken(provider, symbol, exchange);

  const now = new Date();
  const toDate = formatAngelDateTime(now);
  const from15m = formatAngelDateTime(new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));
  const from1h = formatAngelDateTime(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  const nonEmpty = (candles: OHLCV[]) => candles.length > 0;

  const candles15m = await cached(
    `hist:${exchange}:${token}:15m`,
    HISTORICAL_CACHE_TTL_SECONDS,
    () => fetchHistoricalWithRetry(provider, { exchange, token, interval: 'FIFTEEN_MINUTE', fromDate: from15m, toDate }),
    nonEmpty
  );
  await sleep(INTER_CALL_DELAY_MS);
  const candles1h = await cached(
    `hist:${exchange}:${token}:1h`,
    HISTORICAL_CACHE_TTL_SECONDS,
    () => fetchHistoricalWithRetry(provider, { exchange, token, interval: 'ONE_HOUR', fromDate: from1h, toDate }),
    nonEmpty
  );

  const byInterval: Array<{ interval: '15m' | '1h'; candles: OHLCV[] }> = [
    { interval: '15m', candles: candles15m },
    { interval: '1h', candles: candles1h },
  ];

  const found: DetectedChartPattern[] = [];
  for (const { interval, candles } of byInterval) {
    if (candles.length < 15) continue;
    const match = detectPattern(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      candles.map((c) => c.volume)
    );
    if (match) {
      found.push({
        symbol,
        exchange,
        interval,
        pattern: match.pattern,
        direction: match.direction,
        confidence: match.confidence,
        detectedAt: Date.now(),
        priceAtDetection: candles[candles.length - 1].close,
      });
    }
  }

  return found;
}

/**
 * getHistoricalData already swallows its own errors and resolves to []
 * rather than throwing (a 403 looks the same as "no data"). One retry
 * after a beat rides out an intermittent rate-limit hit without turning
 * this into an unbounded retry loop against the broker.
 */
async function fetchHistoricalWithRetry(
  provider: MarketDataProvider,
  params: HistoricalParams,
  attempts = 2,
  delayMs = 1500
): Promise<OHLCV[]> {
  for (let i = 0; i < attempts; i++) {
    const candles = await provider.getHistoricalData(params);
    if (candles.length > 0) return candles;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Angel One historical API expects "YYYY-MM-DD HH:mm" in IST. */
function formatAngelDateTime(date: Date): string {
  const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`;
}
