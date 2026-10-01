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
// Ranking — decision-time fields only, first difference wins:
//   1. entry timing    OPTIMAL > EARLY > ACCEPTABLE > LATE > CHASING
//   2. move potential  HIGH > NORMAL > LOW
//   3. remaining move  more of a typical session range left
//   4. net R:R         the BUILT option leg's reward:risk after costs
//   5. evidence        supporting events in the candidate's own sequence
//   6. decision bar    earlier close of the decision bar (same definition
//                      for every engine: the newest 15m bar closed at the
//                      decision)
//   7. tie-break       source id, then candidate id (alphabetical)
//
// NOT_MEASURED. A metric an engine does not compute is NOT_MEASURED — never
// an invented ACCEPTABLE, NORMAL or 0. A criterion 1–5 is compared only when
// EVERY candidate in the pool has a real measurement of it; otherwise it is
// skipped for the whole pool (and the record lists it as skipped), and the
// comparison moves to the next shared criterion. Skipping is decided per
// pool, not per pair: a pairwise rule is not transitive (A beats B on timing,
// B beats C on R:R, C beats A on R:R because A vs C skipped timing), and a
// non-transitive order has no well-defined winner. The pool rule always has
// one, and a missing measurement can neither win nor lose anything.
// ============================================================

import { entryTimingAt, type EntryTimingClass, type MovePotentialClass } from '@fno/analytics';
import type { BiasDirection, TradeSetup } from '@fno/shared';
import type { LiveLifecycle } from './structure-live.js';
import type { RoutedCandidate } from './trigger-router.js';
import { logger } from '../lib/logger.js';

const BAR_MS_15M = 15 * 60 * 1000;

export const NOT_MEASURED = 'NOT_MEASURED' as const;
export type NotMeasured = typeof NOT_MEASURED;
export type Measured<T> = T | NotMeasured;

export interface SlotCandidate {
  /** 'S1', 'INDICATOR', or a trigger id ('A3', 'B2', …). */
  source: string;
  /** The candidate's own id (lifecycle id; the indicator's per-bar id). */
  candidateId: string;
  direction: BiasDirection;
  /** The market move it belongs to; null = not anchored on a market event (the indicator engine). */
  parentId: string | null;
  /** The parent id and the canonical events it is anchored on — what the traded-parent guard matches. */
  anchorKeys: readonly string[];
  timingClass: Measured<EntryTimingClass>;
  movePotential: Measured<MovePotentialClass>;
  remainingMovePct: Measured<number>;
  /** Reward:risk after costs of the BUILT option setup (NOT_MEASURED before the build). */
  netRR: Measured<number>;
  /** Supporting events in the candidate's own sequence. */
  evidence: Measured<number>;
  /** Close (epoch ms) of the newest 15m bar closed at the decision — one definition for every engine. */
  decisionTime: number;
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

export const MEASURED_CRITERIA: readonly Criterion[] = [
  { name: 'entry timing', value: (c) => ranked(c.timingClass, TIMING_RANK) },
  { name: 'move potential', value: (c) => ranked(c.movePotential, POTENTIAL_RANK) },
  { name: 'remaining move', value: (c) => num(c.remainingMovePct, -1) },
  { name: 'net R:R after costs', value: (c) => num(c.netRR, -1) },
  { name: 'evidence', value: (c) => num(c.evidence, -1) },
];

/** Which of criteria 1–5 every candidate in the pool actually measured. */
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

// ---------------- candidates per engine ----------------

/**
 * S1's rank inputs at the fill, with the families' own formula (entryTimingAt:
 * anchor = the sweep extreme, entry = the fill, R left = T1 vs the structural
 * stop from the fill). Move potential and remaining move need the session's
 * range history, which this chain does not carry: NOT_MEASURED. Evidence = the
 * Tier-1 events the sequence actually holds (sweep, displacement, zone).
 */
export function structureSlotCandidate(
  lc: LiveLifecycle,
  spot: number,
  netRR: number | null,
  link: { parentId: string | null; anchorKeys: readonly string[]; decisionTime: number }
): SlotCandidate {
  const risk = lc.stop != null ? Math.abs(spot - lc.stop) : 0;
  const rToT1 = lc.t1 && risk > 0 ? Math.round((Math.abs(lc.t1.price - spot) / risk) * 1000) / 1000 : null;
  const timing = lc.atr > 0
    ? entryTimingAt({ direction: lc.direction, anchorIndex: 0, anchorPrice: lc.sweepExtreme, decisionIndex: 1, entry: spot, atr: lc.atr, t1: lc.t1?.price ?? null, rToT1 })
    : null;
  return {
    source: lc.triggerId ?? 'S1',
    candidateId: lc.id,
    direction: lc.direction,
    parentId: link.parentId,
    anchorKeys: link.anchorKeys,
    timingClass: timing?.class ?? NOT_MEASURED,
    movePotential: NOT_MEASURED,
    remainingMovePct: NOT_MEASURED,
    netRR: netRR ?? NOT_MEASURED,
    evidence: 1 + (lc.displacementBodyAtr != null ? 1 : 0) + (lc.zone ? 1 : 0),
    decisionTime: link.decisionTime,
  };
}

/** A router candidate's rank inputs, as the event engine measured them at its decision bar's close. */
export function routedSlotCandidate(rc: RoutedCandidate): SlotCandidate {
  const c = rc.candidate;
  return {
    source: c.triggerId,
    candidateId: rc.lifecycleId,
    direction: c.direction,
    parentId: rc.parentId ?? null,
    anchorKeys: rc.anchorKeys ?? [],
    timingClass: c.timing?.class ?? NOT_MEASURED,
    movePotential: c.movePotential?.class ?? NOT_MEASURED,
    remainingMovePct: c.movePotential?.remainingMovePct ?? NOT_MEASURED,
    netRR: NOT_MEASURED,
    evidence: Array.isArray(c.eventIds) ? c.eventIds.length : NOT_MEASURED,
    decisionTime: c.decisionTime + BAR_MS_15M,
  };
}

/** The indicator engine: no anchor event, so no timing, move potential, remaining move or event evidence. */
export function indicatorSlotCandidate(id: string, direction: BiasDirection, netRR: number | null, decisionTime: number): SlotCandidate {
  return {
    source: 'INDICATOR',
    candidateId: id,
    direction,
    parentId: null,
    anchorKeys: [],
    timingClass: NOT_MEASURED,
    movePotential: NOT_MEASURED,
    remainingMovePct: NOT_MEASURED,
    netRR: netRR ?? NOT_MEASURED,
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
