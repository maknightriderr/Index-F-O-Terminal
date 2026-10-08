// ============================================================
// TRIGGER-FAMILY ROUTER (live)
// ============================================================
// The layer above the trigger families. On every poll it reads the symbol's
// closed 15m bars, builds the session's event log, and evaluates every
// trigger family the event engine defines — with or without a displacement —
// at each newly closed bar:
//
//   market event → candidate (a trigger's exact rule) → evidence (the events
//   it used, market state) → move potential → entry timing → risk validation
//   (geometry, session guards) → option feasibility (cost on the live chain)
//
// Displacement is NOT checked here. It is S1's own requirement (the structure
// engine, which runs unchanged beside this router) and C2's anchor; for every
// other family it is only an event in the log.
//
// Several families often see the same move. Candidates are grouped into
// parent setups (event-engine candidates.ts). The OBSERVATION arbitration
// (event-engine arbitration.ts, SHADOW and up) records which setup each
// parent would select, for research. The TRADING decision is not made here:
// every eligible candidate of the bar that just closed at a paper-trading
// stage (PAPER_RESEARCH / PAPER / ACTIVE) is handed to the slot with its
// parent id and anchor keys — no pre-selection — where it is built and
// ranked against S1 and the indicator engine (slot-arbitration.ts). The
// parent linkage (which sweep event belongs to which parent) is returned so
// S1 can join the same parent through the canonical event, never by time or
// price proximity.
//
// What happens next depends on the trigger's own live stage
// (resolveTriggerStage):
//   SHADOW           recorded to setup_events (decision SHADOW) and graded
//                    forward — never traded.
//   PAPER_RESEARCH / PAPER / ACTIVE
//                    an eligible candidate on the newest bar is returned to
//                    the caller, which builds it through the structure
//                    engine's own chain (resolveStructureSetup: the same
//                    safety gates, option leg and exits). Paper only.
//   RESEARCH / RETIRED  not evaluated live.
//
// Every failure is logged and returns null: the router can never block or
// alter the structure engine, the consensus engine, or a held trade.
// ============================================================

import {
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  groupIntoParents,
  arbitrateParents,
  TRIGGER_REGISTRY,
  TRIGGERS_BY_ID,
  EVENT_ENGINE_TRIGGER_IDS,
  BAR_MS_15M,
  type MomentumBar,
  type TriggerCandidate,
  type ArbitrationDecision,
  type FixedSelection,
  type MarketEvent,
  type ParentSetup,
  type SeriesContext,
  type SessionEventLog,
  type TriggerFailure,
  rebuildCandidateAt,
  STRUCTURE_RULES,
  PARENT_SPAN_BARS,
  parentIdFor,
  levelKeyOf,
} from '@fno/analytics';
import { getSessionWindow, type Exchange, type OptionChain, type TradingMode } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  resolveTriggerStage,
  PAPER_TRADING_STAGES,
  EVENT_ENGINE_VERSION,
  RISK_VERSION,
  OPTION_VERSION,
  COST_VERSION,
  FNO_VALIDATION_PARAMS,
  STRUCTURE_PARAMS,
  type LiveTriggerStage,
} from '../config/trading-flags.js';
import { measureSetupCost, type SetupCostMeasurement } from './setup-cost.js';
import { recordSetupEvent } from './setup-events.js';
import type { LiveLifecycle } from './structure-live.js';

/** Newly closed bars evaluated per poll at most (a catch-up after a quiet spell). */
const MAX_CATCHUP_BARS = 8;
const EVAL_STATE_TTL_SECONDS = 36 * 60 * 60;
const CANDIDATE_DEDUPE_TTL_SECONDS = 3 * 24 * 60 * 60;
/** Settle after the open (the live engine's own). */
const SETTLE_MS = 5 * 60 * 1000;

export interface RiskValidation {
  /**
   * The event engine's own label (TRADE / LOW_RR / NO_TARGET / INVALID_STOP).
   * TRADE and LOW_RR both have valid geometry (a stop with positive risk and a
   * real untaken target beyond the entry) and both are tradeable: since
   * 2026-10-05 net R:R is ranking / display only, so LOW_RR (< 1.5R) is a
   * label, never a rejection. NO_TARGET / INVALID_STOP are genuine rejections.
   */
  bucket: TriggerCandidate['bucket'];
  /** Inside the session guards: not in the first 5 minutes, not within the structure closing guard. */
  sessionOk: boolean;
  /** Round-trip cost as % of the premium, on the live chain's leg (null without a quote). */
  costPct: number | null;
  costOk: boolean | null;
  /** All of the above pass. A SHADOW candidate with wouldTrade = true is what a PAPER stage would have minted. */
  wouldTrade: boolean;
  reason: string | null;
}

export interface RoutedCandidate {
  candidate: TriggerCandidate;
  stage: LiveTriggerStage;
  risk: RiskValidation;
  cost: SetupCostMeasurement | null;
  lifecycleId: string;
  /** Observation arbitration (SHADOW and up): which setup this parent move would select, and this candidate's role. */
  arbitration?: ArbitrationDecision | null;
  /** The parent move this candidate belongs to (groupIntoParents). */
  parentId?: string | null;
  /** The parent id plus the canonical events it is anchored on (its anchor and that event's ancestors, e.g. RECLAIM → SWEEP). */
  anchorKeys?: string[];
}

/** A sweep event of today's session, as S1 can match it (same findSweep, same bar, same pool). */
export interface SweepRef {
  eventId: string;
  direction: 'BULLISH' | 'BEARISH';
  /** The confirming bar's open time (= S1's setup id time). */
  time: number;
  levelKind: string;
  levelPrice: number;
}

/** Which parent each canonical event key belongs to, for today's session. */
export interface ParentLinkage {
  session: string;
  /** The symbol the parent ids were hashed with (absent on linkage cached before PARENT-2.0). */
  symbol?: string;
  sweeps: SweepRef[];
  /** Event id (an anchor or one of its ancestors) or parent id → parent id. */
  parentOfKey: Record<string, string>;
}

/** An event and its ancestors (RECLAIM → its SWEEP), from the session log. */
function eventChain(eventId: string, byId: ReadonlyMap<string, MarketEvent>): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = eventId;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

/** The parent id of a sweep no family candidate is anchored on: the move it starts (or joins, by level and window — PARENT IDENTITY). */
function sweepParentId(symbol: string, session: string, sweep: MarketEvent, parents: readonly Pick<ParentSetup, 'parentId' | 'direction' | 'anchorEventId' | 'anchorIndex'>[], byId: ReadonlyMap<string, MarketEvent>): string {
  const level = levelKeyOf(sweep.level ?? null);
  const joined = parents.find((p) => {
    const origin = byId.get(p.anchorEventId);
    return p.direction === sweep.direction && level != null && levelKeyOf(origin?.level ?? null) === level && sweep.barIndex - p.anchorIndex >= 0 && sweep.barIndex - p.anchorIndex <= PARENT_SPAN_BARS;
  });
  return joined?.parentId ?? parentIdFor(symbol, session, sweep.direction as 'BULLISH' | 'BEARISH', { originEventId: sweep.id, originLevel: level, ancestry: [sweep.id], windowStart: sweep.time });
}

/**
 * Pure: the parent linkage of a session — every candidate's anchor event and
 * its ancestors mapped to the candidate's parent (first parent wins, in
 * chronological order), every sweep event mapped to its move (PARENT
 * IDENTITY), and the session's sweep events.
 */
export function buildParentLinkage(
  session: string,
  parents: readonly Pick<ParentSetup, 'parentId' | 'candidates' | 'direction' | 'anchorEventId' | 'anchorIndex'>[],
  all: readonly TriggerCandidate[],
  events: readonly MarketEvent[],
  symbol = ''
): ParentLinkage {
  const byId = new Map(events.map((e) => [e.id, e]));
  const parentOfKey: Record<string, string> = {};
  for (const p of parents) {
    parentOfKey[p.parentId] ??= p.parentId;
    for (const idx of p.candidates) for (const k of eventChain(all[idx].anchorEventId, byId)) parentOfKey[k] ??= p.parentId;
  }
  const sweepEvents = events.filter((e) => e.type === 'SWEEP' && e.direction != null && e.level != null);
  for (const e of sweepEvents) parentOfKey[e.id] ??= sweepParentId(symbol, session, e, parents, byId);
  const sweeps: SweepRef[] = sweepEvents.map((e) => ({ eventId: e.id, direction: e.direction as 'BULLISH' | 'BEARISH', time: e.time, levelKind: e.level!.kind, levelPrice: e.level!.price }));
  return { session, symbol, sweeps, parentOfKey };
}

/** Pure: a candidate's anchor keys — its parent and the canonical events it stands on. */
export function anchorKeysOf(parentId: string, c: Pick<TriggerCandidate, 'anchorEventId'>, events: readonly MarketEvent[]): string[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  return [parentId, ...eventChain(c.anchorEventId, byId)];
}

/**
 * Pure: S1's parent through the canonical sweep event — the event engine's
 * SWEEP on the same confirming bar, same direction, same pool (both come from
 * the structure engine's own findSweep). No match (5m mode, a routed
 * lifecycle, no linkage): S1 stands alone, keyed by its lifecycle.
 */
export function linkStructureToParent(
  lc: Pick<LiveLifecycle, 'id' | 'direction' | 'pool' | 'timeframe' | 'triggerId'>,
  linkage: ParentLinkage | null
): { parentId: string; anchorKeys: string[]; linked: boolean } {
  const alone = { parentId: `S1:${lc.id}`, anchorKeys: [`S1:${lc.id}`], linked: false };
  if (!linkage || lc.triggerId || lc.timeframe === '5m') return alone;
  const sweepTime = Number(lc.id.slice(lc.id.lastIndexOf(':') + 1));
  if (!Number.isFinite(sweepTime)) return alone;
  const sweep = linkage.sweeps.find((w) => w.direction === lc.direction && w.time === sweepTime && w.levelKind === lc.pool.kind && Math.abs(w.levelPrice - lc.pool.price) < 0.005);
  if (!sweep) return alone;
  // Every sweep is in parentOfKey since PARENT-2.0; a linkage cached before it falls back to the sweep's own move id.
  const parentId =
    linkage.parentOfKey[sweep.eventId] ??
    parentIdFor(linkage.symbol ?? '', linkage.session, lc.direction, { originEventId: sweep.eventId, originLevel: levelKeyOf({ kind: sweep.levelKind, price: sweep.levelPrice }), ancestry: [sweep.eventId], windowStart: sweep.time });
  return { parentId, anchorKeys: [parentId, sweep.eventId], linked: true };
}

// ---------------- the family watch: every confirmed candidate, shown until it ends ----------------

/** How many closed bars a confirmed family candidate stays on the watch: S1's own fill window (user decision 2026-10-01). */
export const FAMILY_WATCH_BARS: number = STRUCTURE_RULES.fillWithinBars;

/**
 * A confirmed family candidate on the watch under its ORIGINAL lifecycle id —
 * DISPLAY only: re-measured on every closed bar and shown with its option
 * plan until it is INVALIDATED / EXPIRES / is FILLED. It went to the slot at
 * its own decision bar like every eligible candidate; the watch never hands
 * it again (with no R:R gate there is nothing to "recover" from).
 */
export interface FamilyWatchEntry {
  lifecycleId: string;
  /** The candidate as the rule decided it (its hit: anchor, events, stopRef). */
  original: TriggerCandidate;
  parentId: string | null;
  anchorKeys: string[];
  /** Always DISPLAY (entries written before 2026-10-05 may carry an older cause; it is ignored). */
  cause: 'DISPLAY' | string;
  /** The candidate as re-measured on the newest evaluated bar (null before the first re-check). */
  current: TriggerCandidate | null;
  lastIndex: number;
  ended: { reason: string; at: number } | null;
}

export function familyWatchKey(exchange: Exchange, underlying: string, session: string): string {
  return `mp_watch:${exchange}:${underlying}:${session}`;
}

/**
 * Pure: advance every live family watch entry to bar `end` with the rule's
 * own builder (rebuildCandidateAt — bars ≤ end only). Ends an entry on: a
 * close beyond the rule's invalidation extreme (INVALIDATED), its original T1
 * traded before any entry (MISSED — the move it was confirmed for has gone),
 * no longer rebuildable / no target (ENDED), FAMILY_WATCH_BARS elapsed or the
 * closing guard (EXPIRED). Returns the updated entries; a live one carries its
 * re-measured candidate.
 */
export function advanceFamilyWatch(
  entries: readonly FamilyWatchEntry[],
  ctx: SeriesContext,
  log: SessionEventLog,
  end: number,
  sessionOk: (i: number) => boolean
): FamilyWatchEntry[] {
  const bars = ctx.series.bars;
  const closeAt = bars[end].time + BAR_MS_15M;
  return entries.map((w) => {
    if (w.ended || w.lastIndex >= end) return w;
    const o = w.original;
    const bear = o.direction === 'BEARISH';
    const stopRef = o.stopRef;
    const finish = (reason: string): FamilyWatchEntry => ({ ...w, lastIndex: end, ended: { reason, at: closeAt } });
    for (let i = w.lastIndex + 1; i <= end; i++) {
      const b = bars[i];
      if (stopRef != null && (bear ? b.close > stopRef : b.close < stopRef)) return finish('INVALIDATED');
      if (o.t1 && (bear ? b.low <= o.t1.price : b.high >= o.t1.price)) return finish('MISSED');
    }
    if (end - o.decisionIndex > FAMILY_WATCH_BARS) return finish('EXPIRED');
    if (!sessionOk(end)) return finish('EXPIRED_CLOSING_GUARD');
    const rebuilt = rebuildCandidateAt(ctx, log, o, end);
    if (!rebuilt) return finish('NOT_REBUILDABLE');
    if (rebuilt.bucket === 'INVALID_STOP') return finish('INVALIDATED');
    if (rebuilt.bucket === 'NO_TARGET') return finish('NO_TARGET');
    return { ...w, current: rebuilt, lastIndex: end };
  });
}

/** Pure: a new (display) watch entry for a confirmed candidate. */
export function newFamilyWatch(rc: RoutedCandidate): FamilyWatchEntry {
  return { lifecycleId: rc.lifecycleId, original: rc.candidate, parentId: rc.parentId ?? null, anchorKeys: rc.anchorKeys ?? [], cause: 'DISPLAY', current: null, lastIndex: rc.candidate.decisionIndex, ended: null };
}

/** Ends a watched family candidate (FILLED — it became the paper trade). No-op when it was never watched. */
export async function endFamilyWatch(exchange: Exchange, underlying: string, session: string, lifecycleId: string, reason: string, at: number): Promise<void> {
  const key = familyWatchKey(exchange, underlying, session);
  try {
    const list: FamilyWatchEntry[] = JSON.parse((await redis.get(key)) ?? '[]');
    const w = list.find((x) => x.lifecycleId === lifecycleId);
    if (!w || w.ended) return;
    w.ended = { reason, at };
    await redis.set(key, JSON.stringify(list), 'EX', EVAL_STATE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange, lifecycleId }, 'Trigger router: watch end failed');
  }
}

/** Pure: what the slot receives — every eligible paper-stage candidate decided on the newest closed bar (no pre-selection). */
export function paperCandidatesForSlot(routed: readonly RoutedCandidate[], newestIndex: number): RoutedCandidate[] {
  return routed.filter((rc) => rc.candidate.decisionIndex === newestIndex && PAPER_TRADING_STAGES.includes(rc.stage) && rc.risk.wouldTrade);
}

/** Each trigger's live stage (S1 is the structure engine's own; it is listed for completeness). */
export function liveTriggerStages(): Record<string, LiveTriggerStage> {
  return Object.fromEntries(TRIGGER_REGISTRY.map((t) => [t.triggerId, resolveTriggerStage(t.triggerId, t.status)]));
}

/** The triggers the router evaluates live: event-engine rules at SHADOW or above. */
export function liveRoutedTriggerIds(stages: Record<string, LiveTriggerStage> = liveTriggerStages()): string[] {
  return EVENT_ENGINE_TRIGGER_IDS.filter((id) => ['SHADOW', ...PAPER_TRADING_STAGES].includes(stages[id]));
}

export function routedLifecycleId(exchange: Exchange, underlying: string, c: TriggerCandidate): string {
  return `${exchange}:${underlying}:MP:${c.triggerId}:${c.direction}:${c.decisionTime}`;
}

/** Pure: the risk verdict for one candidate. */
export function validateCandidateRisk(c: TriggerCandidate, args: { sessionOk: boolean; costPct: number | null; maxCostPct: number }): RiskValidation {
  const costOk = args.costPct == null ? null : args.costPct <= args.maxCostPct;
  // Genuine geometry only: a stop with positive risk and a target beyond the entry. Net R:R is never checked here.
  const geometryOk = c.bucket === 'TRADE' || c.bucket === 'LOW_RR';
  const reasons: string[] = [];
  if (!geometryOk) reasons.push(c.bucket === 'NO_TARGET' ? 'NO_TARGET: no untaken pool ahead' : 'INVALID_STOP');
  if (!args.sessionOk) reasons.push('SESSION_GUARD: outside the allowed entry window');
  if (costOk === false) reasons.push(`COST_TOO_HIGH: ~${args.costPct}% of premium round trip`);
  return {
    bucket: c.bucket,
    sessionOk: args.sessionOk,
    costPct: args.costPct,
    costOk,
    wouldTrade: geometryOk && args.sessionOk && costOk !== false,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

/**
 * Pure: a PAPER-stage candidate as the lifecycle shape the structure engine's
 * mint chain reads. The fill price is the decision bar's close (the rule
 * decides at that close); `sweepExtreme` carries the rule's invalidation
 * extreme, which the structure exits (SWEEP_RECLAIMED) watch.
 */
export function lifecycleFromCandidate(rc: RoutedCandidate): LiveLifecycle {
  const c = rc.candidate;
  const buf = 0.1 * c.atr;
  const invalidation = c.direction === 'BULLISH' ? c.stop + buf : c.stop - buf;
  return {
    id: rc.lifecycleId,
    direction: c.direction,
    stage: 'ENTRY',
    timeframe: '15m',
    recorded: 0,
    pool: { kind: c.triggerId, price: c.anchorPrice, rank: 0 },
    zone: null,
    entry: c.entry,
    stop: c.stop,
    t1: c.t1 ? { kind: c.t1.kind, price: c.t1.price } : null,
    t2: c.t2 ? { kind: c.t2.kind, price: c.t2.price } : null,
    rToT1: c.rToT1,
    score: null,
    sweepExtreme: Math.round(invalidation * 100) / 100,
    atr: c.atr,
    displacementBodyAtr: null,
    stageAt: c.decisionTime + BAR_MS_15M,
    reason: null,
    engineFillBarTime: c.decisionTime,
    confirmedAt: null,
    rejectionFillPrice: c.entry,
    live: null,
    triggerId: c.triggerId,
  };
}

function legFor(chain: OptionChain, side: 'CE' | 'PE') {
  const row = chain.strikes.find((s) => s.strike === chain.atmStrike);
  return side === 'CE' ? row?.call : row?.put;
}

/** The option leg's cost for a candidate, on the ATM leg of the live chain (labelled ATM_PROXY: no contract was chosen). */
export function costOnChain(c: TriggerCandidate, chain: OptionChain | null): SetupCostMeasurement | null {
  if (!chain) return null;
  const side = c.direction === 'BULLISH' ? 'CE' : 'PE';
  const leg = legFor(chain, side);
  const base = { entry: c.entry, stop: c.stop, t1: c.t1?.price ?? null, atr: c.atr, costVersion: COST_VERSION };
  if (!leg) return measureSetupCost({ ...base, option: null });
  const twoSided = leg.bid > 0 && leg.ask > leg.bid;
  return measureSetupCost({
    ...base,
    option: {
      side,
      strike: chain.atmStrike,
      expiry: chain.expiry ?? null,
      strikeBasis: 'ATM_PROXY',
      premium: twoSided ? (leg.bid + leg.ask) / 2 : leg.ltp > 0 ? leg.ltp : null,
      bid: leg.bid > 0 ? leg.bid : null,
      ask: leg.ask > 0 ? leg.ask : null,
      delta: Number.isFinite(leg.delta) ? leg.delta : null,
      lotSize: chain.lotSize > 0 ? chain.lotSize : null,
    },
  });
}

/** The router's own per-symbol state, read from Redis before an evaluation (an input of the decision). */
export interface FamilyRouterState {
  /** Open time of the newest bar already evaluated (0 = none). */
  lastDone: number;
  /** Observation selections fixed by earlier evaluations (parent id → selection). */
  observeSelections: Record<string, FixedSelection>;
  /** The family watch as last written. */
  watch: FamilyWatchEntry[];
  /** The linkage written when the newest bar was evaluated (returned when there is no new bar). */
  cachedLinkage: ParentLinkage | null;
}

export const EMPTY_FAMILY_ROUTER_STATE: FamilyRouterState = { lastDone: 0, observeSelections: {}, watch: [], cachedLinkage: null };

/** Where the router would evaluate: today's session of the closed bars, or null when it does not run. */
export function familyRouterSession(args: { exchange: Exchange; mode: TradingMode; bars: readonly MomentumBar[]; now: number; ids: readonly string[] }): string | null {
  const { exchange, mode, bars, now, ids } = args;
  if (mode !== 'INTRADAY' || bars.length < 30 || ids.length === 0) return null;
  const series = prepareMomentumSeries(bars as MomentumBar[]);
  const session = series.sessionDates[series.sessionStarts.length - 1];
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (session !== today) return null;
  return getSessionWindow(exchange, session) ? session : null;
}

/** Reads the router's state for a session (each read failing to its empty value, as before). */
export async function readFamilyRouterState(exchange: Exchange, underlying: string, mode: TradingMode, session: string): Promise<FamilyRouterState> {
  const [lastDone, sel, watched, cached] = await Promise.all([
    redis.get(`mp_eval:${exchange}:${underlying}:${mode}`).catch(() => null),
    redis.get(`mp_sel:observe:${exchange}:${underlying}:${session}`).catch(() => null),
    redis.get(familyWatchKey(exchange, underlying, session)).catch(() => null),
    redis.get(`mp_link:${exchange}:${underlying}:${session}`).catch(() => null),
  ]);
  return {
    lastDone: Number(lastDone ?? 0),
    observeSelections: JSON.parse(sel ?? '{}') as Record<string, FixedSelection>,
    watch: watched ? (JSON.parse(watched) as FamilyWatchEntry[]) : [],
    cachedLinkage: cached ? (JSON.parse(cached) as ParentLinkage) : null,
  };
}

export interface FamilyCoreResult {
  /** NOT_RUN: not intraday / too few bars / no live trigger / not today's session. NO_NEW_BAR: nothing new to evaluate. */
  status: 'NOT_RUN' | 'NO_NEW_BAR' | 'EVALUATED';
  session: string | null;
  /** Open time of the newest evaluated bar (null unless EVALUATED). */
  newestBarTime: number | null;
  /** Index of the newest closed bar in the series (-1 when not run). */
  end: number;
  /** Bar indices evaluated this time. */
  todo: number[];
  /** Every candidate of today's session, with parent, anchor keys and (for evaluated bars) its observation role. */
  routed: RoutedCandidate[];
  /** The session's market events (the event log). */
  events: MarketEvent[];
  linkage: ParentLinkage | null;
  observeSelections: Record<string, FixedSelection>;
  observeSelectionsChanged: boolean;
  paper: RoutedCandidate[];
  watch: FamilyWatchEntry[];
  /** Triggers that failed on a bar (error or look-ahead) — only their own candidates were lost. */
  triggerFailures: TriggerFailure[];
}

/**
 * Pure: the router's decision for the closed bars and its prior state — every
 * trigger on every bar of today's session, risk validation, cost on the given
 * chain (newest bar only), parents, linkage, the observation arbitration, the
 * slot hand-over and the watch. No IO and no clock: `now` only names today.
 * The live router and replay(snapshotId) both run exactly this.
 */
export function evaluateFamiliesCore(args: {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  bars: MomentumBar[];
  chain: OptionChain | null;
  now: number;
  stages: Record<string, LiveTriggerStage>;
  state: FamilyRouterState;
}): FamilyCoreResult {
  const { underlying, exchange, mode, bars, chain, now, stages, state } = args;
  const ids = liveRoutedTriggerIds(stages);
  const notRun: FamilyCoreResult = { status: 'NOT_RUN', session: null, newestBarTime: null, end: -1, todo: [], routed: [], events: [], linkage: null, observeSelections: {}, observeSelectionsChanged: false, paper: [], watch: [], triggerFailures: [] };
  if (!familyRouterSession({ exchange, mode, bars, now, ids })) return notRun;
  const series = prepareMomentumSeries(bars);
  const s = series.sessionStarts.length - 1;
  const session = series.sessionDates[s];
  const window = getSessionWindow(exchange, session)!;

  const ctx = buildSeriesContext(series);
  const start = series.sessionStarts[s];
  const end = ctx.sessionEnd(s);
  const todo: number[] = [];
  for (let i = Math.max(start, end - MAX_CATCHUP_BARS + 1); i <= end; i++) if (series.bars[i].time > state.lastDone) todo.push(i);
  if (todo.length === 0) {
    // No new bar: the linkage written when the newest bar was evaluated is still exact (parents only change on a new bar).
    return { ...notRun, status: 'NO_NEW_BAR', session, end, linkage: state.cachedLinkage, observeSelections: state.observeSelections, watch: state.watch };
  }

  const log = runSessionEvents(ctx, s);
  const closingGuardMs = STRUCTURE_PARAMS.STRUCTURE_CLOSING_GUARD_MIN * 60 * 1000;
  const todoSet = new Set(todo);

  // 1. Every trigger, independently, on every bar of today's session so far
  //    (each rule reads only bars up to its own decision bar). One rule
  //    failing — no displacement, no target — never stops another.
  // A trigger that throws (or reads past its bar) loses only its own candidates.
  const all: TriggerCandidate[] = [];
  const triggerFailures: TriggerFailure[] = [];
  for (let i = start; i <= end; i++) all.push(...evaluateTriggersAt(ctx, log, i, ids, triggerFailures));

  // 2. Qualify each: risk geometry, session window, and option cost on the
  //    live quote (only meaningful for the bar that just closed).
  const routed: RoutedCandidate[] = all.map((c) => {
    const barTime = c.decisionTime;
    const sessionOk = barTime - window.open >= SETTLE_MS && window.close - (barTime + BAR_MS_15M) >= closingGuardMs;
    const cost = c.decisionIndex === end ? costOnChain(c, chain) : null;
    const risk = validateCandidateRisk(c, { sessionOk, costPct: cost?.costPctOfPremium != null ? Math.round(cost.costPctOfPremium * 100) / 100 : null, maxCostPct: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM });
    return { candidate: c, stage: stages[c.triggerId], risk, cost, lifecycleId: routedLifecycleId(exchange, underlying, c) };
  });

  // 3. Group by parent move, then 4. arbitrate one setup per parent for
  //    observation (SHADOW and up). A bar settled by an earlier evaluation
  //    keeps its verdict: its selection (if any) is persisted, and its other
  //    candidates cannot be re-selected with hindsight.
  const parents = groupIntoParents(all, new Map([[session, log]]), { symbol: underlying });
  const linkage = buildParentLinkage(session, parents, all, log.events, underlying);
  const parentOf = new Map<number, string>();
  for (const p of parents) for (const idx of p.candidates) parentOf.set(idx, p.parentId);
  const fixed: Record<string, FixedSelection> = { ...state.observeSelections };
  const allowed: LiveTriggerStage[] = ['SHADOW', ...PAPER_TRADING_STAGES];
  const observed = arbitrateParents(parents, all, (idx) => {
    const r = routed[idx];
    const fresh = todoSet.has(r.candidate.decisionIndex);
    return {
      eligible: fresh && r.risk.wouldTrade,
      ineligibleReason: fresh ? r.risk.reason : 'Decided at an earlier evaluation',
      stageAllowed: allowed.includes(r.stage),
      netR: r.cost?.netR ?? null,
    };
  }, fixed);
  let changed = false;
  for (const [idx, d] of observed) {
    const c = all[idx];
    if (d.role === 'SELECTED' && todoSet.has(c.decisionIndex) && !fixed[d.parentId]) {
      fixed[d.parentId] = { triggerId: c.triggerId, decisionIndex: c.decisionIndex };
      changed = true;
    }
  }

  // 5. Every candidate carries its parent and anchor keys; an evaluated one its
  //    observation role. The slot gets EVERY eligible paper-stage candidate of
  //    the bar that just closed — the trading choice is made there.
  for (let idx = 0; idx < all.length; idx++) {
    const rc = routed[idx];
    rc.parentId = parentOf.get(idx) ?? null;
    rc.anchorKeys = rc.parentId ? anchorKeysOf(rc.parentId, rc.candidate, log.events) : [];
    if (todoSet.has(rc.candidate.decisionIndex)) rc.arbitration = observed.get(idx) ?? null;
  }
  const paper = paperCandidatesForSlot(routed, end);

  // 6. The watch: every CONFIRMED paper-stage candidate of the newest bar
  //    (valid geometry, any R:R) is shown and re-measured under its id on
  //    every later closed bar with the rule's own builder, until it is
  //    invalidated, expires or is filled. Display only.
  const sessionOkAt = (i: number) => series.bars[i].time - window.open >= SETTLE_MS && window.close - (series.bars[i].time + BAR_MS_15M) >= closingGuardMs;
  const watch = advanceFamilyWatch(state.watch, ctx, log, end, sessionOkAt);
  for (const rc of routed) {
    if (rc.candidate.decisionIndex !== end || !PAPER_TRADING_STAGES.includes(rc.stage) || !rc.risk.sessionOk) continue;
    if (rc.candidate.bucket !== 'LOW_RR' && rc.candidate.bucket !== 'TRADE') continue;
    if (!watch.some((w) => w.lifecycleId === rc.lifecycleId)) watch.push(newFamilyWatch(rc));
  }
  return { status: 'EVALUATED', session, newestBarTime: series.bars[end].time, end, todo, routed, events: log.events, linkage, observeSelections: fixed, observeSelectionsChanged: changed, paper, watch, triggerFailures };
}

/**
 * Evaluates the newly closed bars of today's session. Returns the PAPER-stage
 * candidates of the newest bar that would trade (normally none), or null on
 * any failure. SHADOW candidates are recorded once each. The decision itself
 * is evaluateFamiliesCore; this shell reads the router's state (unless the
 * caller already read it — the decision snapshot does) and writes it back.
 */
export async function routeTriggerFamilies(args: { underlying: string; exchange: Exchange; mode: TradingMode; bars: MomentumBar[]; chain: OptionChain | null; now: number; state?: FamilyRouterState | null }): Promise<{ paper: RoutedCandidate[]; evaluated: number; linkage?: ParentLinkage | null; watch?: FamilyWatchEntry[]; triggerFailures?: number } | null> {
  const { underlying, exchange, mode, bars, chain, now } = args;
  try {
    const stages = liveTriggerStages();
    const session = familyRouterSession({ exchange, mode, bars, now, ids: liveRoutedTriggerIds(stages) });
    if (!session) return { paper: [], evaluated: 0 };
    const state = args.state ?? (await readFamilyRouterState(exchange, underlying, mode, session));
    const out = evaluateFamiliesCore({ underlying, exchange, mode, bars, chain, now, stages, state });
    if (out.status === 'NOT_RUN') return { paper: [], evaluated: 0 };
    if (out.status === 'NO_NEW_BAR') return { paper: [], evaluated: 0, linkage: out.linkage, watch: out.watch };
    for (const f of out.triggerFailures) logger.error({ underlying, exchange, ...f }, 'Trigger router: one trigger failed — its candidates are dropped, every other trigger still evaluated');

    if (out.observeSelectionsChanged) await redis.set(`mp_sel:observe:${exchange}:${underlying}:${session}`, JSON.stringify(out.observeSelections), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    const todoSet = new Set(out.todo);
    for (const rc of out.routed) {
      if (!todoSet.has(rc.candidate.decisionIndex)) continue;
      await recordCandidate(underlying, exchange, rc, rc.candidate.decisionIndex === out.end);
    }
    await redis.set(familyWatchKey(exchange, underlying, session), JSON.stringify(out.watch), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    await redis.set(`mp_link:${exchange}:${underlying}:${session}`, JSON.stringify(out.linkage), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    await redis.set(`mp_eval:${exchange}:${underlying}:${mode}`, String(out.newestBarTime), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    return { paper: out.paper, evaluated: out.todo.length, linkage: out.linkage, watch: out.watch, triggerFailures: out.triggerFailures.length };
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange }, 'Trigger router: evaluation failed — structure and consensus engines unaffected');
    return null;
  }
}

async function recordCandidate(underlying: string, exchange: Exchange, rc: RoutedCandidate, newestBar: boolean): Promise<void> {
  const claimed = await redis.set(`mp_cand:${rc.lifecycleId}`, '1', 'EX', CANDIDATE_DEDUPE_TTL_SECONDS, 'NX').catch(() => 'OK');
  if (claimed !== 'OK') return;
  const c = rc.candidate;
  const def = TRIGGERS_BY_ID.get(c.triggerId);
  recordSetupEvent({
    time: new Date(c.decisionTime + BAR_MS_15M),
    instrument: underlying,
    exchange,
    timeframe: '15m',
    lifecycleId: rc.lifecycleId,
    direction: c.direction,
    fromStage: null,
    toStage: 'CANDIDATE',
    reason: rc.risk.reason,
    poolType: c.t1?.kind ?? null,
    poolPrice: c.anchorPrice,
    triggerType: c.triggerId,
    entry: c.entry,
    stop: c.stop,
    t1: c.t1?.price ?? null,
    t2: c.t2?.price ?? null,
    scoreTotal: null,
    atr: c.atr,
    cost: rc.cost,
    context: {
      stage: rc.stage,
      family: c.family,
      bucket: c.bucket,
      marketState: c.marketState,
      movePotential: c.movePotential,
      timing: c.timing,
      risk: rc.risk,
      eventIds: c.eventIds,
      anchorEventId: c.anchorEventId,
      // One setup per parent move: this candidate's role, and why it was or wasn't the one.
      arbitration: rc.arbitration
        ? { parentId: rc.arbitration.parentId, role: rc.arbitration.role, reason: rc.arbitration.reason, rank: rc.arbitration.rank, selectedTriggerId: rc.arbitration.selectedTriggerId }
        : null,
      // Trading: no pre-selection here. An eligible paper-stage candidate on the newest bar goes to the
      // slot arbitration (its final role, rank and any option-build failure land as an ARBITRATION row).
      trade: {
        parentId: rc.parentId ?? null,
        anchorKeys: rc.anchorKeys ?? [],
        paperStage: PAPER_TRADING_STAGES.includes(rc.stage),
        eligible: rc.risk.wouldTrade,
        handedToSlot: newestBar && PAPER_TRADING_STAGES.includes(rc.stage) && rc.risk.wouldTrade,
        reason: rc.risk.reason,
      },
    },
    versions: { strategyVersion: EVENT_ENGINE_VERSION, triggerVersion: `${c.triggerId}-${def?.version ?? '1.0'}`, riskVersion: RISK_VERSION, optionVersion: OPTION_VERSION, costVersion: COST_VERSION },
  });
}
