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

import { STRUCTURE_RULES, TERMINAL_STAGES, type LiquidityPool, type StructureEvaluation, type StructureSetup, type StructureStage } from '@fno/analytics';
import type { Exchange, StructureBlock, StructureLifecycleView, StructurePoolView, TradingMode } from '@fno/shared';
import type { GateDiagnostic } from './gate-diagnostics.js';

export { STRUCTURE_STRATEGY } from './momentum-break-live.js';
export const STRUCTURE_SETUP_TYPE = 'STRUCTURE_SWEEP_FVG';
/**
 * The confidence a structure setup is minted and cooldown-checked at. The
 * sequence is binary — sweep, displacement and a filled zone either happened
 * or did not — and the 0-100 score never gates, so it cannot stand in for a
 * confidence (it would make the post-loss 80 floor a score gate). Recorded
 * beside the real score.
 */
export const STRUCTURE_SEQUENCE_CONFIDENCE = 100;
const BAR_MS = 15 * 60 * 1000;

export function structureStateKey(exchange: Exchange, underlying: string, mode: TradingMode): string {
  return `structure_setup:${exchange}:${underlying}:${mode}`;
}

export function lifecycleIdOf(exchange: Exchange, underlying: string, setup: Pick<StructureSetup, 'id'>): string {
  return `${exchange}:${underlying}:${setup.id}`;
}

/** One lifecycle as kept in Redis. */
export interface LiveLifecycle {
  id: string;
  direction: 'BULLISH' | 'BEARISH';
  stage: StructureStage;
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
  sweepExtreme: number;
  atr: number;
  displacementBodyAtr: number | null;
  stageAt: number;
  reason: string | null;
  /** Index of the engine's fill bar (its open time), when the engine saw one. */
  engineFillBarTime: number | null;
  /** The live outcome at the fill. */
  live: { outcome: 'MINTED' | 'REFUSED'; reason: string | null; code: string | null; at: number; decisionId?: string | null; signalId?: string | null } | null;
}

export interface LiveState {
  exchange: Exchange;
  underlying: string;
  mode: TradingMode;
  /** IST session date the lifecycles belong to. */
  day: string;
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
}

const poolView = (p: LiquidityPool | null | undefined): StructurePoolView | null => (p ? { kind: p.kind, price: round2(p.price), rank: p.rank } : null);

/**
 * Folds this poll's engine read into the Redis state. Pure: returns the next
 * state and every transition not yet recorded (engine transitions, plus one
 * WATCH row per direction and pool per day). A new session date starts from
 * an empty state; a lifecycle's live outcome (minted / refused) is kept.
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
}): { state: LiveState; events: LifecycleEventRow[] } {
  const { evaluation, exchange, underlying, mode, day, now, spot } = args;
  const prev = args.prev && args.prev.day === day ? args.prev : null;
  const byId = new Map((prev?.lifecycles ?? []).map((l) => [l.id, l]));
  const events: LifecycleEventRow[] = [];
  const lifecycles: LiveLifecycle[] = [];

  for (const setup of evaluation.setups) {
    const id = lifecycleIdOf(exchange, underlying, setup);
    const old = byId.get(id);
    const last = setup.history[setup.history.length - 1];
    const lc: LiveLifecycle = {
      id,
      direction: setup.direction,
      stage: setup.stage,
      recorded: old?.recorded ?? 0,
      pool: poolView(setup.pool)!,
      zone: setup.zone,
      entry: setup.entry,
      stop: setup.stop,
      t1: setup.t1,
      t2: setup.t2,
      rToT1: setup.rToT1,
      score: setup.score?.total ?? null,
      sweepExtreme: round2(setup.sweep.extreme),
      atr: round2(setup.atr),
      displacementBodyAtr: setup.displacement?.bodyAtr ?? null,
      stageAt: last?.at ?? now,
      reason: last?.reason ?? null,
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
      lifecycleId: `${exchange}:${underlying}:WATCH:${key}`,
      symbol: underlying,
      exchange,
      mode,
      direction: dir,
      fromState: null,
      toState: 'WATCH',
      reason: `price within ${STRUCTURE_RULES.watchWithinAtr} ATR of ${w.kind} ${w.price}`,
      at: evaluation.barTime + BAR_MS,
      poolKind: w.kind,
      poolPrice: w.price,
      zone: null,
      entry: null,
      stop: null,
      t1: null,
      t2: null,
      score: null,
      underlyingPrice: spot,
    });
  }

  return {
    state: {
      exchange,
      underlying,
      mode,
      day,
      barTime: Number.isFinite(evaluation.barTime) ? evaluation.barTime : null,
      atr: evaluation.atr,
      updatedAt: now,
      watch,
      watchSeen,
      lifecycles,
    },
    events,
  };
}

/**
 * The lifecycle to fill this poll, if any. A CONFIRMED limit is filled when
 * the live price has reached it (bearish: spot ≥ entry); the engine may also
 * have seen the fill on the bar that just closed (stage ENTRY). Either way the
 * price must still be between the stop and T1 — a fill that has already hit
 * the stop or the target is not taken late. Once a lifecycle has a live
 * outcome it is never offered again. Highest score first.
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
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return candidates[0] ?? null;
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
    threshold: { minT1R: STRUCTURE_RULES.minT1R, fillWithinBars: STRUCTURE_RULES.fillWithinBars, family: 'STRUCTURE' },
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
    sweepExtreme: lc.sweepExtreme,
    stageAt: lc.stageAt,
    reason: lc.reason,
  };
}

/** The structure block on the bias response. */
export function structureBlock(state: LiveState | null, meta: { enabled: boolean; symbol: string; exchange: Exchange; mode: TradingMode }): StructureBlock {
  if (!state) {
    return { enabled: meta.enabled, symbol: meta.symbol, exchange: meta.exchange, mode: meta.mode, barTime: null, atr: null, current: { BULLISH: null, BEARISH: null }, watch: { BULLISH: null, BEARISH: null }, lifecycles: [] };
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
        sweepExtreme: null,
        stageAt: state.barTime != null ? state.barTime + BAR_MS : state.updatedAt,
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
