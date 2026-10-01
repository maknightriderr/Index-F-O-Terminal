// ============================================================
// SLOT ARBITRATION — one paper trade per symbol, chosen across ALL engines
// ============================================================
// Every engine that can trade (S1, the indicator engine, and every trigger
// family at PAPER_RESEARCH / PAPER / ACTIVE) hands in ALL of its eligible
// candidates for the bar that just closed — no engine pre-selects. Each one
// is grouped with its true market move (parentId: the event engine's parent,
// S1 linked to it only through the canonical sweep event), then BUILT through
// its own unchanged chain — every safety gate, the option leg, liquidity,
// spread and cost — without minting. A candidate whose chain or option build
// refuses is INELIGIBLE (its reason kept); it never takes its parent down
// with it: the next-ranked candidate of the same move is still in the pool.
// The built candidates are then ranked here, ONE is minted, every other is
// recorded with its rank and the criterion it lost on. No engine wins
// because of what it is.
//
// ONE METRIC SCHEMA FOR EVERY ENGINE (decisionMetrics). Each engine states
// its decision geometry on the underlying — direction, entry, planned stop,
// objective (the nearest valid target) and the price the identified move
// started from — and ONE function measures it, with the event engine's own
// pre-registered formulas on the same closed 15m bars:
//   entry timing    entryTimingAt: how much of anchor → objective is already
//                   done at entry, and the R left → EARLY / OPTIMAL /
//                   ACCEPTABLE / LATE / CHASING (LATE / CHASING = extended)
//   remaining move  that share already done (moveConsumedPct); recorded, and
//                   it is what the timing class is cut from
//   move potential  movePotentialAt: R to the objective, liquidity obstacles
//                   in between, session range left → LOW / NORMAL / HIGH
//   net R:R         the BUILT option leg's reward:risk after the one cost
//                   model every engine's builder applies (spread, slippage,
//                   charges, brokerage)
//   entry quality   where the entry sits between planned stop and objective:
//                   (objective − entry) / (objective − stop), 0..1, higher =
//                   nearer the stop, more of the move still ahead
// Geometry per engine: families — the rule's entry, stop, T1 and anchor event
// price; S1 — the fill, the structural stop, T1 and the swept pool level (the
// same price a family's sweep anchor carries); indicator — the spot, the
// underlying move its built option stop implies, its target move (already
// capped at the room to the nearest wall or pivot) and the nearest
// structural level behind price.
//
// Ranking — PRE-REGISTERED, identical for every engine, decision-time only,
// first difference wins; never adapted to observed winners or losers:
//   1. entry timing / remaining move   (the class above)
//   2. move potential                  (the class above)
//   3. net R:R after costs
//   4. entry quality
//   5. tie-break: earlier decision bar close (the same definition for every
//      engine), then source id, then candidate id
//
// NOT_MEASURED. A metric that cannot be measured (no structural level behind
// price, no ATR, no target) is NOT_MEASURED — never an invented ACCEPTABLE,
// NORMAL or 0, and never a reason to drop the candidate. A criterion 1–4 is
// compared only when EVERY candidate in the pool measured it; otherwise it is
// skipped for the whole pool (the record lists it), and the comparison moves
// to the next shared criterion. Skipping is per pool, not per pair: a
// pairwise rule is not transitive (A beats B on timing, B beats C on R:R, C
// beats A on R:R because A vs C skipped timing) and would have no well-defined
// winner. The pool rule always has one, and a missing measurement can neither
// win nor lose anything.
// ============================================================

import {
  entryTimingAt,
  movePotentialAt,
  prepareMomentumSeries,
  buildSeriesContext,
  type EntryTimingClass,
  type MovePotentialClass,
  type MomentumBar,
  type SeriesContext,
} from '@fno/analytics';
import type { BiasDirection, TradeSetup } from '@fno/shared';
import type { LiveLifecycle } from './structure-live.js';
import type { RoutedCandidate } from './trigger-router.js';
import { logger } from '../lib/logger.js';

const BAR_MS_15M = 15 * 60 * 1000;

export const NOT_MEASURED = 'NOT_MEASURED' as const;
export type NotMeasured = typeof NOT_MEASURED;
export type Measured<T> = T | NotMeasured;

/** The common decision-time metrics every candidate carries, whatever engine produced it. */
export interface DecisionMetrics {
  timingClass: Measured<EntryTimingClass>;
  /** Remaining move: share of the identified move (anchor → objective) already done at entry. */
  moveConsumedPct: Measured<number>;
  movePotential: Measured<MovePotentialClass>;
  /** Distance from entry to the objective, in the bar ATR (recorded). */
  objectiveDistanceAtr: Measured<number>;
  /** Reward:risk after costs of the BUILT option setup (NOT_MEASURED before the build). */
  netRR: Measured<number>;
  /** (objective − entry) / (objective − stop) on the underlying: 0..1, higher = better location. */
  entryQuality: Measured<number>;
}

export interface SlotCandidate extends DecisionMetrics {
  /** 'S1', 'INDICATOR', or a trigger id ('A3', 'B2', …). */
  source: string;
  /** The candidate's own id (lifecycle id; the indicator's per-bar id). */
  candidateId: string;
  direction: BiasDirection;
  /** The market move it belongs to; null = not anchored on a market event (the indicator engine). */
  parentId: string | null;
  /** The parent id and the canonical events it is anchored on — what the traded-parent guard matches. */
  anchorKeys: readonly string[];
  /** Supporting events in the candidate's own sequence — recorded only, never ranked (not every engine has events). */
  evidence: Measured<number>;
  /** Close (epoch ms) of the newest 15m bar closed at the decision — one definition for every engine. */
  decisionTime: number;
}

/** An engine's decision geometry on the underlying — the only input decisionMetrics reads. */
export interface DecisionGeometry {
  direction: 'BULLISH' | 'BEARISH';
  entry: number;
  stop: number | null;
  /** The nearest valid objective (T1 / the target move's level). */
  objective: number | null;
  /** Where the identified move started (anchor event price / swept level / nearest structural level behind). */
  anchor: number | null;
  /** Decided on the anchor's own bar (EARLY is only possible then). */
  onAnchorBar: boolean;
}

/** The closed 15m bars at the decision, as the event engine reads them: the newest closed bar and its ATR. */
export interface MetricsContext {
  ctx: SeriesContext;
  s: number;
  i: number;
  atr: number | null;
}

/** The metrics context for today's session from closed 15m bars only (null without today's bars). */
export function buildMetricsContext(closedBars: readonly MomentumBar[], today: string): MetricsContext | null {
  if (closedBars.length < 2) return null;
  const series = prepareMomentumSeries([...closedBars]);
  const s = series.sessionStarts.length - 1;
  if (s < 0 || series.sessionDates[s] !== today) return null;
  const ctx = buildSeriesContext(series);
  const i = ctx.sessionEnd(s);
  const atr = ctx.atrAt(i);
  return { ctx, s, i, atr: atr != null && atr > 0 ? atr : null };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * THE metric function, for every engine. Reads only the geometry and the
 * closed bars up to the decision bar; anything it cannot measure is NOT_MEASURED.
 */
export function decisionMetrics(g: DecisionGeometry, m: MetricsContext | null, netRR: number | null = null): DecisionMetrics {
  const sg = g.direction === 'BULLISH' ? 1 : -1;
  const risk = g.stop != null && Number.isFinite(g.stop) ? (g.entry - g.stop) * sg : null;
  const reward = g.objective != null && Number.isFinite(g.objective) ? (g.objective - g.entry) * sg : null;
  const geometryOk = risk != null && risk > 0 && reward != null && reward > 0;
  const rToObjective = geometryOk ? round3(reward! / risk!) : null;
  const atr = m?.atr ?? null;
  const timing =
    geometryOk && atr != null && g.anchor != null && Number.isFinite(g.anchor)
      ? entryTimingAt({ direction: g.direction, anchorIndex: g.onAnchorBar ? 1 : 0, anchorPrice: g.anchor, decisionIndex: 1, entry: g.entry, atr, t1: g.objective, rToT1: rToObjective })
      : null;
  const potential = geometryOk && m != null && atr != null ? movePotentialAt(m.ctx, m.s, m.i, { direction: g.direction, entry: g.entry, atr, t1: g.objective, t2: null, rToT1: rToObjective }) : null;
  return {
    timingClass: timing?.class ?? NOT_MEASURED,
    moveConsumedPct: timing?.moveConsumedPct ?? NOT_MEASURED,
    movePotential: potential?.class ?? NOT_MEASURED,
    objectiveDistanceAtr: reward != null && reward > 0 && atr != null ? round3(reward / atr) : NOT_MEASURED,
    netRR: netRR != null && Number.isFinite(netRR) ? netRR : NOT_MEASURED,
    entryQuality: geometryOk ? round3(reward! / (reward! + risk!)) : NOT_MEASURED,
  };
}

const TIMING_RANK: Record<string, number> = { OPTIMAL: 0, EARLY: 1, ACCEPTABLE: 2, LATE: 3, CHASING: 4 };
const POTENTIAL_RANK: Record<string, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

/** A criterion as a "lower is better" number, or NOT_MEASURED. */
interface Criterion {
  name: string;
  value: (c: SlotCandidate) => Measured<number>;
}
const num = (v: Measured<number>, sign: 1 | -1): Measured<number> => (v === NOT_MEASURED || !Number.isFinite(v) ? NOT_MEASURED : sign * v);
const ranked = (v: string, table: Record<string, number>): Measured<number> => (v in table ? table[v] : NOT_MEASURED);

/** The pre-registered ranking, in order. Identical for every engine; never adapted to outcomes. */
export const MEASURED_CRITERIA: readonly Criterion[] = [
  { name: 'entry timing', value: (c) => ranked(c.timingClass, TIMING_RANK) },
  { name: 'move potential', value: (c) => ranked(c.movePotential, POTENTIAL_RANK) },
  { name: 'net R:R after costs', value: (c) => num(c.netRR, -1) },
  { name: 'entry quality', value: (c) => num(c.entryQuality, -1) },
];

/** Which of criteria 1–4 every candidate in the pool actually measured. */
export function sharedCriteria(pool: readonly SlotCandidate[]): { used: string[]; skipped: string[] } {
  const used: string[] = [];
  const skipped: string[] = [];
  for (const k of MEASURED_CRITERIA) (pool.every((c) => k.value(c) !== NOT_MEASURED) ? used : skipped).push(k.name);
  return { used, skipped };
}

/** Negative = `a` is better, on the given shared criteria then the always-measured ones; the criterion that decided it. */
export function compareSlotCandidates(a: SlotCandidate, b: SlotCandidate, used: readonly string[]): { cmp: number; criterion: string } {
  for (const k of MEASURED_CRITERIA) {
    if (!used.includes(k.name)) continue;
    const va = k.value(a);
    const vb = k.value(b);
    // `used` guarantees both are measured; the guard keeps a misuse from comparing NOT_MEASURED.
    if (va === NOT_MEASURED || vb === NOT_MEASURED) continue;
    if (va !== vb) return { cmp: va - vb, criterion: k.name };
  }
  if (a.decisionTime !== b.decisionTime) return { cmp: a.decisionTime - b.decisionTime, criterion: 'earlier decision bar' };
  const bySource = a.source.localeCompare(b.source);
  if (bySource !== 0) return { cmp: bySource, criterion: 'source tie-break' };
  return { cmp: a.candidateId.localeCompare(b.candidateId), criterion: 'candidate id tie-break' };
}

/** The pool's order (best first), the criteria used / skipped, and what each other candidate lost to the winner on. */
export function rankSlotCandidates(cands: readonly SlotCandidate[]): { winner: number; order: number[]; used: string[]; skipped: string[]; lostOn: Map<number, string> } {
  const { used, skipped } = sharedCriteria(cands);
  const order = cands.map((_, i) => i).sort((x, y) => compareSlotCandidates(cands[x], cands[y], used).cmp);
  const winner = order[0];
  const lostOn = new Map<number, string>();
  for (const i of order.slice(1)) lostOn.set(i, compareSlotCandidates(cands[winner], cands[i], used).criterion);
  return { winner, order, used, skipped, lostOn };
}

/** The reason recorded on a candidate that built cleanly but was not selected. */
export function notSelectedReason(loser: SlotCandidate, winner: SlotCandidate, criterion: string, skipped: readonly string[] = []): string {
  const notCompared = skipped.length ? ` Not compared (NOT_MEASURED by at least one candidate in this check): ${skipped.join(', ')}.` : '';
  return `Not selected: ${winner.source} ranked higher on ${criterion} for this symbol's one paper-trade slot.${notCompared}`;
}

// ---------------- candidates per engine (all through decisionMetrics) ----------------

/** S1's geometry: the fill, its structural stop, T1, and the swept pool level (where the move started). */
export function structureGeometry(lc: Pick<LiveLifecycle, 'direction' | 'stop' | 't1' | 'pool'>, spot: number): DecisionGeometry {
  return { direction: lc.direction, entry: spot, stop: lc.stop, objective: lc.t1?.price ?? null, anchor: lc.pool?.price ?? null, onAnchorBar: false };
}

/** S1's slot candidate. Evidence (recorded only) = the Tier-1 events the sequence holds (sweep, displacement, zone). */
export function structureSlotCandidate(
  lc: LiveLifecycle,
  spot: number,
  netRR: number | null,
  link: { parentId: string | null; anchorKeys: readonly string[]; decisionTime: number },
  metrics: MetricsContext | null = null
): SlotCandidate {
  return {
    source: lc.triggerId ?? 'S1',
    candidateId: lc.id,
    direction: lc.direction,
    parentId: link.parentId,
    anchorKeys: link.anchorKeys,
    ...decisionMetrics(structureGeometry(lc, spot), metrics, netRR),
    evidence: 1 + (lc.displacementBodyAtr != null ? 1 : 0) + (lc.zone ? 1 : 0),
    decisionTime: link.decisionTime,
  };
}

/** A family candidate's geometry: the rule's own entry, stop, T1 and anchor event price. */
export function routedGeometry(rc: RoutedCandidate): DecisionGeometry {
  const c = rc.candidate;
  return { direction: c.direction, entry: c.entry, stop: c.stop, objective: c.t1?.price ?? null, anchor: c.anchorPrice, onAnchorBar: c.anchorIndex === c.decisionIndex };
}

/** A family candidate's slot candidate, measured at its decision bar's close (the newest closed bar). */
export function routedSlotCandidate(rc: RoutedCandidate, metrics: MetricsContext | null = null): SlotCandidate {
  const c = rc.candidate;
  return {
    source: c.triggerId,
    candidateId: rc.lifecycleId,
    direction: c.direction,
    parentId: rc.parentId ?? null,
    anchorKeys: rc.anchorKeys ?? [],
    ...decisionMetrics(routedGeometry(rc), metrics),
    evidence: Array.isArray(c.eventIds) ? c.eventIds.length : NOT_MEASURED,
    decisionTime: c.decisionTime + BAR_MS_15M,
  };
}

/**
 * The indicator engine's geometry, from its BUILT setup and decision-time
 * structure: entry = the spot it was built at; stop = the underlying move its
 * option stop implies (stopInAtr × the ATR it was built with); objective =
 * its target move (targetInAtr × that ATR — already capped at the room to the
 * nearest wall or pivot); anchor = the nearest structural level behind price.
 * Anything missing stays null, and the metric that needs it NOT_MEASURED.
 */
export function indicatorGeometry(args: {
  direction: BiasDirection;
  spot: number;
  builtAtr: number | null;
  stopInAtr: number | null | undefined;
  targetInAtr: number | null | undefined;
  behindLevel: number | null | undefined;
}): DecisionGeometry | null {
  if (args.direction !== 'BULLISH' && args.direction !== 'BEARISH') return null;
  const sg = args.direction === 'BULLISH' ? 1 : -1;
  const atr = args.builtAtr != null && args.builtAtr > 0 ? args.builtAtr : null;
  return {
    direction: args.direction,
    entry: args.spot,
    stop: atr != null && args.stopInAtr != null && args.stopInAtr > 0 ? args.spot - sg * args.stopInAtr * atr : null,
    objective: atr != null && args.targetInAtr != null && args.targetInAtr > 0 ? args.spot + sg * args.targetInAtr * atr : null,
    anchor: args.behindLevel != null && Number.isFinite(args.behindLevel) ? args.behindLevel : null,
    onAnchorBar: false,
  };
}

/** The indicator engine's slot candidate: the same metric schema, from its geometry (all NOT_MEASURED without one). */
export function indicatorSlotCandidate(
  id: string,
  direction: BiasDirection,
  netRR: number | null,
  decisionTime: number,
  geometry: DecisionGeometry | null = null,
  metrics: MetricsContext | null = null
): SlotCandidate {
  const measured: DecisionMetrics = geometry
    ? decisionMetrics(geometry, metrics, netRR)
    : { timingClass: NOT_MEASURED, moveConsumedPct: NOT_MEASURED, movePotential: NOT_MEASURED, objectiveDistanceAtr: NOT_MEASURED, netRR: netRR ?? NOT_MEASURED, entryQuality: NOT_MEASURED };
  return {
    source: 'INDICATOR',
    candidateId: id,
    direction,
    parentId: null,
    anchorKeys: [],
    ...measured,
    evidence: NOT_MEASURED,
    decisionTime,
  };
}

// ---------------- one trade per parent move ----------------

/**
 * A parent move already traded today (by any engine) when any of the
 * candidate's anchor keys — its parent id or a canonical event it stands on —
 * was marked by an earlier trade. S1 and a family on the same sweep share the
 * sweep's event id, so a second strategy can never re-trade that move after
 * the first trade closes; a different move shares no key.
 */
export function parentAlreadyTraded(anchorKeys: readonly string[], traded: ReadonlySet<string>): boolean {
  return anchorKeys.some((k) => traded.has(k));
}

// ---------------- settle ----------------

/** A setup an engine built through its whole chain but has not minted. */
export interface DeferredSetup {
  kind: 'DEFERRED';
  setup: TradeSetup;
  slot: SlotCandidate;
  /** Mints it; `minted` = this candidate is now the slot's trade (false: another caller minted first). */
  commit: () => Promise<{ setup: TradeSetup; minted: boolean }>;
  decline: (reason: string) => Promise<void>;
}

/** A candidate its own chain refused (already recorded there); `optionBuild` = the option leg refused it. */
export interface RefusedCandidate {
  kind: 'REFUSED';
  slot: SlotCandidate;
  code: string | null;
  reason: string;
  optionBuild: boolean;
  /** The engine's own refusal result, when it has one to show (the indicator engine's). */
  setup?: TradeSetup;
}

export type SlotEntry = DeferredSetup | RefusedCandidate;

export function isDeferred(x: unknown): x is DeferredSetup {
  return x != null && (x as DeferredSetup).kind === 'DEFERRED';
}

export function isSlotEntry(x: unknown): x is SlotEntry {
  return x != null && ((x as SlotEntry).kind === 'DEFERRED' || (x as SlotEntry).kind === 'REFUSED');
}

export interface SlotArbitrationRecord {
  slot: SlotCandidate;
  role: 'SELECTED' | 'ALTERNATIVE' | 'INELIGIBLE';
  /** Rank among the built (eligible) candidates; null when ineligible. */
  rank: number | null;
  /** Rank among ALL candidates on the pre-build fields (net R:R not yet measured) — "#1 failed its build → #2". */
  preBuildRank: number;
  reason: string;
  refusalCode: string | null;
  /** The option leg's refusal, when that is what made it ineligible. */
  optionBuildFailure: string | null;
  criteriaUsed: string[];
  criteriaSkipped: string[];
}

/**
 * One paper trade per symbol: rank the built candidates, mint the best, record
 * every candidate (selected, alternative with its rank, ineligible with its
 * reason). Returns the minted setup, or null when nothing built.
 */
export async function settleSlot(args: {
  underlying: string;
  exchange: string;
  entries: readonly SlotEntry[];
  record?: (records: SlotArbitrationRecord[]) => void;
  /** Called with the winner's anchor keys once it is the slot's trade: its parent move never trades again today. */
  markTraded?: (anchorKeys: readonly string[]) => Promise<void>;
  /** Called with the winner once it is the slot's trade (e.g. to end its watch row). */
  onSelected?: (slot: SlotCandidate) => Promise<void>;
}): Promise<TradeSetup | null> {
  const { underlying, exchange, entries } = args;
  const pre = rankSlotCandidates(entries.map((e) => ({ ...e.slot, netRR: NOT_MEASURED })));
  const preBuildRank = new Map(pre.order.map((i, k) => [i, k + 1]));
  const built = entries.map((e, i) => ({ e, i })).filter((x): x is { e: DeferredSetup; i: number } => x.e.kind === 'DEFERRED');

  const records: SlotArbitrationRecord[] = [];
  for (const [i, e] of entries.entries()) {
    if (e.kind !== 'REFUSED') continue;
    records.push({
      slot: e.slot,
      role: 'INELIGIBLE',
      rank: null,
      preBuildRank: preBuildRank.get(i)!,
      reason: e.code ? `${e.code}: ${e.reason}` : e.reason,
      refusalCode: e.code,
      optionBuildFailure: e.optionBuild ? e.reason : null,
      criteriaUsed: [],
      criteriaSkipped: [],
    });
  }
  if (built.length === 0) {
    args.record?.(records);
    return null;
  }

  const r = rankSlotCandidates(built.map((x) => x.e.slot));
  const chosen = built[r.winner].e;
  logger.info(
    {
      underlying,
      exchange,
      selected: chosen.slot.source,
      criteriaUsed: r.used,
      criteriaSkipped: r.skipped,
      ranking: r.order.map((k) => ({ source: built[k].e.slot.source, parentId: built[k].e.slot.parentId, lostOn: r.lostOn.get(k) ?? null })),
      ineligible: records.map((x) => ({ source: x.slot.source, reason: x.reason })),
    },
    'Slot arbitration: one paper trade selected across engines'
  );
  const result = await chosen.commit();
  if (result.minted && chosen.slot.anchorKeys.length > 0) {
    await args.markTraded?.(chosen.slot.anchorKeys).catch((err: any) => logger.warn({ error: err.message, underlying }, 'Slot arbitration: traded-parent mark failed'));
  }
  if (result.minted) await args.onSelected?.(chosen.slot).catch((err: any) => logger.warn({ error: err.message, underlying }, 'Slot arbitration: on-selected hook failed'));
  r.order.forEach((k, pos) => {
    const x = built[k];
    records.push({
      slot: x.e.slot,
      role: pos === 0 ? 'SELECTED' : 'ALTERNATIVE',
      rank: pos + 1,
      preBuildRank: preBuildRank.get(x.i)!,
      reason: pos === 0 ? `Best of ${built.length} eligible` : notSelectedReason(x.e.slot, chosen.slot, r.lostOn.get(k)!, r.skipped),
      refusalCode: pos === 0 ? null : 'NOT_SELECTED',
      optionBuildFailure: null,
      criteriaUsed: r.used,
      criteriaSkipped: r.skipped,
    });
  });
  for (const k of r.order.slice(1)) {
    const loser = built[k].e;
    await loser.decline(notSelectedReason(loser.slot, chosen.slot, r.lostOn.get(k)!, r.skipped)).catch((err: any) =>
      logger.warn({ error: err.message, underlying, source: loser.slot.source }, 'Slot arbitration: NOT_SELECTED record failed')
    );
  }
  args.record?.(records);
  return result.setup;
}
