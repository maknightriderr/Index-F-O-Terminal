// ============================================================
// DHAN DAILY CANDLES of the order-flow futures (11 Nov 2026, Setup E1's daily trend)
// ============================================================
// Setup E1 trades with the higher-timeframe (daily) trend, as the strategy it came from. The order-flow store keeps
// only about two sessions after a restart, too few for a daily trend, so each futures contract's own daily candles
// are read once a day from the Dhan Data API (the same subscription as the feed), paced at one call a second, in the
// background. Data only: no order API is called. A contract whose candles could not be read has no daily trend; the
// setup then falls back to the 30-minute trend and records that it did.
// ============================================================

import axios from 'axios';
import { dailyTrend, type DailyTrend } from '@fno/analytics';
import { logger } from '../lib/logger.js';
import { candlesFromDhan, parseRequestTime } from '../providers/dhan/history.js';
import { dhanSession, markDhanTokenRejected } from './dhan-session.js';
import type { ResolvedFlowContract } from '../lib/dhan-feed-packets.js';

export const DHAN_HISTORICAL_URL = 'https://api.dhan.co/v2/charts/historical';
/** One call a second: well inside Dhan's Data API limit, and leaves room for the intraday candle calls. */
export const DHAN_DAILY_SPACING_MS = 1_000;
/** Calendar days of daily candles requested (about 80 sessions; the trend needs 25). */
export const DHAN_DAILY_LOOKBACK_DAYS = 120;

const INSTRUMENT: Record<ResolvedFlowContract['kind'], string> = { INDEX: 'FUTIDX', STOCK: 'FUTSTK', COMMODITY: 'FUTCOM' };
const istDay = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10);

interface Entry { day: string; securityId: string; instrument: string; trend: DailyTrend; bars: number; daily?: Array<{ time: number; open: number; high: number; low: number; close: number }> }
const cache = new Map<string, Entry>();
let running = false;

/** The contract's daily trend as of today's session (completed days only), or null when not read today. */
export function dhanDailyTrend(symbol: string, now: number, instrument?: string | null): { trend: DailyTrend; bars: number } | null {
  const e = cache.get(symbol);
  if (!e || e.day !== istDay(now) || (instrument != null && e.instrument !== instrument)) return null;
  return { trend: e.trend, bars: e.bars };
}

/** The contract's last completed daily candles (oldest first, up to 60) as read today, or [] (Human TA reads its own trend). */
export function dhanDailyBars(symbol: string, now: number): Array<{ time: number; open: number; high: number; low: number; close: number }> {
  const e = cache.get(symbol);
  return e && e.day === istDay(now) ? e.daily ?? [] : [];
}

/** One contract's completed daily candles (before today, IST), oldest first. Throws on an HTTP failure. */
export async function fetchDhanDaily(r: ResolvedFlowContract, now: number): Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>> {
  const session = dhanSession();
  if (!session) throw new Error('DHAN_SESSION_UNAVAILABLE');
  const today = istDay(now), from = istDay(now - DHAN_DAILY_LOOKBACK_DAYS * 86_400_000);
  try {
    const res = await axios.post(DHAN_HISTORICAL_URL, { securityId: r.securityId, exchangeSegment: r.segment, instrument: INSTRUMENT[r.kind], expiryCode: 0, oi: false, fromDate: from, toDate: today }, {
      headers: { 'access-token': session.accessToken, 'client-id': session.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15_000,
    });
    return candlesFromDhan(res.data)
      .map((c) => ({ time: parseRequestTime(c.timestamp) ?? NaN, open: c.open, high: c.high, low: c.low, close: c.close }))
      .filter((b) => Number.isFinite(b.time) && istDay(b.time) < today)
      .sort((a, b) => a.time - b.time);
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) markDhanTokenRejected(session.accessToken);
    throw Object.assign(new Error(err?.message ?? 'DHAN_DAILY_FAILED'), { status: status ?? null });
  }
}

/** Read today's daily trend of every resolved contract not read yet (background; never throws). */
export async function prefetchDhanDaily(resolved: Readonly<Record<string, ResolvedFlowContract>>, now: number, opts: { spacingMs?: number; fetch?: typeof fetchDhanDaily } = {}): Promise<{ read: number; failed: number; counts: Record<string, number> } | null> {
  if (running) return null;
  running = true;
  const fetch = opts.fetch ?? fetchDhanDaily, spacing = opts.spacingMs ?? DHAN_DAILY_SPACING_MS, day = istDay(now);
  let read = 0, failed = 0;
  const counts: Record<string, number> = {};
  try {
    for (const [symbol, r] of Object.entries(resolved)) {
      const have = cache.get(symbol);
      if (have && have.day === day && have.securityId === r.securityId) continue;
      try {
        const bars = await fetch(r, now);
        const trend = dailyTrend(bars);
        cache.set(symbol, { day, securityId: r.securityId, instrument: r.tradingSymbol, trend, bars: bars.length, daily: bars.slice(-60) });
        counts[trend] = (counts[trend] ?? 0) + 1;
        read++;
      } catch (err: any) {
        failed++;
        if (err?.status === 401 || err?.status === 403 || err?.message === 'DHAN_SESSION_UNAVAILABLE') { logger.warn({ event: 'dhanDaily', error: err.message }, 'Dhan daily candles: stopped (no usable Dhan session)'); break; }
        if (err?.status === 429) await new Promise((res) => setTimeout(res, 10_000));
      }
      if (spacing) await new Promise((res) => setTimeout(res, spacing));
    }
  } finally {
    running = false;
  }
  logger.info({ event: 'dhanDaily', read, failed, counts }, 'Dhan daily candles: daily trend of the order-flow futures (Setup E1)');
  return { read, failed, counts };
}

/** Tests only. */
export function resetDhanDaily(): void { cache.clear(); running = false; }
