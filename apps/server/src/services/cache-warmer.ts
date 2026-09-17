// ============================================================
// CACHE WARMER
// ============================================================
// The slowest reads in the terminal were slow only when cold: after a
// restart, or once a short cache lapsed with nobody polling. Measured on
// 17 Sep: F&O universe scan 16-20s, CRUDEOIL intraday bias 16-23s,
// BANKNIFTY positional bias 13-21s — against well under 1s warm.
//
// This keeps the expensive INPUTS warm, never the reads themselves:
//   - the F&O universe scan, refreshed before its in-session TTL lapses and
//     once at boot;
//   - the historical candles a bias read needs (loadBiasCandles, the same
//     cache keys and TTLs), for the Dashboard's instruments and for any
//     symbol/mode someone requested a bias for in the last 30 minutes.
// It never computes a bias: a bias read mints trade setups and advances
// the vote hold state, so running one on a timer would change trading
// behaviour, not just speed. Work is sequential and runs in the normal
// request lane, behind interactive requests, and only while each exchange
// is trading (or about to open).
// ============================================================

import { isMarketOpen, getSessionWindow } from '@fno/shared';
import type { Exchange, TradingMode } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { refreshFnoScan } from './fno-scanner.js';
import { loadBiasCandles } from './market-bias.js';

const TICK_MS = 30_000;
const INITIAL_DELAY_MS = 45_000;
const SCAN_REFRESH_EVERY_MS = 150_000; // the in-session scan TTL is 180s
const PRE_OPEN_WARM_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_RECENT_TARGETS = 8;
const recentKey = (mode: TradingMode) => `bias_recent:${mode}`;

// The Dashboard's instrument switcher — polled by anyone with it open.
const DEFAULT_TARGETS: Array<{ symbol: string; exchange: Exchange }> = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
  { symbol: 'FINNIFTY', exchange: 'NSE' },
  { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'CRUDEOIL', exchange: 'MCX' },
  { symbol: 'GOLD', exchange: 'MCX' },
];

/** Records that someone asked for this bias, so its inputs stay warm for a while. Fire-and-forget. */
export function noteBiasRequest(symbol: string, exchange: Exchange, mode: TradingMode): void {
  const now = Date.now();
  const key = recentKey(mode);
  void redis
    .zadd(key, now, `${exchange}|${symbol}`)
    .then(() => redis.zremrangebyscore(key, 0, now - RECENT_WINDOW_MS))
    .catch(() => undefined);
}

function tradingSoon(exchange: Exchange, now = Date.now()): boolean {
  if (isMarketOpen(exchange, now)) return true;
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const session = getSessionWindow(exchange, today);
  return !!session && now < session.open && now >= session.open - PRE_OPEN_WARM_MS;
}

let started = false;
let running = false;
let lastScanRefresh = 0;

export function startCacheWarmer(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = (boot: boolean) => {
    if (running) return;
    running = true;
    warm(provider, boot)
      .catch((err: any) => logger.warn({ error: err.message }, 'Cache warmer tick failed'))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => tick(true), INITIAL_DELAY_MS);
  setInterval(() => tick(false), TICK_MS);
  logger.info({ intervalMs: TICK_MS }, 'Cache warmer started');
}

async function warm(provider: MarketDataProvider, boot: boolean): Promise<void> {
  if (!provider.isAuthenticated()) return;
  const now = Date.now();

  // Universe scan: once at boot whatever the time (off-session it then lives
  // 30 minutes), and ahead of expiry while NSE trades.
  if (boot || (isMarketOpen('NSE', now) && now - lastScanRefresh >= SCAN_REFRESH_EVERY_MS)) {
    try {
      const rows = await refreshFnoScan(provider, 'NSE');
      lastScanRefresh = Date.now();
      if (boot) logger.info({ rows }, 'Cache warmer: F&O universe scan warmed');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Cache warmer: F&O scan refresh failed');
    }
  }

  const targets: Array<{ symbol: string; exchange: Exchange; mode: TradingMode }> = DEFAULT_TARGETS.map((t) => ({ ...t, mode: 'INTRADAY' }));
  for (const mode of ['INTRADAY', 'POSITIONAL'] as const) {
    const members = await redis.zrevrangebyscore(recentKey(mode), '+inf', now - RECENT_WINDOW_MS, 'LIMIT', 0, MAX_RECENT_TARGETS).catch(() => [] as string[]);
    for (const member of members) {
      const [exchange, symbol] = member.split('|') as [Exchange, string];
      if (symbol && !targets.some((t) => t.symbol === symbol && t.exchange === exchange && t.mode === mode)) {
        targets.push({ symbol, exchange, mode });
      }
    }
  }

  for (const t of targets) {
    if (!boot && !tradingSoon(t.exchange, now)) continue;
    try {
      // Cache hits inside return immediately; only lapsed series are refetched.
      await loadBiasCandles(provider, t.symbol, t.exchange, t.mode === 'POSITIONAL');
    } catch (err: any) {
      logger.warn({ error: err.message, symbol: t.symbol, mode: t.mode }, 'Cache warmer: candle warm failed');
    }
  }
}
