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
//
// It runs a second time shortly before each session opens. A symbol first
// read after the post-close run (a late view, an evening scanner pass) would
// otherwise start the next session on the first-seen fallback; before the
// open the quotes still carry the previous session's settled OI, so a read
// then is just as valid a baseline.
// ============================================================

import { getLatestSessionWindow, getSessionWindow } from '@fno/shared';
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
// Any time before the next session opens: once it does, getLatestSessionWindow
// returns the NEW session and the run is skipped, so this bound only guards
// against acting on a session long past. A late deploy or restart still
// catches the snapshot.
const RUN_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_CHAINS_PER_RUN = 40; // most recently read first
const TRACK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const STAGGER_MS = 2500; // quotes/Greeks endpoints are rate-limited — never burst
const PRE_OPEN_LEAD_MS = 40 * 60 * 1000; // pre-open run window: from 40 min before the open until it

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
      await snapshotAfterClose(provider, exchange);
      await snapshotBeforeOpen(provider, exchange);
    } catch (err: any) {
      logger.warn({ error: err.message, exchange }, 'OI close snapshot failed for exchange');
    }
  }
}

async function snapshotAfterClose(provider: MarketDataProvider, exchange: Exchange): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const now = Date.now();
  const session = getLatestSessionWindow(exchange, now);
  if (!session || now < session.close + SETTLE_AFTER_CLOSE_MS || now > session.close + RUN_WINDOW_MS) return;

  // Once per session, even across several server instances or restarts.
  const claimed = await redis.set(`oi_close_snapshot_done:${exchange}:${session.date}`, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
  if (claimed !== 'OK') return;

  await refetchTracked(provider, exchange, `after the ${session.date} close`);
}

async function snapshotBeforeOpen(provider: MarketDataProvider, exchange: Exchange): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const now = Date.now();
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const upcoming = getSessionWindow(exchange, today);
  if (!upcoming || now >= upcoming.open || now < upcoming.open - PRE_OPEN_LEAD_MS) return;

  const claimed = await redis.set(`oi_preopen_snapshot_done:${exchange}:${today}`, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
  if (claimed !== 'OK') return;

  await refetchTracked(provider, exchange, `before the ${today} open`);
}

async function refetchTracked(provider: MarketDataProvider, exchange: Exchange, when: string): Promise<void> {
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

  logger.info({ exchange, when, chains, futures }, 'OI close snapshot taken — next session measures OI change from these');
}
