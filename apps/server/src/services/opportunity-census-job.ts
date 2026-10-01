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
// COVERAGE: a session is censused only once it is over (its own session
// window, so MCX's 23:30/23:55 close and partial holidays are honoured) and
// only if setup_events was recording from its open (RECORDING_START_MS).
// Otherwise every opportunity would read NEVER_DETECTED for want of rows, not
// for want of detection. Sessions from the last few days are all eligible, so
// a pass that lands after midnight still censuses the session before it.
// Known gap: a restart mid-session (a deploy takes ~2 min) is not detected;
// transitions in that gap are simply not recorded.
//
// SYMBOL SCOPE: the same five symbols Stage 1's clean test used — NIFTY and
// BANKNIFTY (NSE), SENSEX (BSE), CRUDEOIL and GOLD (MCX) — rather than trying
// to reconstruct the market scanner's full dynamic universe here. Extending
// this list is a config change, not a code change (see WATCHED_SYMBOLS).
//
// Instrumentation only, read-only for every decision path. A write failure
// here is logged, never silently caught, and never affects trading.
// ============================================================

import { getSessionWindow, type Exchange } from '@fno/shared';
import {
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  detectMajorMoves,
  diagnoseMajorMove,
  classifySessionCoverage,
  inRecordingGap,
  TRIGGER_REGISTRY,
  type MomentumSeries,
  type MomentumBar,
  type SeriesContext,
  type SessionCoverage,
} from '@fno/analytics';
import { decisionAllowed } from '../research/multipath.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken } from './option-chain.js';
import { buildOppBars, clusterWindows, type OppWindow } from '../research/opportunity-census.js';
import { STRATEGY_VERSION, TRIGGER_VERSION, LOGIC_VERSION, EVENT_ENGINE_VERSION } from '../config/trading-flags.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const TICK_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;
const BAR_MS_15M = 15 * 60 * 1000;
const LOOKBACK_DAYS = 45; // ATR14, and the 20-session average range the major-move diagnostic needs
/** How many IST calendar days back a pass looks for sessions not yet censused. */
const PENDING_DAYS = 4;
/** Lets the session's final 15m bar land before the census reads it. */
const SETTLE_AFTER_CLOSE_MS = 5 * 60 * 1000;

/**
 * setup_events started recording when PR #12 deployed (30 Sep 2026, 18:50 IST).
 * A session that opened before this has nothing to match against.
 */
export const RECORDING_START_MS = Date.parse('2026-09-30T13:20:52Z');

interface WatchedSymbol {
  symbol: string;
  exchange: Exchange;
  group: 'NSE_BSE' | 'MCX';
}

const WATCHED_SYMBOLS: WatchedSymbol[] = [
  { symbol: 'NIFTY', exchange: 'NSE', group: 'NSE_BSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE', group: 'NSE_BSE' },
  { symbol: 'SENSEX', exchange: 'BSE', group: 'NSE_BSE' },
  { symbol: 'CRUDEOIL', exchange: 'MCX', group: 'MCX' },
  { symbol: 'GOLD', exchange: 'MCX', group: 'MCX' },
];

const istDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * The IST session dates from the last PENDING_DAYS days that are over,
 * were recorded from their open, and aren't in `done` (already censused).
 * Oldest first. Pure.
 */
export function pendingSessions(exchange: Exchange, now: number, done: ReadonlySet<string>, recordingStart = RECORDING_START_MS): string[] {
  const out: string[] = [];
  for (let back = PENDING_DAYS - 1; back >= 0; back--) {
    const date = istDate(now - back * 24 * 60 * 60 * 1000);
    if (done.has(date)) continue;
    const w = getSessionWindow(exchange, date);
    if (!w) continue; // weekend or full holiday
    if (w.open < recordingStart) continue; // not recorded from the open
    if (now < w.close + SETTLE_AFTER_CLOSE_MS) continue; // still trading, or the last bar hasn't landed
    out.push(date);
  }
  return out;
}

/**
 * Of the day's opportunities the data could judge, the share actually
 * traded. Late and rejected detections are not captures; opportunities in a
 * data gap are left out of the denominator.
 */
export function captureRate(opportunities: number, traded: number, dataGap = 0): number | null {
  const covered = opportunities - dataGap;
  return covered > 0 ? traded / covered : null;
}

/**
 * One opportunity window's class. A window nothing matched is NEVER_DETECTED
 * only when the data was there to detect it: in an uncovered session or a
 * recording gap it is DATA_GAP. Pure.
 */
export function classifyWindow(args: { traded: boolean; detected: boolean; late: boolean; sessionCoverage: SessionCoverage; inGap: boolean }): string {
  if (args.traded) return 'TRADED';
  if (args.detected) return 'DETECTED_BUT_REJECTED';
  if (args.late) return 'DETECTED_LATE';
  if (args.sessionCoverage === 'UNCOVERED' || args.sessionCoverage === 'DATA_GAP' || args.inGap) return 'DATA_GAP';
  return 'NEVER_DETECTED';
}

let started = false;

/** One row per boot: a boot inside a session marks a recording gap for the coverage check. */
async function recordRecorderBoot(): Promise<void> {
  await sql`INSERT INTO recorder_boots (boot_at, logic_version) VALUES (NOW(), ${LOGIC_VERSION})`.catch((err: any) => logger.error({ error: err.message }, 'recorder_boots: insert failed'));
}

export function startOpportunityCensus(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  void recordRecorderBoot();
  const tick = () => {
    void runCensusPass(provider).catch((err: any) => logger.warn({ error: err.message }, 'Opportunity census: pass failed'));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, INITIAL_DELAY_MS);
  logger.info({ intervalMinutes: TICK_MS / 60000 }, 'Opportunity census started');
}

async function runCensusPass(provider: MarketDataProvider): Promise<void> {
  const now = Date.now();
  for (const sym of WATCHED_SYMBOLS) {
    try {
      // Idempotent: a session censused once is final (it was only censused after its close).
      const doneRows = await sql<{ d: string }[]>`
        SELECT session_date::text AS d FROM opportunity_census_daily
        WHERE instrument = ${sym.symbol} AND exchange = ${sym.exchange} AND session_date >= ${istDate(now - PENDING_DAYS * 24 * 60 * 60 * 1000)}
      `;
      const pending = pendingSessions(sym.exchange, now, new Set(doneRows.map((r) => r.d)));
      if (pending.length > 0) await censusSymbol(provider, sym, pending);
    } catch (err: any) {
      logger.warn({ error: err.message, symbol: sym.symbol, exchange: sym.exchange }, 'Opportunity census: symbol failed');
    }
  }
}

async function censusSymbol(provider: MarketDataProvider, sym: WatchedSymbol, sessions: string[]): Promise<void> {
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
  const loaded = { series, masked: new Set<string>() } as unknown as Parameters<typeof buildOppBars>[0];
  const allOppBars = buildOppBars(loaded, BAR_MS_15M);

  const ctx = buildSeriesContext(series);
  for (const session of sessions) {
    // No bars: an unlisted holiday, or the feed hasn't caught up. Retried next pass.
    const s = series.sessionDates.indexOf(session);
    if (s < 0) continue;
    await censusSession(sym, session, allOppBars.filter((b) => b.session === session), ctx, s);
  }
}

async function censusSession(sym: WatchedSymbol, today: string, oppBars: ReturnType<typeof buildOppBars>, ctx: SeriesContext, s: number): Promise<void> {
  const windows2R = clusterWindows(sym.symbol, oppBars, 2);
  const series = ctx.series;
  const start = series.sessionStarts[s];
  const end = ctx.sessionEnd(s);

  const setupRows = await sql<{ time: Date; lifecycle_id: string; direction: string; event_type: string; decision: string; cost_quality: string | null }[]>`
    SELECT time, lifecycle_id, direction, event_type, decision, cost_quality FROM setup_events
    WHERE instrument = ${sym.symbol} AND exchange = ${sym.exchange} AND time >= ${new Date(`${today}T00:00:00+05:30`)} AND time < ${new Date(`${today}T23:59:59+05:30`)}
      -- What the live engines did: SHADOW trigger-family candidates are measured separately, never counted as a detection.
      AND decision IS DISTINCT FROM 'SHADOW'
    ORDER BY time ASC
  `;

  // ---- Data quality first: was there valid data and a running recorder? ----
  const window = getSessionWindow(sym.exchange, today);
  const boots = window
    ? (await sql<{ boot_at: Date }[]>`SELECT boot_at FROM recorder_boots WHERE boot_at >= ${new Date(window.open - 30 * 86_400_000)} AND boot_at <= ${new Date(window.close)} ORDER BY boot_at`).map((r) => new Date(r.boot_at).getTime())
    : [];
  const cov = window ? classifySessionCoverage({ sessionOpen: window.open, sessionClose: window.close, barMs: BAR_MS_15M, bars: series.bars.slice(start, end + 1), boots }) : null;
  const sessionCoverage: SessionCoverage = cov?.coverage ?? 'UNCOVERED';
  const qualities = setupRows.reduce<Record<string, number>>((acc, r) => ((acc[r.cost_quality ?? 'UNAVAILABLE'] = (acc[r.cost_quality ?? 'UNAVAILABLE'] ?? 0) + 1), acc), {});
  const optionDataStatus = setupRows.length === 0 ? 'NO_SETUPS' : Object.entries(qualities).map(([k, v]) => `${k}:${v}`).join(',');

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

    const matched: (typeof setupRows)[number] | null | undefined = traded ?? detected ?? lateCandidate;
    const classification = classifyWindow({
      traded: !!traded,
      detected: !!detected,
      late: !!lateCandidate,
      sessionCoverage,
      inGap: cov ? inRecordingGap(windowStart, cov.gaps, BAR_MS_15M) : true,
    });

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
  const dataGap = batch.filter((b) => b.classification === 'DATA_GAP').length;
  const correctlyEmpty = opportunities === 0 && setupRows.length === 0 && sessionCoverage === 'COVERED';

  await sql`
    INSERT INTO opportunity_census_daily (
      session_date, instrument, exchange, opportunities, traded, rejected, late, never_detected, capture_rate, correctly_empty,
      coverage, session_start, session_end, recording_start, recording_end, expected_bars, present_bars, missing_bars, stale_bars, data_gap, option_data_status
    ) VALUES (
      ${today}, ${sym.symbol}, ${sym.exchange}, ${opportunities}, ${traded}, ${rejected}, ${late}, ${never}, ${captureRate(opportunities, traded, dataGap)}, ${correctlyEmpty},
      ${sessionCoverage}, ${cov ? new Date(cov.sessionStart) : null}, ${cov ? new Date(cov.sessionEnd) : null},
      ${cov?.recordingStart != null ? new Date(cov.recordingStart) : null}, ${cov?.recordingEnd != null ? new Date(cov.recordingEnd) : null},
      ${cov?.expectedBars ?? null}, ${cov?.presentBars ?? null}, ${cov?.missingBars ?? null}, ${cov?.staleBars ?? null}, ${dataGap}, ${optionDataStatus}
    )
    ON CONFLICT (session_date, instrument, exchange) DO UPDATE SET
      opportunities = EXCLUDED.opportunities, traded = EXCLUDED.traded, rejected = EXCLUDED.rejected,
      late = EXCLUDED.late, never_detected = EXCLUDED.never_detected, capture_rate = EXCLUDED.capture_rate,
      correctly_empty = EXCLUDED.correctly_empty, coverage = EXCLUDED.coverage, data_gap = EXCLUDED.data_gap, computed_at = NOW()
  `.catch((err: any) => logger.error({ error: err.message, symbol: sym.symbol }, 'opportunity_census_daily: insert failed'));

  logger.info({ symbol: sym.symbol, exchange: sym.exchange, session: today, coverage: sessionCoverage, opportunities, traded, rejected, late, never, dataGap, correctlyEmpty }, 'Opportunity census: day computed');

  await diagnoseMajorMoves(sym, today, ctx, s, sessionCoverage, setupRows).catch((err: any) => logger.error({ error: err.message, symbol: sym.symbol }, 'major_move_diagnostics: failed'));
}

/**
 * Post-session, RESEARCH status: the event engine and the research triggers
 * run over the session to explain any major move — what started it, which
 * family recognised it, the first actionable point, and whether the live
 * engine traded it. Written to major_move_diagnostics; read by nothing that
 * decides a trade.
 */
async function diagnoseMajorMoves(sym: WatchedSymbol, today: string, ctx: SeriesContext, s: number, sessionCoverage: SessionCoverage, setupRows: Array<{ time: Date; direction: string; decision: string }>): Promise<void> {
  const series = ctx.series;
  const start = series.sessionStarts[s];
  const end = ctx.sessionEnd(s);
  const moves = detectMajorMoves(series, s, end, ctx.adrAt(s));
  if (moves.length === 0) return;
  const log = runSessionEvents(ctx, s);
  const research = TRIGGER_REGISTRY.filter((t) => t.status !== 'RETIRED').map((t) => t.triggerId);
  const candidates = [];
  for (let i = start; i <= end; i++) if (decisionAllowed(sym.exchange, today, series.bars[i].time)) candidates.push(...evaluateTriggersAt(ctx, log, i, research));
  for (const move of moves) {
    const from = series.bars[move.startIndex].time;
    const to = series.bars[move.endIndex].time + BAR_MS_15M;
    const traded = setupRows.some((r) => r.decision === 'TRADED' && r.direction === move.direction && r.time.getTime() >= from && r.time.getTime() <= to);
    const d = diagnoseMajorMove({ move, coverage: sessionCoverage, events: log.events, candidates, traded });
    await sql`
      INSERT INTO major_move_diagnostics (
        session_date, instrument, exchange, direction, start_time, end_time, start_price, end_price, size_adr,
        classification, coverage, first_event_type, first_event_time, families_recognized, first_actionable, traded, reason, engine_version
      ) VALUES (
        ${today}, ${sym.symbol}, ${sym.exchange}, ${move.direction}, ${new Date(from)}, ${new Date(to)}, ${move.startPrice}, ${move.endPrice}, ${move.sizeAdr},
        ${d.classification}, ${sessionCoverage}, ${d.firstEvent?.type ?? null}, ${d.firstEvent ? new Date(series.bars[d.firstEvent.barIndex].time + BAR_MS_15M) : null},
        ${sql.json(d.familiesRecognized as never)}, ${d.firstActionable ? sql.json({ ...d.firstActionable, decisionTime: series.bars[d.firstActionable.decisionIndex].time + BAR_MS_15M } as never) : null},
        ${traded}, ${d.reason}, ${EVENT_ENGINE_VERSION}
      )
      ON CONFLICT (session_date, instrument, exchange, direction) DO UPDATE SET
        classification = EXCLUDED.classification, coverage = EXCLUDED.coverage, families_recognized = EXCLUDED.families_recognized,
        first_actionable = EXCLUDED.first_actionable, traded = EXCLUDED.traded, reason = EXCLUDED.reason, computed_at = NOW()
    `;
    logger.info({ symbol: sym.symbol, session: today, direction: move.direction, sizeAdr: move.sizeAdr, classification: d.classification }, 'Major move diagnosed');
  }
}

export type { OppWindow };
