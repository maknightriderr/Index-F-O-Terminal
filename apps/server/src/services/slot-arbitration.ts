// ============================================================
// SLOT ARBITRATION — one paper trade per symbol, chosen across ALL engines
// ============================================================
// Every engine that can trade (S1, the indicator engine, and the trigger
// families at PAPER / PAPER_RESEARCH) first BUILDS its setup through its own
// unchanged chain — every safety gate, the option leg, liquidity, spread and
// cost — without minting it. The built, eligible candidates are then ranked
// here and only the winner is minted; every other one is recorded as not
// selected, with the criterion it lost on. No engine wins because of what it
// is: S1 has no priority over a trigger family or the indicator engine.
//
// Decision-time fields only, first difference wins:
//   1. entry timing    OPTIMAL > EARLY > ACCEPTABLE > LATE > CHASING
//   2. move potential  HIGH > NORMAL > LOW, then more remaining session range
//   3. net R:R         the built option leg's reward:risk after costs
//   4. evidence        supporting events in the candidate's sequence
//   5. tie-break       earliest decision, then source id (alphabetical)
// A field an engine does not measure (the indicator engine has no anchor,
// so no entry timing or move potential) counts as neutral — ACCEPTABLE /
// NORMAL — and is stated as such in the record; it never wins or loses
// on a value nobody measured.
// ============================================================

import { entryTimingAt, type EntryTimingClass, type MovePotentialClass } from '@fno/analytics';
import type { TradeSetup } from '@fno/shared';
import type { LiveLifecycle } from './structure-live.js';
import type { RoutedCandidate } from './trigger-router.js';
import { logger } from '../lib/logger.js';

const BAR_MS_15M = 15 * 60 * 1000;

export interface SlotCandidate {
  /** 'S1', 'INDICATOR', or a trigger id ('A3', 'B2', …). */
  source: string;
  timingClass: EntryTimingClass | null;
  movePotential: MovePotentialClass | null;
  remainingMovePct: number | null;
  /** Reward:risk after costs of the BUILT option setup. */
  netRR: number | null;
  /** Supporting events in the candidate's own sequence (0 when not measured). */
  evidence: number;
  /** When the candidate was decided (epoch ms). */
  decisionTime: number;
}

const TIMING_RANK: Record<string, number> = { OPTIMAL: 0, EARLY: 1, ACCEPTABLE: 2, LATE: 3, CHASING: 4 };
const POTENTIAL_RANK: Record<string, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

/** Negative = `a` is better; the criterion that decided it. */
export function compareSlotCandidates(a: SlotCandidate, b: SlotCandidate): { cmp: number; criterion: string } {
  const steps: Array<[number, string]> = [
    [TIMING_RANK[a.timingClass ?? 'ACCEPTABLE'] - TIMING_RANK[b.timingClass ?? 'ACCEPTABLE'], 'entry timing'],
    [POTENTIAL_RANK[a.movePotential ?? 'NORMAL'] - POTENTIAL_RANK[b.movePotential ?? 'NORMAL'], 'move potential'],
    [a.remainingMovePct != null && b.remainingMovePct != null ? b.remainingMovePct - a.remainingMovePct : 0, 'remaining move'],
    [(b.netRR ?? -Infinity) - (a.netRR ?? -Infinity), 'net R:R after costs'],
    [b.evidence - a.evidence, 'evidence'],
    [a.decisionTime - b.decisionTime, 'earlier decision'],
    [a.source.localeCompare(b.source), 'source tie-break'],
  ];
  for (const [d, criterion] of steps) if (d !== 0 && Number.isFinite(d)) return { cmp: d, criterion };
  return { cmp: 0, criterion: 'identical' };
}

/** The ranking: the winner first; each loser with why it lost to the winner. */
export function rankSlotCandidates(cands: readonly SlotCandidate[]): { winner: number; ranked: number[]; lostOn: Map<number, string> } {
  const ranked = cands.map((_, i) => i).sort((x, y) => compareSlotCandidates(cands[x], cands[y]).cmp);
  const winner = ranked[0];
  const lostOn = new Map<number, string>();
  for (const i of ranked.slice(1)) lostOn.set(i, compareSlotCandidates(cands[winner], cands[i]).criterion);
  return { winner, ranked, lostOn };
}

/** The reason recorded on a candidate that built cleanly but was not selected. */
export function notSelectedReason(loser: SlotCandidate, winner: SlotCandidate, criterion: string): string {
  const unmeasured = [loser.timingClass == null ? 'entry timing' : null, loser.movePotential == null ? 'move potential' : null].filter(Boolean);
  const neutral = unmeasured.length ? ` (${unmeasured.join(' and ')} not measured for ${loser.source}: counted neutral)` : '';
  return `Not selected: ${winner.source} ranked higher on ${criterion} for this symbol's one paper-trade slot${neutral}.`;
}

/**
 * S1's rank inputs, measured at the fill exactly as the trigger families'
 * are at their decision close (entryTimingAt, the same formula): the anchor
 * is the sweep extreme, the entry the fill, the R left is T1 vs the
 * structural stop from the fill. Move potential needs the session's range
 * history, which this chain does not carry — left unmeasured (neutral).
 * Evidence = the Tier-1 events the sequence actually holds (sweep,
 * displacement, the zone it filled in).
 */
export function structureSlotCandidate(lc: LiveLifecycle, spot: number, netRR: number | null, at: number): SlotCandidate {
  const risk = lc.stop != null ? Math.abs(spot - lc.stop) : 0;
  const rToT1 = lc.t1 && risk > 0 ? Math.round((Math.abs(lc.t1.price - spot) / risk) * 1000) / 1000 : null;
  const timing = lc.atr > 0
    ? entryTimingAt({ direction: lc.direction, anchorIndex: 0, anchorPrice: lc.sweepExtreme, decisionIndex: 1, entry: spot, atr: lc.atr, t1: lc.t1?.price ?? null, rToT1 })
    : null;
  return {
    source: lc.triggerId ?? 'S1',
    timingClass: timing?.class ?? null,
    movePotential: null,
    remainingMovePct: null,
    netRR,
    evidence: 1 + (lc.displacementBodyAtr != null ? 1 : 0) + (lc.zone ? 1 : 0),
    decisionTime: at,
  };
}

/** A router candidate's rank inputs, as the event engine measured them at its decision bar's close. */
export function routedSlotCandidate(rc: RoutedCandidate): Omit<SlotCandidate, 'netRR'> {
  const c = rc.candidate;
  return {
    source: c.triggerId,
    timingClass: c.timing?.class ?? null,
    movePotential: c.movePotential?.class ?? null,
    remainingMovePct: c.movePotential?.remainingMovePct ?? null,
    evidence: c.eventIds?.length ?? 0,
    decisionTime: c.decisionTime + BAR_MS_15M,
  };
}

/** A setup an engine built through its whole chain but has not minted: the slot arbitration commits one. */
export interface DeferredSetup {
  kind: 'DEFERRED';
  setup: TradeSetup;
  slot: SlotCandidate;
  commit: () => Promise<TradeSetup>;
  decline: (reason: string) => Promise<void>;
}

export function isDeferred(x: TradeSetup | DeferredSetup | null): x is DeferredSetup {
  return x != null && (x as DeferredSetup).kind === 'DEFERRED';
}

/**
 * One paper trade per symbol, chosen across every engine: the winner is
 * minted, every other built setup is recorded NOT_SELECTED with the criterion
 * it lost on. No engine has priority.
 */
export async function settleSlot(underlying: string, exchange: string, pending: readonly DeferredSetup[]): Promise<TradeSetup> {
  const { winner, ranked, lostOn } = rankSlotCandidates(pending.map((p) => p.slot));
  const chosen = pending[winner];
  logger.info(
    { underlying, exchange, selected: chosen.slot.source, ranking: ranked.map((i) => ({ ...pending[i].slot, lostOn: lostOn.get(i) ?? null })) },
    'Slot arbitration: one paper trade selected across engines'
  );
  const minted = await chosen.commit();
  for (const [i, criterion] of lostOn) {
    await pending[i].decline(notSelectedReason(pending[i].slot, chosen.slot, criterion)).catch((err: any) =>
      logger.warn({ error: err.message, underlying, source: pending[i].slot.source }, 'Slot arbitration: NOT_SELECTED record failed')
    );
  }
  return minted;
}
