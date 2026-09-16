// ============================================================
// OI CLOSE SNAPSHOT
// ============================================================
// Change-in-OI is measured from the previous session's settled OI (see
// lib/oi-baseline.ts), and Angel One never reports that value — it has to
// be read after the session closes. Nothing else reliably does that for
// every contract that matters: option chains are only fetched while
// someone is looking. So a few minutes after each exchange closes, this
// refetches the chains (and futures) of every symbol the bias engine read
// in the last few days; those post-close reads become the next session's
// previous-close baselines.
// ============================================================

import { getLatestSessionWindow } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';

const EXCHANGES: Exchange[] = ['NSE', 'BSE', 'MCX'];
const TICK_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 90_000;
const SETTLE_AFTER_CLOSE_MS = 5 * 60 * 1000; // let the final OI print settle
const RUN_WINDOW_MS = 3 * 60 * 60 * 1000; // a restart after this just leaves the fallback baseline
const MAX_CHAINS_PER_RUN = 40; // most recently read first
const TRACK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const STAGGER_MS = 2500; // quotes/Greeks endpoints are rate-limited — never burst

const trackedKey = (exchange: Exchange) => `oi_snapshot_tracked:${exchange}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registers a chain the bias engine read, so it gets a post-close OI snapshot. Fire-and-forget. */
export function trackSymbolForOiSnapshot(exchange: Exchange, underlying: string, expiry: string): void {
  const now = Date.now();
  const key = trackedKey(exchange);
  void redis
    .zadd(key, now, `${underlying}|${expiry}`)
    .then(() => redis.zremrangebyscore(key, 0, now - TRACK_RETENTION_MS))
    .catch((err: any) => logger.warn({ error: err.message, underlying, exchange }, 'OI close snapshot: tracking write failed'));
}

let started = false;

export function startOiCloseSnapshot(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    runTick(provider).catch((err: any) => logger.error({ error: err.message }, 'OI close snapshot tick failed'));
  };
  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, TICK_MS);
  logger.info({ intervalMs: TICK_MS }, 'OI close snapshot scheduler started');
}

async function runTick(provider: MarketDataProvider): Promise<void> {
  for (const exchange of EXCHANGES) {
    try {
      await snapshotExchange(provider, exchange);
    } catch (err: any) {
      logger.warn({ error: err.message, exchange }, 'OI close snapshot failed for exchange');
    }
  }
}

async function snapshotExchange(provider: MarketDataProvider, exchange: Exchange): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const now = Date.now();
  const session = getLatestSessionWindow(exchange, now);
  if (!session || now < session.close + SETTLE_AFTER_CLOSE_MS || now > session.close + RUN_WINDOW_MS) return;

  // Once per session, even across several server instances or restarts.
  const claimed = await redis.set(`oi_close_snapshot_done:${exchange}:${session.date}`, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
  if (claimed !== 'OK') return;

  const members = await redis.zrevrange(trackedKey(exchange), 0, MAX_CHAINS_PER_RUN - 1);
  let chains = 0;
  const underlyings = new Set<string>();

  for (const member of members) {
    const [underlying, expiry] = member.split('|');
    if (!underlying) continue;
    underlyings.add(underlying);
    try {
      // An expiry that has since lapsed falls back to the nearest listed one
      // inside buildOptionChain — still a useful snapshot.
      await buildOptionChain(provider, underlying, exchange, expiry || undefined);
      chains++;
    } catch (err: any) {
      logger.warn({ error: err.message, underlying, exchange }, 'OI close snapshot: chain refetch failed');
    }
    await sleep(STAGGER_MS);
  }

  let futures = 0;
  for (const underlying of underlyings) {
    try {
      await buildFuturesData(provider, underlying, exchange);
      futures++;
    } catch (err: any) {
      logger.warn({ error: err.message, underlying, exchange }, 'OI close snapshot: futures refetch failed');
    }
    await sleep(STAGGER_MS);
  }

  logger.info({ exchange, session: session.date, chains, futures }, 'OI close snapshot taken — next session measures OI change from these');
}
