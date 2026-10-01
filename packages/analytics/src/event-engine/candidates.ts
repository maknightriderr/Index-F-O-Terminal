// ============================================================
// EVENT ENGINE — candidate manager and the major-move diagnostic
// ============================================================
// Several trigger families can describe the same market move. The candidate
// manager groups them into one PARENT setup (same session, same direction,
// same anchor event or overlapping in time), so a move is counted once and
// its entry stages (first available, micro BOS, displacement, retest) can be
// compared on the same footing.
//
// The major-move diagnostic answers "huge move, zero setup": was the move
// covered by data, which event started it, which family saw it, when was the
// first actionable point, and how much of the move was left by then.
// ============================================================

import type { MomentumSeries } from '../momentum-break/index.js';
import type { SessionEventLog } from './events.js';
import type { Dir, MarketEvent, ParentSetup, TriggerCandidate, TriggerFamily } from './types.js';

/** A later candidate joins a parent when it shares the anchor, or starts within this many bars of the parent's last decision. */
export const PARENT_JOIN_BARS = 3;
/** ...and stays within this many bars of the parent's anchor. */
export const PARENT_SPAN_BARS = 12;

export function groupIntoParents(candidates: readonly TriggerCandidate[], logs: ReadonlyMap<string, SessionEventLog>): ParentSetup[] {
  const order = candidates.map((c, idx) => ({ c, idx })).sort((a, b) => a.c.decisionIndex - b.c.decisionIndex || a.c.triggerId.localeCompare(b.c.triggerId));
  const parents: Array<ParentSetup & { lastDecision: number }> = [];
  for (const { c, idx } of order) {
    const parent = parents.find(
      (p) =>
        p.session === c.session &&
        p.direction === c.direction &&
        (p.anchorEventId === c.anchorEventId || (c.anchorIndex <= p.lastDecision + PARENT_JOIN_BARS && c.decisionIndex - p.anchorIndex <= PARENT_SPAN_BARS))
    );
    if (parent) {
      parent.candidates.push(idx);
      if (!parent.triggerIds.includes(c.triggerId)) parent.triggerIds.push(c.triggerId);
      if (!parent.families.includes(c.family)) parent.families.push(c.family);
      parent.lastDecision = Math.max(parent.lastDecision, c.decisionIndex);
      parent.stages.firstAvailable = Math.min(parent.stages.firstAvailable ?? Infinity, c.decisionIndex);
      continue;
    }
    parents.push({
      parentId: `${c.session}:${c.direction}:${c.anchorEventId}`,
      session: c.session,
      direction: c.direction,
      anchorEventId: c.anchorEventId,
      anchorIndex: c.anchorIndex,
      candidates: [idx],
      triggerIds: [c.triggerId],
      families: [c.family],
      stages: { firstAvailable: c.decisionIndex, bos: null, displacement: null, retest: null },
      lastDecision: c.decisionIndex,
    });
  }
  // Entry stages along each parent's move: the first such event in its direction from the anchor to anchor + span.
  for (const p of parents) {
    const log = logs.get(p.session);
    if (!log) continue;
    const firstOf = (types: MarketEvent['type'][]) =>
      log.events.find((e) => types.includes(e.type) && e.direction === p.direction && e.barIndex >= p.anchorIndex && e.barIndex <= p.anchorIndex + PARENT_SPAN_BARS)?.barIndex ?? null;
    p.stages.bos = firstOf(['MICRO_BOS']);
    p.stages.displacement = firstOf(['DISPLACEMENT']);
    p.stages.retest = firstOf(['RETEST_HOLD', 'RETEST_FAIL']);
  }
  return parents.map(({ lastDecision: _l, ...p }) => p);
}

// ---------------- major-move diagnostic ----------------

export type MajorMoveClass =
  | 'TRADED'
  | 'CORRECTLY_UNTRADEABLE'
  | 'MISSED_LIQUIDITY'
  | 'MISSED_BREAKOUT'
  | 'MISSED_CONTINUATION'
  | 'MISSED_EXPANSION'
  | 'LATE_ENTRY'
  | 'RISK_REJECTED'
  | 'OPTION_REJECTED'
  | 'DATA_GAP';

/** A session leg at least this many average session ranges long is a major move. */
export const MAJOR_MOVE_ADR = 1.0;
/** An actionable point with less than this share of the move left is LATE_ENTRY. */
export const MAJOR_MOVE_LATE_REMAINING = 0.5;

export interface MajorMove {
  session: string;
  direction: Dir;
  /** The extreme the move started from, and the extreme it reached (bar indexes). */
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  sizeAdr: number;
}

/** The session's largest directional leg (low before high, or high before low), if it is ≥ MAJOR_MOVE_ADR. */
export function detectMajorMoves(series: MomentumSeries, s: number, sessionEnd: number, adr: number | null): MajorMove[] {
  if (adr == null || !(adr > 0)) return [];
  const { bars } = series;
  const start = series.sessionStarts[s];
  let best: MajorMove | null = null;
  let loIdx = start;
  let hiIdx = start;
  for (let i = start; i <= sessionEnd; i++) {
    if (bars[i].low < bars[loIdx].low) loIdx = i;
    if (bars[i].high > bars[hiIdx].high) hiIdx = i;
    const up = (bars[i].high - bars[loIdx].low) / adr;
    const down = (bars[hiIdx].high - bars[i].low) / adr;
    if (up >= MAJOR_MOVE_ADR && (!best || up > best.sizeAdr) && loIdx <= i)
      best = { session: series.sessionDates[s], direction: 'BULLISH', startIndex: loIdx, endIndex: i, startPrice: bars[loIdx].low, endPrice: bars[i].high, sizeAdr: Math.round(up * 1000) / 1000 };
    if (down >= MAJOR_MOVE_ADR && (!best || down > best.sizeAdr) && hiIdx <= i)
      best = { session: series.sessionDates[s], direction: 'BEARISH', startIndex: hiIdx, endIndex: i, startPrice: bars[hiIdx].high, endPrice: bars[i].low, sizeAdr: Math.round(down * 1000) / 1000 };
  }
  return best ? [best] : [];
}

const FAMILY_MISS: Record<TriggerFamily, MajorMoveClass> = {
  LIQUIDITY_REVERSAL: 'MISSED_LIQUIDITY',
  FAILED_AUCTION: 'MISSED_LIQUIDITY',
  BREAKOUT_ACCEPTANCE: 'MISSED_BREAKOUT',
  GAP_OPENING: 'MISSED_BREAKOUT',
  TREND_CONTINUATION: 'MISSED_CONTINUATION',
  VOLATILITY_EXPANSION: 'MISSED_EXPANSION',
};

export interface MajorMoveDiagnosis {
  move: MajorMove;
  classification: MajorMoveClass;
  coverage: string;
  /** The first event in the move's direction at or after its start. */
  firstEvent: { id: string; type: string; barIndex: number } | null;
  familiesRecognized: TriggerFamily[];
  /** The first candidate with valid geometry (TRADE bucket) — the first actionable point. */
  firstActionable: { triggerId: string; decisionIndex: number; entry: number; remainingMovePct: number } | null;
  reason: string;
}

/**
 * Pure. `candidates` are the research triggers' candidates for the session
 * (any direction; filtered here). `traded` says whether the live engine
 * traded the move (null in research, where only the research triggers ran).
 * `optionRefused` marks candidate indexes the option-cost model would refuse.
 * A move is only "missed" when a predefined rule had an actionable setup
 * while the data was covered.
 */
export function diagnoseMajorMove(args: {
  move: MajorMove;
  coverage: string;
  events: readonly MarketEvent[];
  candidates: readonly TriggerCandidate[];
  traded: boolean | null;
  optionRefused?: (c: TriggerCandidate) => boolean;
}): MajorMoveDiagnosis {
  const { move } = args;
  const sg = move.direction === 'BULLISH' ? 1 : -1;
  const inMove = args.candidates.filter((c) => c.direction === move.direction && c.decisionIndex >= move.startIndex && c.decisionIndex <= move.endIndex).sort((a, b) => a.decisionIndex - b.decisionIndex);
  const firstEv = args.events.find((e) => e.direction === move.direction && e.barIndex >= move.startIndex && e.barIndex <= move.endIndex) ?? null;
  const families = [...new Set(inMove.map((c) => c.family))];
  const actionable = inMove.filter((c) => c.bucket === 'TRADE');
  const first = actionable[0] ?? null;
  const remaining = first ? Math.max(0, ((move.endPrice - first.entry) * sg) / ((move.endPrice - move.startPrice) * sg)) : null;
  const base = {
    move,
    coverage: args.coverage,
    firstEvent: firstEv ? { id: firstEv.id, type: firstEv.type, barIndex: firstEv.barIndex } : null,
    familiesRecognized: families,
    firstActionable: first ? { triggerId: first.triggerId, decisionIndex: first.decisionIndex, entry: first.entry, remainingMovePct: Math.round(remaining! * 1000) / 1000 } : null,
  };
  if (args.coverage !== 'COVERED') return { ...base, classification: 'DATA_GAP', reason: `Session data was ${args.coverage}; a miss cannot be judged.` };
  if (args.traded === true) return { ...base, classification: 'TRADED', reason: 'The live engine traded this move.' };
  if (inMove.length === 0) return { ...base, classification: 'CORRECTLY_UNTRADEABLE', reason: 'No predefined trigger produced a setup during the move.' };
  if (!first) return { ...base, classification: 'RISK_REJECTED', reason: `Triggers fired (${families.join(', ')}) but none had a valid stop and a T1 ≥ 1.5R.` };
  if (args.optionRefused && actionable.every((c) => args.optionRefused!(c))) return { ...base, classification: 'OPTION_REJECTED', reason: 'Every actionable setup failed the option-cost limits.' };
  if (remaining! < MAJOR_MOVE_LATE_REMAINING) return { ...base, classification: 'LATE_ENTRY', reason: `The first actionable point (${first.triggerId}) came with ${Math.round(remaining! * 100)}% of the move left.` };
  return { ...base, classification: FAMILY_MISS[first.family], reason: `${first.triggerId} (${first.family}) had an actionable setup with ${Math.round(remaining! * 100)}% of the move left.` };
}
