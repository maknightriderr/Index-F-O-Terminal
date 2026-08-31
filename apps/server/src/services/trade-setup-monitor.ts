// ============================================================
// TRADE SETUP PRICE-LEVEL MONITOR
// ============================================================
// Runs on its own timer, independent of anyone actually viewing the
// symbol — closes a real gap: SL/target checks otherwise only happen
// on-demand (a user's browser polling that symbol, or the
// NIFTY/BANKNIFTY institutional scanner's 15-minute cadence), so a
// fast intraday touch between checks — or any locked setup on a
// symbol nobody's currently looking at — could resolve and recover
// without ever being detected, leaving a closed position showing as
// still open.
//
// Deliberately lightweight: scans for locked INTRADAY setups and
// fetches only their option chain (quotes, cached ~10s server-side)
// for each — never buildMarketBias's 15m+1h historical candles, which
// Angel One rate-limits far more strictly (see alerts.ts's own
// "Trade Setup closed" check, which avoids buildMarketBias for the
// identical reason).
// ============================================================

import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { checkLockedSetupPriceLevels } from './market-bias.js';
import type { MarketDataProvider } from '../providers/interface.js';
import type { Exchange } from '@fno/shared';

// Tighter than the institutional scanner's 15 minutes, and independent of
// whether any browser happens to be polling — still comfortably clear of
// the historical-endpoint rate limit since this path never touches it.
const MONITOR_INTERVAL_MS = 90_000;
const INITIAL_DELAY_MS = 45_000;

let monitorStarted = false;

export function startTradeSetupPriceMonitor(provider: MarketDataProvider): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const tick = () => {
    runMonitor(provider).catch((err) => logger.error({ error: err.message }, 'Trade setup price monitor tick failed'));
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, MONITOR_INTERVAL_MS);
  logger.info({ intervalMs: MONITOR_INTERVAL_MS }, 'Trade setup price-level monitor started');
}

async function runMonitor(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const keys = await scanKeys('trade_setup:*:*:INTRADAY');
  for (const key of keys) {
    const parts = key.split(':'); // trade_setup:{exchange}:{underlying}:INTRADAY
    if (parts.length !== 4) continue;
    const [, exchange, underlying] = parts;
    try {
      await checkLockedSetupPriceLevels(provider, exchange as Exchange, underlying);
    } catch (err: any) {
      logger.warn({ error: err.message, key }, 'Trade setup price monitor: one symbol check failed');
    }
  }
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}
