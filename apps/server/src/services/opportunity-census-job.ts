// ============================================================
// DAILY OPPORTUNITY CENSUS (Stage 2: signal-diagnostics)
// ============================================================
// A post-session job (NSE/BSE and MCX censused separately, after each
// exchange's own close) that:
//   1. computes the day's objective opportunities per watched symbol,
//      reusing apps/server/src/research/opportunity-census.ts (2R-before-1R
//      from bar t's close) from 15m bars fetched through the provider;
//   2. matches each opportunity window to `setup_events` in the same
//      direction, within +/-2 bars (30 min) of the window's start bar:
//      DETECTED (a setup_events row at/near the window start), DETECTED_LATE
//      (a row exists but only after the +2-bar tolerance), or NEVER_DETECTED;
//   3. classifies each opportunity TRADED / DETECTED_BUT_REJECTED /
//      DETECTED_LATE / NEVER_DETECTED (TRADED wins over REJECTED when a
//      matched setup_events row's decision is TRADED);
//   4. classifies the day CORRECTLY_EMPTY when it had no opportunities at
//      all AND no setup_events row fired for that instrument that day;
//   5. stores per-window rows (opportunity_census) and the per-instrument
//      daily summary (opportunity_census_daily), migration 030.
//
// SYMBOL SCOPE: the same five symbols Stage 1's clean test used — NIFTY and
// BANKNIFTY (NSE), SENSEX (BSE), CRUDEOIL and GOLD (MCX) — rather than trying
// to reconstruct the market scanner's full dynamic universe here. Extending
// this list is a config change, not a code change (see WATCHED_SYMBOLS).
//
// Instrumentation only, read-only for every decision path. A write failure
// here is logged, never silently caught, and never affects trading.
// ============================================================

import type { Exchange } from '@fno/shared';
import { prepareMomentumSeries, type MomentumSeries, type MomentumBar } from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken } from './option-chain.js';
import { buildOppBars, clusterWindows, type OppWindow } from '../research/opportunity-census.js';
import { STRATEGY_VERSION, TRIGGER_VERSION } from '../config/trading-flags.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const TICK_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;
const BAR_MS_15M = 15 * 60 * 1000;
const LOOKBACK_DAYS = 30; // enough history for ATR14 plus the previous session

interface WatchedSymbol {
  symbol: string;
  exchange: Exchange;
  group: 'NSE_BSE' | 'MCX';
  /** IST hour:minute the exchange closes — the census for a session only runs once past this, on the following poll. */
  closeHHMM: string;
}

const WATCHED_SYMBOLS: WatchedSymbol[] = [
  { symbol: 'NIFTY', exchange: 'NSE', group: 'NSE_BSE', closeHHMM: '15:30' },
  { symbol: 'BANKNIFTY', exchange: 'NSE', group: 'NSE_BSE', closeHHMM: '15:30' },
  { symbol: 'SENSEX', exchange: 'BSE', group: 'NSE_BSE', closeHHMM: '15:30' },
  { symbol: 'CRUDEOIL', exchange: 'MCX', group: 'MCX', closeHHMM: '23:30' },
  { symbol: 'GOLD', exchange: 'MCX', group: 'MCX', closeHHMM: '23:30' },
];

let started = false;

export function startOpportunityCensus(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runCensusPass(provider).catch((err: any) => logger.warn({ error: err.message }, 'Opportunity census: pass failed'));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, INITIAL_DELAY_MS);
  logger.info({ intervalMinutes: TICK_MS / 60000 }, 'Opportunity census started');
}

function istNow(): { date: string; hhmm: string } {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())}`, hhmm: `${pad(ist.getHours())}:${pad(ist.getMinutes())}` };
}

async function runCensusPass(provider: MarketDataProvider): Promise<void> {
  const { date: today, hhmm: nowHHMM } = istNow();
  for (const sym of WATCHED_SYMBOLS) {
    if (nowHHMM < sym.closeHHMM) continue; // that exchange hasn't closed yet today
    try {
      await censusOneSymbol(provider, sym, today);
    } catch (err: any) {
      logger.warn({ error: err.message, symbol: sym.symbol, exchange: sym.exchange }, 'Opportunity census: symbol failed');
    }
  }
}

async function censusOneSymbol(provider: MarketDataProvider, sym: WatchedSymbol, today: string): Promise<void> {
  // Idempotent: skip if today's session is already censused for this instrument.
  const already = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM opportunity_census_daily WHERE session_date = ${today} AND instrument = ${sym.symbol} AND exchange = ${sym.exchange}
  `;
  if (Number(already[0]?.n ?? 0) > 0) return;

  const token = await resolveSpotToken(provider, sym.symbol, sym.exchange).catch(() => null);
  if (!token) return;

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => {
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`;
  };
  const candles = await provider.getHistoricalData({ exchange: sym.exchange, token, interval: 'FIFTEEN_MINUTE', fromDate: fmt(from), toDate: fmt(to) });
  if (candles.length === 0) return;

  const bars: MomentumBar[] = candles.map((c) => ({ time: Date.parse(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }));
  const series: MomentumSeries = prepareMomentumSeries(bars);
  const sIdx = series.sessionDates.lastIndexOf(today);
  if (sIdx < 0) return; // no bars for today yet (a holiday, or the feed hasn't caught up)

  const loaded = { series, masked: new Set<string>() } as unknown as Parameters<typeof buildOppBars>[0];
  const oppBars = buildOppBars(loaded, BAR_MS_15M).filter((b) => b.session === today);
  const windows2R = clusterWindows(sym.symbol, oppBars, 2);

  const setupRows = await sql<{ time: Date; lifecycle_id: string; direction: string; event_type: string; decision: string }[]>`
    SELECT time, lifecycle_id, direction, event_type, decision FROM setup_events
    WHERE instrument = ${sym.symbol} AND exchange = ${sym.exchange} AND time >= ${new Date(`${today}T00:00:00+05:30`)} AND time < ${new Date(`${today}T23:59:59+05:30`)}
    ORDER BY time ASC
  `;

  const batch: { classification: string }[] = [];
  const barTolMs = 2 * BAR_MS_15M;
  for (const w of windows2R) {
    const direction = w.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    const windowStart = new Date(w.startTime).getTime();
    const candidates = setupRows.filter((r) => r.direction === direction && Math.abs(r.time.getTime() - windowStart) <= barTolMs);
    const traded = candidates.find((r) => r.decision === 'TRADED');
    const detected = candidates.find((r) => r.decision !== 'WATCH');
    const lateCandidate = !detected
      ? setupRows.find((r) => r.direction === direction && r.time.getTime() > windowStart + barTolMs && r.time.getTime() <= windowStart + barTolMs + 4 * BAR_MS_15M)
      : null;

    let classification: string;
    let matched: (typeof setupRows)[number] | null | undefined = traded ?? detected ?? lateCandidate;
    if (traded) classification = 'TRADED';
    else if (detected) classification = 'DETECTED_BUT_REJECTED';
    else if (lateCandidate) classification = 'DETECTED_LATE';
    else classification = 'NEVER_DETECTED';

    batch.push({ classification });
    await sql`
      INSERT INTO opportunity_census (
        session_date, instrument, exchange, direction, window_start_bar_time, window_end_bar_time,
        atr15, reached_2r, reached_neg1r, matched_lifecycle_id, matched_event_type, bars_to_match,
        classification, strategy_version, trigger_version
      ) VALUES (
        ${today}, ${sym.symbol}, ${sym.exchange}, ${direction}, ${new Date(w.startTime)}, ${new Date(new Date(w.startTime).getTime() + BAR_MS_15M)},
        ${oppBars.find((b) => b.index === w.startIndex)?.atr ?? null}, true, false, ${matched?.lifecycle_id ?? null}, ${matched?.event_type ?? null},
        ${matched ? Math.round((matched.time.getTime() - windowStart) / BAR_MS_15M) : null},
        ${classification}, ${STRATEGY_VERSION}, ${TRIGGER_VERSION}
      )
      ON CONFLICT (session_date, instrument, exchange, direction, window_start_bar_time) DO NOTHING
    `.catch((err: any) => logger.error({ error: err.message, symbol: sym.symbol }, 'opportunity_census: insert failed'));
  }

  const opportunities = batch.length;
  const traded = batch.filter((b) => b.classification === 'TRADED').length;
  const rejected = batch.filter((b) => b.classification === 'DETECTED_BUT_REJECTED').length;
  const late = batch.filter((b) => b.classification === 'DETECTED_LATE').length;
  const never = batch.filter((b) => b.classification === 'NEVER_DETECTED').length;
  const captureRate = opportunities > 0 ? (traded + late) / opportunities : null;
  const correctlyEmpty = opportunities === 0 && setupRows.length === 0;

  await sql`
    INSERT INTO opportunity_census_daily (session_date, instrument, exchange, opportunities, traded, rejected, late, never_detected, capture_rate, correctly_empty)
    VALUES (${today}, ${sym.symbol}, ${sym.exchange}, ${opportunities}, ${traded}, ${rejected}, ${late}, ${never}, ${captureRate}, ${correctlyEmpty})
    ON CONFLICT (session_date, instrument, exchange) DO UPDATE SET
      opportunities = EXCLUDED.opportunities, traded = EXCLUDED.traded, rejected = EXCLUDED.rejected,
      late = EXCLUDED.late, never_detected = EXCLUDED.never_detected, capture_rate = EXCLUDED.capture_rate,
      correctly_empty = EXCLUDED.correctly_empty, computed_at = NOW()
  `.catch((err: any) => logger.error({ error: err.message, symbol: sym.symbol }, 'opportunity_census_daily: insert failed'));

  logger.info({ symbol: sym.symbol, exchange: sym.exchange, opportunities, traded, rejected, late, never, correctlyEmpty }, 'Opportunity census: day computed');
}

export type { OppWindow };
