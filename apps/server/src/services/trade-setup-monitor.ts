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
// Deliberately lightweight: scans for locked setups and fetches only
// their option chain (quotes, cached ~10s server-side) for each — never
// buildMarketBias's 15m+1h historical candles, which Angel One
// rate-limits far more strictly (see alerts.ts's own "Trade Setup
// closed" check, which avoids buildMarketBias for the identical reason).
//
// Two layers now:
// 1. Every 90s, every locked setup (INTRADAY and POSITIONAL) is checked
//    against its own contract's chain LTP.
// 2. Between those sweeps, each open naked long's option token is
//    subscribed on the shared tick feed, and a tick at or through its SL
//    or target triggers the check immediately with that tick's price. A
//    90s poll alone let exits land well past the stop (NIFTY PE -1.46R,
//    CRUDEOIL CE -1.52R against a -1R stop).
// 3. The BIAS behind each open setup is re-read on a schedule, during its
//    exchange's session. A bias-reversal exit only ever happened when
//    something else computed that symbol's bias — a browser tab or a
//    scanner — so a CRUDEOIL or SENSEX setup whose tab was closed never
//    exited on a reversal at all, only on SL/target or the session end.
//    The recheck runs the same buildMarketBias path, so exits, fresh
//    setups and notifications behave exactly as an on-screen poll would.
// ============================================================

import { FO_SEGMENT, minutesSinceSessionOpen } from '@fno/shared';
import type { Exchange, Tick, TradingMode } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { buildMarketBias, checkLockedSetupPriceLevels, lastBiasComputedAt } from './market-bias.js';
import type { LockedSetupWatch } from './market-bias.js';
import type { MarketDataProvider } from '../providers/interface.js';
import type { SubscriptionManager, SubscriptionTarget } from '../lib/subscription-manager.js';

// Tighter than the institutional scanner's 15 minutes, and independent of
// whether any browser happens to be polling — still comfortably clear of
// the historical-endpoint rate limit since this path never touches it.
const MONITOR_INTERVAL_MS = 90_000;
const INITIAL_DELAY_MS = 45_000;
const TICK_CLIENT_ID = 'trade-setup-monitor';

// Bias recheck cadence for open setups. A reversal exit needs a second
// confident opposite read at least ~90s after the first, so once one has
// started (reversalStreak > 0) the symbol is re-read sooner. Positional
// reversals need hours to confirm, so their recheck is relaxed. Skipped
// whenever anyone else computed the bias more recently than this.
const BIAS_RECHECK_MS = 5 * 60_000;
const BIAS_RECHECK_PENDING_REVERSAL_MS = 2 * 60_000;
const BIAS_RECHECK_POSITIONAL_MS = 15 * 60_000;

let monitorStarted = false;
let sweepRunning = false;
// token -> what to watch; replaced wholesale on each sweep
let watchesByToken = new Map<string, LockedSetupWatch>();
// setup keys with a check already running, so a burst of ticks through a
// stop triggers one close, not dozens
const inFlight = new Set<string>();

const setupKey = (w: { exchange: Exchange; underlying: string; mode: TradingMode }) => `${w.exchange}:${w.underlying}:${w.mode}`;
const targetFor = (w: LockedSetupWatch): SubscriptionTarget => ({ token: w.token, exchange: w.exchange, exchangeSegment: FO_SEGMENT[w.exchange] });

export function startTradeSetupPriceMonitor(provider: MarketDataProvider, subscriptions?: SubscriptionManager): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const tick = () => {
    runMonitor(provider, subscriptions).catch((err) => logger.error({ error: err.message }, 'Trade setup price monitor tick failed'));
  };

  if (subscriptions) {
    subscriptions.onTick((ticks) => onTicks(provider, subscriptions, ticks));
  }

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, MONITOR_INTERVAL_MS);
  logger.info({ intervalMs: MONITOR_INTERVAL_MS, liveTicks: !!subscriptions }, 'Trade setup price-level monitor started');
}

async function runMonitor(provider: MarketDataProvider, subscriptions?: SubscriptionManager): Promise<void> {
  if (!provider.isAuthenticated()) return;
  // A sweep with several bias rechecks can outlast the 90s interval — never
  // let two overlap.
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await sweep(provider, subscriptions);
  } finally {
    sweepRunning = false;
  }
}

async function sweep(provider: MarketDataProvider, subscriptions?: SubscriptionManager): Promise<void> {
  const next = new Map<string, LockedSetupWatch>();
  const keys = await scanKeys('trade_setup:*');
  for (const key of keys) {
    const parts = key.split(':'); // trade_setup:{exchange}:{underlying}:{mode}
    if (parts.length !== 4) continue;
    const [, exchange, underlying, mode] = parts;
    if (mode !== 'INTRADAY' && mode !== 'POSITIONAL') continue;

    const id = `${exchange}:${underlying}:${mode}`;
    if (inFlight.has(id)) {
      // A tick-triggered check is mid-flight — keep watching what we had.
      for (const w of watchesByToken.values()) if (setupKey(w) === id) next.set(w.token, w);
      continue;
    }

    inFlight.add(id);
    try {
      const watch = await checkLockedSetupPriceLevels(provider, exchange as Exchange, underlying, mode);
      if (watch) next.set(watch.token, watch);
    } catch (err: any) {
      logger.warn({ error: err.message, key }, 'Trade setup price monitor: one symbol check failed');
    } finally {
      inFlight.delete(id);
    }
  }

  await syncSubscriptions(subscriptions, next);
  await recheckBias(provider, keys);
}

async function recheckBias(provider: MarketDataProvider, keys: string[]): Promise<void> {
  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length !== 4) continue;
    const [, exchangeRaw, underlying, modeRaw] = parts;
    if (modeRaw !== 'INTRADAY' && modeRaw !== 'POSITIONAL') continue;
    const exchange = exchangeRaw as Exchange;
    const mode = modeRaw as TradingMode;

    // Only while the exchange is trading — a bias off frozen quotes isn't a
    // reversal, and intraday session-end closes are handled above.
    if (minutesSinceSessionOpen(exchange) == null) continue;

    let stored: { available?: boolean; reversalStreak?: number; generatedAt?: number } | null = null;
    try {
      const raw = await redis.get(key); // re-read: the price check above may have just closed it
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      continue;
    }
    if (!stored?.available) continue;

    const interval =
      mode === 'POSITIONAL' ? BIAS_RECHECK_POSITIONAL_MS : (stored.reversalStreak ?? 0) > 0 ? BIAS_RECHECK_PENDING_REVERSAL_MS : BIAS_RECHECK_MS;
    const last = lastBiasComputedAt(exchange, underlying, mode);
    if (last != null && Date.now() - last < interval) continue;

    const id = `${exchange}:${underlying}:${mode}`;
    if (inFlight.has(id)) continue;
    inFlight.add(id);
    try {
      const { bias, tradeSetup } = await buildMarketBias(provider, underlying, exchange, mode);
      const unchanged = tradeSetup.available && tradeSetup.generatedAt === stored.generatedAt;
      logger.info(
        {
          underlying,
          exchange,
          mode,
          bias: `${bias.direction} ${bias.confidence}`,
          setup: unchanged ? 'held' : tradeSetup.available ? `closed, replaced by ${tradeSetup.side} ${tradeSetup.strike}` : 'closed',
        },
        'Trade setup monitor: bias rechecked for an open setup'
      );
    } catch (err: any) {
      logger.warn({ error: err.message, underlying, exchange, mode }, 'Trade setup monitor: bias recheck failed — will retry next sweep');
    } finally {
      inFlight.delete(id);
    }
  }
}

async function syncSubscriptions(subscriptions: SubscriptionManager | undefined, next: Map<string, LockedSetupWatch>): Promise<void> {
  const previous = watchesByToken;
  watchesByToken = next;
  if (!subscriptions) return;

  const added = [...next.values()].filter((w) => !previous.has(w.token));
  const removed = [...previous.values()].filter((w) => !next.has(w.token));

  if (removed.length > 0) subscriptions.unsubscribe(TICK_CLIENT_ID, removed.map(targetFor));
  if (added.length > 0) {
    try {
      await subscriptions.subscribe(TICK_CLIENT_ID, added.map(targetFor));
    } catch (err: any) {
      // The 90s sweep still covers these; the tick layer only makes it faster.
      logger.warn({ error: err.message, count: added.length }, 'Trade setup price monitor: tick subscription failed — polling only');
    }
  }
}

function onTicks(provider: MarketDataProvider, subscriptions: SubscriptionManager, ticks: Tick[]): void {
  for (const tick of ticks) {
    const watch = watchesByToken.get(tick.token);
    if (!watch || !(tick.ltp > 0)) continue;
    if (tick.ltp > watch.stopLoss && tick.ltp < watch.target) continue;

    const id = setupKey(watch);
    if (inFlight.has(id)) continue;
    inFlight.add(id);

    checkLockedSetupPriceLevels(provider, watch.exchange, watch.underlying, watch.mode, tick.ltp)
      .then((stillOpen) => {
        if (stillOpen) {
          watchesByToken.set(stillOpen.token, stillOpen); // e.g. the stop has since trailed
          return;
        }
        if (watchesByToken.get(watch.token) === watch) {
          watchesByToken.delete(watch.token);
          subscriptions.unsubscribe(TICK_CLIENT_ID, [targetFor(watch)]);
        }
      })
      .catch((err: any) => logger.warn({ error: err.message, underlying: watch.underlying }, 'Trade setup price monitor: tick-triggered check failed'))
      .finally(() => inFlight.delete(id));
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
