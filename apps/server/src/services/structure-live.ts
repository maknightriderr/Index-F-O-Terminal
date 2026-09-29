// ============================================================
// STRUCTURE ENGINE — live wiring (pure parts)
// ============================================================
// The decisions the live engine makes around the structure lifecycle, kept
// out of market-bias.ts so they are tested without Redis or Postgres:
//
//   - the lifecycle state kept in Redis at structure_setup:{ex}:{u}:{mode}
//     (a separate prefix: it never touches the paper-trade slot
//     trade_setup:* or the scanners that read it), advanced from each poll's
//     closed-bar engine read, with the transitions not yet recorded;
//   - which CONFIRMED lifecycle has just been FILLED — its limit touched by
//     the live price between bar closes, or by the bar that just closed;
//   - the STRUCTURE_SEQUENCE gate at the fill (price still between the stop
//     and T1, and T1 still ≥ 1.5R away from where it fills);
//   - the rows for setup_lifecycle_events and the API/UI view.
//
// Only a fill (ENTRY) can mint a paper trade; before it the lifecycle is
// display and record only.
// ============================================================

import { rejectionCloseFill, STRUCTURE_RULES, STRUCTURE_RULES_5M, TERMINAL_STAGES, type LiquidityPool, type StructureEvaluation, type StructureScore, type StructureSetup, type StructureStage } from '@fno/analytics';
import type { Exchange, StructureBlock, StructureCandleScoreView, StructureLifecycleView, StructurePatternsView, StructurePoolView, StructureTimeframe, TradingMode } from '@fno/shared';
import type { GateDiagnostic } from './gate-diagnostics.js';

export { STRUCTURE_STRATEGY } from './momentum-break-live.js';
export type { StructureTimeframe };
export const STRUCTURE_SETUP_TYPE = 'STRUCTURE_SWEEP_FVG';

// ---- entry timeframe (STRUCTURE_ENTRY_TF) ----

/** Bar length of each entry timeframe. Pools are always read from 15m bars. */
export const STRUCTURE_TF_BAR_MS: Record<StructureTimeframe, number> = { '15m': 15 * 60 * 1000, '5m': 5 * 60 * 1000 };

/** The engine rules for a timeframe (5m: restated in time — STRUCTURE_RULES_5M). */
export function structureRulesFor(timeframe: StructureTimeframe) {
  return timeframe === '5m' ? STRUCTURE_RULES_5M : STRUCTURE_RULES;
}

/**
 * 5m candle cache (loaded only while STRUCTURE_ENTRY_TF = '5m', for
 * structure-enabled INTRADAY symbols). Price and the index's borrowed
 * futures volume share ONE TTL: a volume series outliving the price series
 * would pair a fresh bar with stale (zero) volume.
 */
export const STRUCTURE_5M_PRICE_TTL_SECONDS = 60;
export const STRUCTURE_5M_VOLUME_TTL_SECONDS = STRUCTURE_5M_PRICE_TTL_SECONDS;
/** Calendar days of 5m history: ATR needs 100 bars, the slot-volume baseline ≥ 5 previous sessions. */
export const STRUCTURE_5M_HISTORY_DAYS = 10;

/** The 5m cache keys, beside the 15m ones (hist:{ex}:{token}:15m, hist:{ex}:FO:{fut}:15m). */
export function structure5mCacheKeys(exchange: Exchange, historicalToken: string, volumeFutureToken?: string | null): { price: string; volume: string | null } {
  return {
    price: `hist:${exchange}:${historicalToken}:5m`,
    volume: volumeFutureToken ? `hist:${exchange}:FO:${volumeFutureToken}:5m` : null,
  };
}

/**
 * Real broker requests the 5m loader made, over a sliding minute. `record`
 * returns the rate once a minute (to be logged) and null otherwise, so the
 * log shows the measured load without a line per request.
 */
export class RequestRateMeter {
  private times: number[] = [];
  private total = 0;
  private lastReportAt = -Infinity;
  constructor(private readonly reportEveryMs = 60_000) {}
  record(now: number, n = 1): { perMinute: number; total: number } | null {
    for (let k = 0; k < n; k++) this.times.push(now);
    this.total += n;
    this.times = this.times.filter((t) => now - t < 60_000);
    if (now - this.lastReportAt < this.reportEveryMs) return null;
    this.lastReportAt = now;
    return { perMinute: this.times.length, total: this.total };
  }
}

/** The structure family's session gate: its variant's opening guard and its own closing guard (STRUCTURE_CLOSING_GUARD_MIN). */
export function structureSessionOpts(params: Readonly<{ STRUCTURE_OPENING_GUARD: number; STRUCTURE_CLOSING_GUARD_MIN: number }>): { openingGuard: boolean; closingGuardMinutes: number } {
  return { openingGuard: params.STRUCTURE_OPENING_GUARD >= 1, closingGuardMinutes: params.STRUCTURE_CLOSING_GUARD_MIN };
}
/**
 * The confidence a structure setup is minted and cooldown-checked at. The
 * sequence is binary — sweep, displacement and a filled zone either happened
 * or did not — and the 0-100 score never gates, so it cannot stand in for a
 * confidence (it would make the post-loss 80 floor a score gate). Recorded
 * beside the real score.
 */
export const STRUCTURE_SEQUENCE_CONFIDENCE = 100;

export function structureStateKey(exchange: Exchange, underlying: string, mode: TradingMode): string {
  return `structure_setup:${exchange}:${underlying}:${mode}`;
}

/** 15m ids are unchanged; 5m ids carry a "5m:" segment so no Redis claim/outcome key is ever shared across timeframes. */
export function lifecycleIdOf(exchange: Exchange, underlying: string, setup: Pick<StructureSetup, 'id'>, timeframe: StructureTimeframe = '15m'): string {
  return timeframe === '5m' ? `${exchange}:${underlying}:5m:${setup.id}` : `${exchange}:${underlying}:${setup.id}`;
}

/** One lifecycle as kept in Redis. */
export interface LiveLifecycle {
  id: string;
  direction: 'BULLISH' | 'BEARISH';
  stage: StructureStage;
  /** The entry timeframe the lifecycle ran on (absent on states written before it: 15m). */
  timeframe?: StructureTimeframe;
  /** Transitions of the engine's history already written to setup_lifecycle_events. */
  recorded: number;
  pool: StructurePoolView;
  zone: StructureSetup['zone'];
  entry: number | null;
  stop: number | null;
  t1: { kind: string; price: number } | null;
  t2: { kind: string; price: number } | null;
  rToT1: number | null;
  score: number | null;
  /**
   * The score without the candle-pattern bonus — what fillCandidate orders by,
   * so the bonus never changes which lifecycle is filled. Absent on states
   * written before labels (score then has no bonus in it).
   */
  scoreBase?: number | null;
  /** The candle-pattern points inside `score` (display). */
  scoreCandle?: StructureCandleScoreView | null;
  /** The setup's candles, named (display and records only). */
  patterns?: StructurePatternsView | null;
  sweepExtreme: number;
  atr: number;
  displacementBodyAtr: number | null;
  stageAt: number;
  reason: string | null;
  /** Index of the engine's fill bar (its open time), when the engine saw one. */
  engineFillBarTime: number | null;
  /**
   * When this setup first reached CONFIRMED (the transition's own `at`), from
   * setup.history — which the engine only ever appends to, so this is stable
   * across polls no matter how far the engine's own (touch-based) internal
   * simulation has since moved the stage. STRUCTURE_ENTRY_MODE =
   * 'REJECTION_CLOSE' anchors its fill window here, NOT on `stage`/`stageAt`,
   * so a bar that merely touches the zone (advancing the engine's own shadow
   * ENTRY/ACTIVE/CLOSED simulation) can never stop REJECTION_CLOSE from still
   * recognising a later bar's real rejection close. Null before CONFIRMED.
   */
  confirmedAt: number | null;
  /**
   * STRUCTURE_ENTRY_MODE = 'REJECTION_CLOSE' only: set by rejectionCloseCandidate
   * on the lifecycle it is about to claim — the confirming bar's own close (the
   * real fill price, which is NOT necessarily the live spot at claim time) and
   * the rejection candle's pattern label. Transient (set just before the claim,
   * read once by resolveStructureSetup); not persisted beyond that poll's use.
   */
  rejectionFillPrice?: number;
  rejectionPattern?: { shape: string; label: string };
  /** The live outcome at the fill. */
  live: { outcome: 'MINTED' | 'REFUSED'; reason: string | null; code: string | null; at: number; decisionId?: string | null; signalId?: string | null } | null;
}

export interface LiveState {
  exchange: Exchange;
  underlying: string;
  mode: TradingMode;
  /** IST session date the lifecycles belong to. */
  day: string;
  /** Entry timeframe (absent on states written before it: 15m). A change resets the day's lifecycles. */
  timeframe?: StructureTimeframe;
  /** 5m mode only: the 15m ATR from the closed 15m bars — the option leg's atrPoints (atr is the 5m ATR). */
  poolAtr?: number | null;
  barTime: number | null;
  atr: number | null;
  updatedAt: number;
  watch: { BULLISH: StructurePoolView | null; BEARISH: StructurePoolView | null };
  /** WATCH pools already recorded today (one lifecycle row per direction+pool). */
  watchSeen: string[];
  lifecycles: LiveLifecycle[];
}

/** A row for setup_lifecycle_events. */
export interface LifecycleEventRow {
  lifecycleId: string;
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  direction: 'BULLISH' | 'BEARISH';
  fromState: string | null;
  toState: string;
  reason: string | null;
  /** When the transition happened (the bar close that caused it, or the live fill). */
  at: number;
  poolKind: string | null;
  poolPrice: number | null;
  zone: StructureSetup['zone'];
  entry: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
  score: number | null;
  underlyingPrice: number | null;
  decisionId?: string | null;
  signalId?: string | null;
  /** The setup's candles at this transition (null for WATCH rows). Migration 028. */
  patterns?: StructurePatternsView | null;
  /** The candle-pattern points inside `score`. Migration 028. */
  scoreCandle?: StructureCandleScoreView | null;
}

const poolView = (p: LiquidityPool | null | undefined): StructurePoolView | null => (p ? { kind: p.kind, price: round2(p.price), rank: p.rank } : null);

/** The engine's candle labels as the API/UI and the records carry them. */
export function patternsView(p: StructureSetup['patterns'] | null | undefined): StructurePatternsView | null {
  return p ? { sweepPattern: p.sweepPattern, displacementPattern: p.displacementPattern, combo: p.combo, label: p.label } : null;
}

/** The candle-pattern points inside a score (null before the setup is scored). */
export function scoreCandleView(s: StructureScore | null | undefined): StructureCandleScoreView | null {
  return s?.candle ? { rejection: s.candle.rejection, engulfing: s.candle.engulfing, star: s.candle.star, applied: s.candle.applied } : null;
}

/**
 * Folds this poll's engine read into the Redis state. Pure: returns the next
 * state and every transition not yet recorded (engine transitions, plus one
 * WATCH row per direction and pool per day). A new session date starts from
 * an empty state; a lifecycle's live outcome (minted / refused) is kept.
 * A change of entry timeframe on the same day also starts from empty (the
 * old timeframe's lifecycles are not this engine's): `reset` says so, for
 * the caller to log.
 */
export function advanceLiveState(args: {
  prev: LiveState | null;
  evaluation: StructureEvaluation;
  exchange: Exchange;
  underlying: string;
  mode: TradingMode;
  day: string;
  now: number;
  spot: number | null;
  /** Absent = 15m. */
  timeframe?: StructureTimeframe;
  /** STRUCTURE_ENTRY_MODE, for the CONFIRMED display text only (absent = 'TOUCH', unchanged). */
  entryMode?: 'TOUCH' | 'REJECTION_CLOSE';
}): { state: LiveState; events: LifecycleEventRow[]; reset: { from: StructureTimeframe; to: StructureTimeframe } | null } {
  const { evaluation, exchange, underlying, mode, day, now, spot } = args;
  const timeframe = args.timeframe ?? '15m';
  const barMs = STRUCTURE_TF_BAR_MS[timeframe];
  const sameDay = args.prev != null && args.prev.day === day;
  const prevTimeframe = args.prev?.timeframe ?? '15m';
  const switched = sameDay && prevTimeframe !== timeframe;
  const prev = sameDay && !switched ? args.prev : null;
  const byId = new Map((prev?.lifecycles ?? []).map((l) => [l.id, l]));
  const events: LifecycleEventRow[] = [];
  const lifecycles: LiveLifecycle[] = [];

  for (const setup of evaluation.setups) {
    const id = lifecycleIdOf(exchange, underlying, setup, timeframe);
    const old = byId.get(id);
    const last = setup.history[setup.history.length - 1];
    const lc: LiveLifecycle = {
      id,
      direction: setup.direction,
      stage: setup.stage,
      timeframe,
      recorded: old?.recorded ?? 0,
      pool: poolView(setup.pool)!,
      zone: setup.zone,
      entry: setup.entry,
      stop: setup.stop,
      t1: setup.t1,
      t2: setup.t2,
      rToT1: setup.rToT1,
      score: setup.score?.total ?? null,
      scoreBase: setup.score?.baseTotal ?? null,
      scoreCandle: scoreCandleView(setup.score),
      patterns: patternsView(setup.patterns),
      sweepExtreme: round2(setup.sweep.extreme),
      atr: round2(setup.atr),
      displacementBodyAtr: setup.displacement?.bodyAtr ?? null,
      stageAt: last?.at ?? now,
      // Stable once set — setup.history only ever grows, so this keeps the
      // true CONFIRMED time no matter how far the engine's own (touch-based)
      // shadow simulation has since moved `stage`.
      confirmedAt: setup.history.find((h) => h.stage === 'CONFIRMED')?.at ?? null,
      // CONFIRMED itself carries no engine reason; under REJECTION_CLOSE this
      // is the only fill mode — TOUCH's engine fill is instantaneous enough
      // that CONFIRMED is rarely observed resting, but REJECTION_CLOSE can sit
      // there for several bars while the zone hasn't been rejected yet. Shown
      // until a live outcome is recorded, regardless of the engine's own
      // shadow stage (see confirmedAt above and rejectionCloseCandidate).
      reason:
        last?.reason ??
        (args.entryMode === 'REJECTION_CLOSE' && setup.history.some((h) => h.stage === 'CONFIRMED') && (old?.live ?? null) == null ? 'waiting for rejection candle at zone' : null),
      engineFillBarTime: setup.fill?.barTime ?? null,
      live: old?.live ?? null,
    };
    for (let k = lc.recorded; k < setup.history.length; k++) {
      const t = setup.history[k];
      events.push({
        lifecycleId: id,
        symbol: underlying,
        exchange,
        mode,
        direction: setup.direction,
        fromState: k > 0 ? setup.history[k - 1].stage : null,
        toState: t.stage,
        reason: t.reason ?? null,
        at: t.at,
        poolKind: setup.pool.kind,
        poolPrice: round2(setup.pool.price),
        zone: setup.zone,
        entry: setup.entry,
        stop: setup.stop,
        t1: setup.t1?.price ?? null,
        t2: setup.t2?.price ?? null,
        score: setup.score?.total ?? null,
        underlyingPrice: spot,
        patterns: lc.patterns ?? null,
        scoreCandle: lc.scoreCandle ?? null,
      });
    }
    lc.recorded = setup.history.length;
    lifecycles.push(lc);
  }

  const watch = { BULLISH: poolView(evaluation.watch.BULLISH), BEARISH: poolView(evaluation.watch.BEARISH) };
  const watchSeen = [...(prev?.watchSeen ?? [])];
  for (const dir of ['BULLISH', 'BEARISH'] as const) {
    const w = watch[dir];
    if (!w) continue;
    const key = `${dir}:${w.kind}:${w.price}`;
    if (watchSeen.includes(key)) continue;
    watchSeen.push(key);
    events.push({
      lifecycleId: timeframe === '5m' ? `${exchange}:${underlying}:5m:WATCH:${key}` : `${exchange}:${underlying}:WATCH:${key}`,
      symbol: underlying,
      exchange,
      mode,
      direction: dir,
      fromState: null,
      toState: 'WATCH',
      reason: `price within ${STRUCTURE_RULES.watchWithinAtr} ATR of ${w.kind} ${w.price}`,
      at: evaluation.barTime + barMs,
      poolKind: w.kind,
      poolPrice: w.price,
      zone: null,
      entry: null,
      stop: null,
      t1: null,
      t2: null,
      score: null,
      underlyingPrice: spot,
      patterns: null,
      scoreCandle: null,
    });
  }

  return {
    state: {
      exchange,
      underlying,
      mode,
      day,
      timeframe,
      barTime: Number.isFinite(evaluation.barTime) ? evaluation.barTime : null,
      atr: evaluation.atr,
      updatedAt: now,
      watch,
      watchSeen,
      lifecycles,
    },
    events,
    reset: switched ? { from: prevTimeframe, to: timeframe } : null,
  };
}

/**
 * The lifecycle to fill this poll, if any. A CONFIRMED limit is filled when
 * the live price has reached it (bearish: spot ≥ entry); the engine may also
 * have seen the fill on the bar that just closed (stage ENTRY). Either way the
 * price must still be between the stop and T1 — a fill that has already hit
 * the stop or the target is not taken late. Once a lifecycle has a live
 * outcome it is never offered again. Highest score first — the score WITHOUT
 * the candle-pattern bonus (scoreBase), so the bonus never picks the fill.
 */
export function fillCandidate(state: LiveState, spot: number | null, lastClosedBarTime: number | null): LiveLifecycle | null {
  if (spot == null || !Number.isFinite(spot)) return null;
  const candidates = state.lifecycles.filter((l) => {
    if (l.live != null || l.entry == null || l.stop == null || l.t1 == null) return false;
    const bear = l.direction === 'BEARISH';
    const touched = bear ? spot >= l.entry : spot <= l.entry;
    const freshEngineFill = l.stage === 'ENTRY' && l.engineFillBarTime != null && lastClosedBarTime != null && l.engineFillBarTime === lastClosedBarTime;
    if (!(l.stage === 'CONFIRMED' && touched) && !freshEngineFill) return false;
    return bear ? spot < l.stop && spot > l.t1.price : spot > l.stop && spot < l.t1.price;
  });
  const orderScore = (l: LiveLifecycle) => (l.scoreBase !== undefined ? l.scoreBase ?? 0 : l.score ?? 0);
  candidates.sort((a, b) => orderScore(b) - orderScore(a));
  return candidates[0] ?? null;
}

/** A single closed bar's OHLC, as the caller reads it off its own closed-candle series. */
export interface ClosedBarOHLC {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A REJECTION_CLOSE fill, with the entry price (the bar's own close) and the candle's pattern label. */
export interface RejectionCloseFillResult {
  kind: 'FILL';
  lc: LiveLifecycle;
  entry: number;
  pattern: { shape: string; label: string };
}
/** A close beyond the sweep extreme before ever rejecting the zone — the same invalidation TOUCH mode already has, "as now". */
export interface RejectionCloseInvalidated {
  kind: 'INVALIDATED';
  lc: LiveLifecycle;
}
/** T1 reached before any bar gave a rejection close. */
export interface RejectionCloseMissed {
  kind: 'MISSED';
  lc: LiveLifecycle;
}
export type RejectionCloseOutcome = RejectionCloseFillResult | RejectionCloseInvalidated | RejectionCloseMissed;

/**
 * STRUCTURE_ENTRY_MODE = 'REJECTION_CLOSE' equivalent of fillCandidate: what
 * the newest CLOSED entry-timeframe bar decided for a CONFIRMED lifecycle,
 * per the pre-registered rule (@fno/analytics rejectionCloseFill) — NOT a
 * live-tick touch. Priority per bar, matching the backtest harness's
 * CLOSE_CONFIRM scan exactly: a rejection-close FILL first, else a close
 * beyond the sweep extreme (INVALIDATED), else T1 already reached (MISSED).
 *
 * Anchored on `confirmedAt` (stable — setup.history only ever grows), NOT on
 * `stage`/`stageAt`: the engine's own internal (touch-based) shadow
 * simulation moves `stage` away from CONFIRMED the instant ANY bar merely
 * touches the zone, which is not a rejection close. Gating on `stage` would
 * silently stop REJECTION_CLOSE from ever seeing the later bar that actually
 * rejects the zone. Like the backtest harness, this never reads the engine's
 * own fill/exit; only this function's answer can mint, invalidate or miss a
 * lifecycle under this mode. Highest score first (scoreBase, without the
 * candle-pattern bonus), like fillCandidate.
 */
export function rejectionCloseCandidate(state: LiveState, lastClosedBar: ClosedBarOHLC | null, fillWithinBars: number, barMs: number): RejectionCloseOutcome | null {
  if (!lastClosedBar) return null;
  const barCloseAt = lastClosedBar.time + barMs;
  const candidates = state.lifecycles.filter((l) => {
    if (l.live != null || l.entry == null || l.stop == null || l.t1 == null || !l.zone || l.confirmedAt == null) return false;
    if (barCloseAt <= l.confirmedAt) return false; // only bars that closed strictly after CONFIRMED
    return barCloseAt - l.confirmedAt <= fillWithinBars * barMs;
  });
  const orderScore = (l: LiveLifecycle) => (l.scoreBase !== undefined ? l.scoreBase ?? 0 : l.score ?? 0);
  candidates.sort((a, b) => orderScore(b) - orderScore(a));
  for (const l of candidates) {
    const hit = rejectionCloseFill(lastClosedBar, l.zone!, l.direction);
    if (hit) return { kind: 'FILL', lc: l, entry: hit.entry, pattern: { shape: hit.shape, label: hit.label } };
    const bear = l.direction === 'BEARISH';
    if (bear ? lastClosedBar.close > l.sweepExtreme : lastClosedBar.close < l.sweepExtreme) return { kind: 'INVALIDATED', lc: l };
    if (bear ? lastClosedBar.low <= l.t1!.price : lastClosedBar.high >= l.t1!.price) return { kind: 'MISSED', lc: l };
  }
  return null;
}

/**
 * STRUCTURE_SEQUENCE at the fill: the hard gate the sequence itself imposes.
 * Price still between stop and T1, and T1 still ≥ 1.5R from the fill price.
 */
export function structureSequenceRefusal(lc: LiveLifecycle, spot: number): { code: 'STRUCTURE_SEQUENCE'; reason: string } | null {
  if (lc.entry == null || lc.stop == null || lc.t1 == null) return { code: 'STRUCTURE_SEQUENCE', reason: 'The setup has no zone, stop or T1 — the sequence never completed.' };
  const bear = lc.direction === 'BEARISH';
  if (bear ? spot >= lc.stop : spot <= lc.stop) return { code: 'STRUCTURE_SEQUENCE', reason: `Price (${spot}) is already through the stop at ${lc.stop}.` };
  if (bear ? spot <= lc.t1.price : spot >= lc.t1.price) return { code: 'STRUCTURE_SEQUENCE', reason: `Price (${spot}) has already reached T1 (${lc.t1.kind} ${lc.t1.price}).` };
  const risk = Math.abs(lc.stop - spot);
  const reward = Math.abs(lc.t1.price - spot);
  if (risk > 0 && reward / risk < STRUCTURE_RULES.minT1R) {
    return { code: 'STRUCTURE_SEQUENCE', reason: `From the fill at ${spot}, T1 is only ${round2(reward / risk)}R away (needs ${STRUCTURE_RULES.minT1R}R).` };
  }
  return null;
}

/** The STRUCTURE_SEQUENCE row for the gate diagnostics. */
export function structureSequenceDiagnostic(lc: LiveLifecycle, refusal: { code: string; reason: string } | null, at: number): GateDiagnostic {
  const own = refusal?.code === 'STRUCTURE_SEQUENCE' ? refusal : null;
  return {
    gate: 'STRUCTURE_SEQUENCE',
    status: own ? 'FAIL' : 'PASS',
    reason: own?.reason ?? null,
    threshold:
      lc.timeframe === '5m'
        ? { minT1R: STRUCTURE_RULES_5M.minT1R, fillWithinBars: STRUCTURE_RULES_5M.fillWithinBars, family: 'STRUCTURE', timeframe: '5m' }
        : { minT1R: STRUCTURE_RULES.minT1R, fillWithinBars: STRUCTURE_RULES.fillWithinBars, family: 'STRUCTURE' },
    input_values: {
      lifecycleId: lc.id,
      direction: lc.direction,
      pool: lc.pool,
      zone: lc.zone,
      entry: lc.entry,
      stop: lc.stop,
      t1: lc.t1,
      rToT1: lc.rToT1,
      score: lc.score,
      notEnforced: ['LOW_SETUP_QUALITY', 'POOR_LOCATION', 'INSUFFICIENT_ROOM', 'POSITIONING_CONFLICT'],
    },
    timestamp: at,
    was_deciding_gate: own != null,
  };
}

export function lifecycleView(state: LiveState, lc: LiveLifecycle): StructureLifecycleView {
  return {
    id: lc.id,
    symbol: state.underlying,
    exchange: state.exchange,
    mode: state.mode,
    direction: lc.direction,
    stage: lc.stage,
    timeframe: lc.timeframe ?? state.timeframe ?? '15m',
    liveOutcome: lc.live?.outcome ?? null,
    liveReason: lc.live?.reason ?? null,
    pool: lc.pool,
    zone: lc.zone,
    entry: lc.entry,
    stop: lc.stop,
    t1: lc.t1,
    t2: lc.t2,
    rToT1: lc.rToT1,
    score: lc.score,
    scoreCandle: lc.scoreCandle ?? null,
    patterns: lc.patterns ?? null,
    sweepExtreme: lc.sweepExtreme,
    stageAt: lc.stageAt,
    reason: lc.reason,
  };
}

/** The structure block on the bias response. */
export function structureBlock(
  state: LiveState | null,
  meta: { enabled: boolean; symbol: string; exchange: Exchange; mode: TradingMode; timeframe?: StructureTimeframe }
): StructureBlock {
  if (!state) {
    return { enabled: meta.enabled, symbol: meta.symbol, exchange: meta.exchange, mode: meta.mode, barTime: null, atr: null, timeframe: meta.timeframe ?? '15m', current: { BULLISH: null, BEARISH: null }, watch: { BULLISH: null, BEARISH: null }, lifecycles: [] };
  }
  const views = state.lifecycles.map((l) => lifecycleView(state, l));
  const running = (dir: 'BULLISH' | 'BEARISH') => {
    const mine = views.filter((v) => v.direction === dir && !isTerminal(v.stage));
    return mine[mine.length - 1] ?? null;
  };
  return {
    enabled: meta.enabled,
    symbol: state.underlying,
    exchange: state.exchange,
    mode: state.mode,
    barTime: state.barTime,
    atr: state.atr,
    timeframe: state.timeframe ?? '15m',
    current: { BULLISH: running('BULLISH'), BEARISH: running('BEARISH') },
    watch: state.watch,
    lifecycles: [...views].reverse(),
  };
}

/** The watchlist rows for one symbol: running lifecycles, and WATCH pools for idle directions. */
export function watchlistRows(state: LiveState): StructureLifecycleView[] {
  const block = structureBlock(state, { enabled: true, symbol: state.underlying, exchange: state.exchange, mode: state.mode });
  const rows: StructureLifecycleView[] = [];
  for (const dir of ['BEARISH', 'BULLISH'] as const) {
    const cur = block.current[dir];
    if (cur) rows.push(cur);
    else if (block.watch[dir]) {
      rows.push({
        id: `${state.exchange}:${state.underlying}:WATCH:${dir}`,
        symbol: state.underlying,
        exchange: state.exchange,
        mode: state.mode,
        direction: dir,
        stage: 'WATCH',
        timeframe: state.timeframe ?? '15m',
        liveOutcome: null,
        liveReason: null,
        pool: block.watch[dir],
        zone: null,
        entry: null,
        stop: null,
        t1: null,
        t2: null,
        rToT1: null,
        score: null,
        patterns: null,
        sweepExtreme: null,
        stageAt: state.barTime != null ? state.barTime + STRUCTURE_TF_BAR_MS[state.timeframe ?? '15m'] : state.updatedAt,
        reason: null,
      });
    }
  }
  return rows;
}

export function isTerminal(stage: string): boolean {
  return (TERMINAL_STAGES as readonly string[]).includes(stage);
}

/** A CONFIRMED transition is pushed to Telegram only while it is fresh (a restart must not send stale alerts). */
export function isAlertFresh(transitionAt: number, now: number, maxAgeMinutes: number): boolean {
  return now - transitionAt <= maxAgeMinutes * 60 * 1000 && now >= transitionAt - 60 * 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
