// ============================================================
// EVENT ENGINE — setup arbitration (one actionable setup per parent move)
// ============================================================
// Every trigger is evaluated on its own; a failing trigger never stops
// another. Candidates on the same market move are grouped into one parent
// (candidates.ts groupIntoParents). Arbitration then picks ONE actionable
// setup per parent, so a move is never traded twice.
//
// Decision-time only. A parent's selection happens at the FIRST bar where it
// has an eligible candidate, among that bar's eligible candidates, and is
// then fixed: a better-looking candidate on a later bar becomes an
// alternative, it does not replace the selection (replacing it would need
// information the first decision did not have). No outcome is ever read.
//
// Ranking among eligible candidates on the same bar, first difference wins:
//   1. entry timing   OPTIMAL > EARLY > ACCEPTABLE > LATE > CHASING
//   2. move potential HIGH > NORMAL > LOW, then more remaining session range
//   3. net-R geometry higher (R to T1 net of cost when measured, else gross)
//   4. evidence       more supporting events in the rule's sequence
//   5. tie-breaker    earliest decision bar, then trigger id (alphabetical)
// Ineligible candidates (invalid stop, no target, low R:R, outside the
// session window, cost too high, a stage not allowed in this mode) are never
// selected; they are stored with their reason.
// ============================================================

import type { ParentSetup, TriggerCandidate } from './types.js';

export type ArbitrationRole = 'SELECTED' | 'ALTERNATIVE' | 'INELIGIBLE';

export interface ArbitrationInfo {
  /** Passed every hard check at decision time (geometry, risk, session, option cost). */
  eligible: boolean;
  /** Why not, when not eligible. */
  ineligibleReason: string | null;
  /** The trigger's stage allows it in this arbitration mode (observation: SHADOW and up; trading: PAPER and up). */
  stageAllowed: boolean;
  /** R to T1 net of cost, when cost was measured. */
  netR: number | null;
}

export interface ArbitrationDecision {
  parentId: string;
  role: ArbitrationRole;
  reason: string;
  /** The parent's selected candidate (index into the caller's array), when one exists. */
  selectedIndex: number | null;
  selectedTriggerId: string | null;
  /** 1 = selected; alternatives ranked after it on the same bar; null otherwise. */
  rank: number | null;
}

/** A parent's selection fixed by an earlier evaluation (persisted by the live router). */
export interface FixedSelection {
  triggerId: string;
  decisionIndex: number;
}

const TIMING_RANK: Record<string, number> = { OPTIMAL: 0, EARLY: 1, ACCEPTABLE: 2, LATE: 3, CHASING: 4 };
const POTENTIAL_RANK: Record<string, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

/**
 * Compares two eligible candidates; negative = `a` is better. Returns the
 * criterion that decided it, for the alternative's stored reason.
 */
export function compareCandidates(a: TriggerCandidate, b: TriggerCandidate, ia: ArbitrationInfo, ib: ArbitrationInfo): { cmp: number; criterion: string } {
  const steps: Array<[number, string]> = [
    [(TIMING_RANK[a.timing.class] ?? 9) - (TIMING_RANK[b.timing.class] ?? 9), 'entry timing'],
    [(POTENTIAL_RANK[a.movePotential.class] ?? 9) - (POTENTIAL_RANK[b.movePotential.class] ?? 9), 'move potential'],
    [(b.movePotential.remainingMovePct ?? -1) - (a.movePotential.remainingMovePct ?? -1), 'remaining move'],
    [(ib.netR ?? b.rToT1 ?? -Infinity) - (ia.netR ?? a.rToT1 ?? -Infinity), 'net-R geometry'],
    [b.eventIds.length - a.eventIds.length, 'evidence'],
    [a.decisionIndex - b.decisionIndex, 'earlier entry'],
    [a.triggerId.localeCompare(b.triggerId), 'trigger id tie-break'],
  ];
  for (const [d, criterion] of steps) if (d !== 0 && Number.isFinite(d)) return { cmp: d, criterion };
  return { cmp: 0, criterion: 'identical' };
}

/**
 * One parent's arbitration. `members` are indexes into `candidates`.
 * `fixed` is a selection an earlier evaluation already made (it stands).
 */
export function arbitrateParent(
  parent: Pick<ParentSetup, 'parentId' | 'candidates'>,
  candidates: readonly TriggerCandidate[],
  info: (idx: number) => ArbitrationInfo,
  fixed: FixedSelection | null = null
): Map<number, ArbitrationDecision> {
  const out = new Map<number, ArbitrationDecision>();
  const members = [...parent.candidates].sort((x, y) => candidates[x].decisionIndex - candidates[y].decisionIndex || candidates[x].triggerId.localeCompare(candidates[y].triggerId));
  let selectedIndex: number | null = fixed ? members.find((m) => candidates[m].triggerId === fixed.triggerId && candidates[m].decisionIndex === fixed.decisionIndex) ?? null : null;
  let selectedAt: number | null = fixed ? fixed.decisionIndex : null;
  let selectedTrigger: string | null = fixed ? fixed.triggerId : null;

  const bars = [...new Set(members.map((m) => candidates[m].decisionIndex))].sort((a, b) => a - b);
  for (const bar of bars) {
    const onBar = members.filter((m) => candidates[m].decisionIndex === bar);
    const ok = onBar.filter((m) => info(m).eligible && info(m).stageAllowed);
    if (selectedTrigger == null && ok.length > 0) {
      const ranked = [...ok].sort((x, y) => compareCandidates(candidates[x], candidates[y], info(x), info(y)).cmp);
      selectedIndex = ranked[0];
      selectedAt = bar;
      selectedTrigger = candidates[ranked[0]].triggerId;
      ranked.forEach((m, k) => {
        const why = k === 0 ? `Best of ${ranked.length} eligible on this bar` : `Ranked ${k + 1} of ${ranked.length}: below ${selectedTrigger} on ${compareCandidates(candidates[ranked[0]], candidates[m], info(ranked[0]), info(m)).criterion}`;
        out.set(m, { parentId: parent.parentId, role: k === 0 ? 'SELECTED' : 'ALTERNATIVE', reason: why, selectedIndex, selectedTriggerId: selectedTrigger, rank: k + 1 });
      });
    }
    for (const m of onBar) {
      if (out.has(m)) continue;
      const i = info(m);
      const isFixed = fixed != null && candidates[m].triggerId === fixed.triggerId && candidates[m].decisionIndex === fixed.decisionIndex;
      if (isFixed) out.set(m, { parentId: parent.parentId, role: 'SELECTED', reason: 'Selected earlier for this parent', selectedIndex, selectedTriggerId: selectedTrigger, rank: 1 });
      else if (!i.eligible) out.set(m, { parentId: parent.parentId, role: 'INELIGIBLE', reason: i.ineligibleReason ?? 'Failed a hard check', selectedIndex, selectedTriggerId: selectedTrigger, rank: null });
      else if (!i.stageAllowed) out.set(m, { parentId: parent.parentId, role: 'INELIGIBLE', reason: 'Trigger stage not allowed in this mode', selectedIndex, selectedTriggerId: selectedTrigger, rank: null });
      else out.set(m, { parentId: parent.parentId, role: 'ALTERNATIVE', reason: `Parent already has a selected setup (${selectedTrigger} at bar ${selectedAt})`, selectedIndex, selectedTriggerId: selectedTrigger, rank: null });
    }
  }
  return out;
}

/** Every parent's arbitration at once; candidates outside every parent never occur (groupIntoParents covers all). */
export function arbitrateParents(
  parents: readonly Pick<ParentSetup, 'parentId' | 'candidates'>[],
  candidates: readonly TriggerCandidate[],
  info: (idx: number) => ArbitrationInfo,
  fixed: Readonly<Record<string, FixedSelection>> = {}
): Map<number, ArbitrationDecision> {
  const out = new Map<number, ArbitrationDecision>();
  for (const p of parents) for (const [k, v] of arbitrateParent(p, candidates, info, fixed[p.parentId] ?? null)) out.set(k, v);
  return out;
}
