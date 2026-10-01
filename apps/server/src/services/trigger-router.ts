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
  rebuildCandidateAt,
  STRUCTURE_RULES,
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
  /** TRADE = valid stop, a real untaken target ≥ 1.5R; anything else is the reason it would not trade. */
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

/**
 * Pure: the parent linkage of a session — every candidate's anchor event and
 * its ancestors mapped to the candidate's parent (first parent wins, in
 * chronological order), and the session's sweep events.
 */
export function buildParentLinkage(session: string, parents: readonly Pick<ParentSetup, 'parentId' | 'candidates'>[], all: readonly TriggerCandidate[], events: readonly MarketEvent[]): ParentLinkage {
  const byId = new Map(events.map((e) => [e.id, e]));
  const parentOfKey: Record<string, string> = {};
  for (const p of parents) {
    parentOfKey[p.parentId] ??= p.parentId;
    for (const idx of p.candidates) for (const k of eventChain(all[idx].anchorEventId, byId)) parentOfKey[k] ??= p.parentId;
  }
  const sweeps: SweepRef[] = events
    .filter((e) => e.type === 'SWEEP' && e.direction != null && e.level != null)
    .map((e) => ({ eventId: e.id, direction: e.direction as 'BULLISH' | 'BEARISH', time: e.time, levelKind: e.level!.kind, levelPrice: e.level!.price }));
  return { session, sweeps, parentOfKey };
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
  const parentId = linkage.parentOfKey[sweep.eventId] ?? `${linkage.session}:${lc.direction}:${sweep.eventId}`;
  return { parentId, anchorKeys: [parentId, sweep.eventId], linked: true };
}

// ---------------- keep-alive: a confirmed family candidate below 1.50R ----------------

/** How many closed bars a kept-alive family candidate stays re-checkable: S1's own fill window (user decision 2026-10-01). */
export const FAMILY_WATCH_BARS: number = STRUCTURE_RULES.fillWithinBars;

/** A confirmed family candidate kept alive under its ORIGINAL lifecycle id. */
export interface FamilyWatchEntry {
  lifecycleId: string;
  /** The candidate as the rule decided it (its hit: anchor, events, stopRef). */
  original: TriggerCandidate;
  parentId: string | null;
  anchorKeys: string[];
  cause: 'LOW_RR_AT_DECISION' | 'RR_REFUSED_AT_FILL';
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

/** Pure: a new watch entry for a confirmed candidate below 1.50R. */
export function newFamilyWatch(rc: RoutedCandidate, cause: FamilyWatchEntry['cause']): FamilyWatchEntry {
  return { lifecycleId: rc.lifecycleId, original: rc.candidate, parentId: rc.parentId ?? null, anchorKeys: rc.anchorKeys ?? [], cause, current: null, lastIndex: rc.candidate.decisionIndex, ended: null };
}

/** Keeps a family candidate the slot refused for R:R alone (it was confirmed): re-checked from the next closed bar. */
export async function keepFamilyAlive(exchange: Exchange, underlying: string, rc: RoutedCandidate): Promise<void> {
  const key = familyWatchKey(exchange, underlying, rc.candidate.session);
  try {
    const list: FamilyWatchEntry[] = JSON.parse((await redis.get(key)) ?? '[]');
    const existing = list.find((w) => w.lifecycleId === rc.lifecycleId);
    if (existing) {
      // Already kept alive: it stays under its id; the refusal only means "not yet".
      existing.lastIndex = Math.max(existing.lastIndex, rc.candidate.decisionIndex);
    } else list.push(newFamilyWatch(rc, 'RR_REFUSED_AT_FILL'));
    await redis.set(key, JSON.stringify(list), 'EX', EVAL_STATE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange, lifecycleId: rc.lifecycleId }, 'Trigger router: keep-alive write failed');
  }
}

/** Ends a kept-alive family candidate (it traded, or its parent move already did). No-op when it was never kept. */
export async function endFamilyWatch(exchange: Exchange, underlying: string, session: string, lifecycleId: string, reason: string, at: number): Promise<void> {
  const key = familyWatchKey(exchange, underlying, session);
  try {
    const list: FamilyWatchEntry[] = JSON.parse((await redis.get(key)) ?? '[]');
    const w = list.find((x) => x.lifecycleId === lifecycleId);
    if (!w || w.ended) return;
    w.ended = { reason, at };
    await redis.set(key, JSON.stringify(list), 'EX', EVAL_STATE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange, lifecycleId }, 'Trigger router: keep-alive end failed');
  }
}

/**
 * Pure: the kept-alive family candidates that clear every router check on
 * bar `end` (bucket TRADE = R:R ≥ 1.50R at the rebuilt entry, cost within the
 * ceiling), handed to the slot under their ORIGINAL id, parent and anchors.
 */
export function recoveredFamilyCandidates(
  watch: readonly FamilyWatchEntry[],
  end: number,
  stages: Record<string, LiveTriggerStage>,
  chain: OptionChain | null,
  already: readonly RoutedCandidate[]
): RoutedCandidate[] {
  const out: RoutedCandidate[] = [];
  for (const w of watch) {
    if (w.ended || !w.current || w.current.decisionIndex !== end || w.current.bucket !== 'TRADE') continue;
    const stage = stages[w.original.triggerId];
    if (!PAPER_TRADING_STAGES.includes(stage) || already.some((p) => p.lifecycleId === w.lifecycleId)) continue;
    const cost = costOnChain(w.current, chain);
    const risk = validateCandidateRisk(w.current, { sessionOk: true, costPct: cost?.costPctOfPremium != null ? Math.round(cost.costPctOfPremium * 100) / 100 : null, maxCostPct: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM });
    if (risk.wouldTrade) out.push({ candidate: w.current, stage, risk, cost, lifecycleId: w.lifecycleId, parentId: w.parentId, anchorKeys: w.anchorKeys });
  }
  return out;
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
  const reasons: string[] = [];
  if (c.bucket !== 'TRADE') reasons.push(c.bucket === 'LOW_RR' ? `LOW_RR: T1 only ${c.rToT1}R away (needs 1.5R)` : c.bucket === 'NO_TARGET' ? 'NO_TARGET: no untaken pool ahead' : 'INVALID_STOP');
  if (!args.sessionOk) reasons.push('SESSION_GUARD: outside the allowed entry window');
  if (costOk === false) reasons.push(`COST_TOO_HIGH: ~${args.costPct}% of premium round trip`);
  return {
    bucket: c.bucket,
    sessionOk: args.sessionOk,
    costPct: args.costPct,
    costOk,
    wouldTrade: c.bucket === 'TRADE' && args.sessionOk && costOk !== false,
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
function costOnChain(c: TriggerCandidate, chain: OptionChain | null): SetupCostMeasurement | null {
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

/**
 * Evaluates the newly closed bars of today's session. Returns the PAPER-stage
 * candidates of the newest bar that would trade (normally none), or null on
 * any failure. SHADOW candidates are recorded once each.
 */
export async function routeTriggerFamilies(args: { underlying: string; exchange: Exchange; mode: TradingMode; bars: MomentumBar[]; chain: OptionChain | null; now: number }): Promise<{ paper: RoutedCandidate[]; evaluated: number; linkage?: ParentLinkage | null; watch?: FamilyWatchEntry[] } | null> {
  const { underlying, exchange, mode, bars, chain, now } = args;
  try {
    if (mode !== 'INTRADAY' || bars.length < 30) return { paper: [], evaluated: 0 };
    const stages = liveTriggerStages();
    const ids = liveRoutedTriggerIds(stages);
    if (ids.length === 0) return { paper: [], evaluated: 0 };

    const series = prepareMomentumSeries(bars);
    const s = series.sessionStarts.length - 1;
    const session = series.sessionDates[s];
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (session !== today) return { paper: [], evaluated: 0 };
    const window = getSessionWindow(exchange, session);
    if (!window) return { paper: [], evaluated: 0 };

    const stateKey = `mp_eval:${exchange}:${underlying}:${mode}`;
    const linkKey = `mp_link:${exchange}:${underlying}:${session}`;
    const lastDone = Number((await redis.get(stateKey).catch(() => null)) ?? 0);
    const ctx = buildSeriesContext(series);
    const start = series.sessionStarts[s];
    const end = ctx.sessionEnd(s);
    const todo: number[] = [];
    for (let i = Math.max(start, end - MAX_CATCHUP_BARS + 1); i <= end; i++) if (series.bars[i].time > lastDone) todo.push(i);
    if (todo.length === 0) {
      // No new bar: the linkage written when the newest bar was evaluated is still exact (parents only change on a new bar).
      const cached = await redis.get(linkKey).catch(() => null);
      const watched = await redis.get(familyWatchKey(exchange, underlying, session)).catch(() => null);
      return { paper: [], evaluated: 0, linkage: cached ? (JSON.parse(cached) as ParentLinkage) : null, watch: watched ? (JSON.parse(watched) as FamilyWatchEntry[]) : [] };
    }

    const log = runSessionEvents(ctx, s);
    const closingGuardMs = STRUCTURE_PARAMS.STRUCTURE_CLOSING_GUARD_MIN * 60 * 1000;
    const todoSet = new Set(todo);

    // 1. Every trigger, independently, on every bar of today's session so far
    //    (each rule reads only bars up to its own decision bar). One rule
    //    failing — no displacement, no target — never stops another.
    const all: TriggerCandidate[] = [];
    for (let i = start; i <= end; i++) all.push(...evaluateTriggersAt(ctx, log, i, ids));

    // 2. Qualify each: risk geometry, session window, and option cost on the
    //    live quote (only meaningful for the bar that just closed).
    const routed: RoutedCandidate[] = all.map((c) => {
      const barTime = c.decisionTime;
      const sessionOk = barTime - window.open >= SETTLE_MS && window.close - (barTime + BAR_MS_15M) >= closingGuardMs;
      const cost = c.decisionIndex === end ? costOnChain(c, chain) : null;
      const risk = validateCandidateRisk(c, { sessionOk, costPct: cost?.costPctOfPremium != null ? Math.round(cost.costPctOfPremium * 100) / 100 : null, maxCostPct: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM });
      return { candidate: c, stage: stages[c.triggerId], risk, cost, lifecycleId: routedLifecycleId(exchange, underlying, c) };
    });

    // 3. Group by parent move, then 4. arbitrate one setup per parent — once
    //    for observation (SHADOW and up) and once for trading (PAPER and up).
    //    A bar settled by an earlier evaluation keeps its verdict: its
    //    selection (if any) is persisted, and its other candidates cannot be
    //    re-selected with hindsight.
    const parents = groupIntoParents(all, new Map([[session, log]]));
    const linkage = buildParentLinkage(session, parents, all, log.events);
    const parentOf = new Map<number, string>();
    for (const p of parents) for (const idx of p.candidates) parentOf.set(idx, p.parentId);
    const arbitrate = async (modeKey: 'observe' | 'trade', allowed: LiveTriggerStage[]) => {
      const selKey = `mp_sel:${modeKey}:${exchange}:${underlying}:${session}`;
      const fixed: Record<string, FixedSelection> = JSON.parse((await redis.get(selKey).catch(() => null)) ?? '{}');
      const decisions = arbitrateParents(parents, all, (idx) => {
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
      for (const [idx, d] of decisions) {
        const c = all[idx];
        if (d.role === 'SELECTED' && todoSet.has(c.decisionIndex) && !fixed[d.parentId]) {
          fixed[d.parentId] = { triggerId: c.triggerId, decisionIndex: c.decisionIndex };
          changed = true;
        }
      }
      if (changed) await redis.set(selKey, JSON.stringify(fixed), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
      return decisions;
    };
    const observed = await arbitrate('observe', ['SHADOW', ...PAPER_TRADING_STAGES]);

    // 5. Record every new candidate with its observation role and parent; hand
    //    the slot EVERY eligible paper-stage candidate of the bar that just
    //    closed — the trading choice is made there, across all engines.
    for (let idx = 0; idx < all.length; idx++) {
      const rc = routed[idx];
      rc.parentId = parentOf.get(idx) ?? null;
      rc.anchorKeys = rc.parentId ? anchorKeysOf(rc.parentId, rc.candidate, log.events) : [];
      if (!todoSet.has(rc.candidate.decisionIndex)) continue;
      rc.arbitration = observed.get(idx) ?? null;
      await recordCandidate(underlying, exchange, rc, rc.candidate.decisionIndex === end);
    }
    const paper = paperCandidatesForSlot(routed, end);

    // 6. Keep-alive. A paper-stage candidate CONFIRMED on the newest bar (a
    //    valid stop and target) but below 1.50R is not forgotten: it is kept
    //    under its id and re-measured on every later closed bar with the
    //    rule's own builder; once it clears every check it goes to the slot
    //    with the others, under the same id and parent.
    const sessionOkAt = (i: number) => series.bars[i].time - window.open >= SETTLE_MS && window.close - (series.bars[i].time + BAR_MS_15M) >= closingGuardMs;
    const watchKey = familyWatchKey(exchange, underlying, session);
    let watch: FamilyWatchEntry[] = JSON.parse((await redis.get(watchKey).catch(() => null)) ?? '[]');
    watch = advanceFamilyWatch(watch, ctx, log, end, sessionOkAt);
    for (const rc of routed) {
      if (rc.candidate.decisionIndex !== end || rc.candidate.bucket !== 'LOW_RR' || !PAPER_TRADING_STAGES.includes(rc.stage) || !rc.risk.sessionOk) continue;
      if (!watch.some((w) => w.lifecycleId === rc.lifecycleId)) watch.push(newFamilyWatch(rc, 'LOW_RR_AT_DECISION'));
    }
    paper.push(...recoveredFamilyCandidates(watch, end, stages, chain, paper));
    await redis.set(watchKey, JSON.stringify(watch), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);

    await redis.set(linkKey, JSON.stringify(linkage), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    await redis.set(stateKey, String(series.bars[end].time), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    return { paper, evaluated: todo.length, linkage, watch };
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
