// ============================================================
// EVENT ENGINE — candidate manager and the major-move diagnostic
// ============================================================
// Several trigger families can describe the same market move. The candidate
// manager groups them into one PARENT setup, so a move is counted once and
// its entry stages (first available, micro BOS, displacement, retest) can be
// compared on the same footing. What "the same underlying move" means is
// defined once, below (PARENT IDENTITY).
//
// The major-move diagnostic answers "huge move, zero setup": was the move
// covered by data, which event started it, which family saw it, when was the
// first actionable point, and how much of the move was left by then.
// ============================================================

import type { MomentumSeries } from '../momentum-break/index.js';
import type { SessionEventLog } from './events.js';
import type { Dir, MarketEvent, ParentSetup, TriggerCandidate, TriggerFamily } from './types.js';

/** How long (in bars from its origin) a move's window stays open to another origin on the same level. */
export const PARENT_SPAN_BARS = 12;
/**
 * Retained for reference: the pre-2026-10-05 rule also joined a candidate that
 * merely started within this many bars of a parent's last decision. Time
 * proximity alone is no longer a reason to merge (see PARENT IDENTITY).
 */
export const PARENT_JOIN_BARS = 3;
/** Bumped with any change to what "the same underlying move" means. */
export const PARENT_IDENTITY_VERSION = 'PARENT-2.0';

// ============================================================
// PARENT IDENTITY — "the same underlying move" (PARENT-2.0, 2026-10-05)
// ============================================================
// Two trigger candidates belong to the same parent move iff they share the
// session and the direction, and
//   (a) their anchor events have the same ORIGIN — the root of the anchor's
//       event ancestry (RECLAIM → its SWEEP; RETEST → its ACCEPTANCE → the
//       break; FOLLOW_THROUGH → its event); or
//   (b) their origins act on the same ORIGIN LEVEL (the liquidity pool /
//       level the origin event is about: kind + price) and the later origin
//       lies inside the move's window — PARENT_SPAN_BARS bars from the move's
//       FIRST origin (the window never slides, so a level revisited much
//       later is a new move).
// Nothing else merges: two families firing a few bars apart on different
// origins and different levels are two moves, never one.
//
// parentId = a stable hash of (symbol, session, direction, the move's first
// origin event, its origin level, that origin's own ancestry, the window).
// It depends only on the move — not on which family saw it first, on how
// many candidates joined later, or on the order the candidates are given in.
// ============================================================

/** A 2 × 53-bit string hash (cyrb53), hex. Pure and deterministic; not cryptographic. */
function stableHash(text: string): string {
  const cyrb53 = (str: string, seed: number): number => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  };
  return cyrb53(text, 0).toString(16).padStart(14, '0') + cyrb53(text, 1).toString(16).padStart(14, '0');
}

/** What a move is identified by. */
export interface MoveOrigin {
  /** The origin event (root of the anchor's ancestry). */
  originEventId: string;
  /** The origin's level as `kind:price` (null when the origin is not about a level). */
  originLevel: string | null;
  /** The origin event's own ancestry, itself first. */
  ancestry: string[];
  /** Start of the move's window: the origin bar's open time (its bar index when no log). */
  windowStart: number;
}

/** The deterministic parent id of a move. */
export function parentIdFor(symbol: string, session: string, direction: Dir, origin: MoveOrigin): string {
  const key = [PARENT_IDENTITY_VERSION, symbol, session, direction, origin.originEventId, origin.originLevel ?? '-', origin.ancestry.join('>'), origin.windowStart, PARENT_SPAN_BARS].join('|');
  return `P:${stableHash(key)}`;
}

export const levelKeyOf = (level: { kind: string; price: number } | null | undefined): string | null => (level ? `${level.kind}:${level.price.toFixed(2)}` : null);

/** An event and its ancestors (anchor first, origin last). */
function ancestryOf(eventId: string, byId: ReadonlyMap<string, MarketEvent>): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = eventId;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

export function groupIntoParents(candidates: readonly TriggerCandidate[], logs: ReadonlyMap<string, SessionEventLog>, opts: { symbol?: string } = {}): ParentSetup[] {
  const symbol = opts.symbol ?? '';
  const byIdPerSession = new Map<string, Map<string, MarketEvent>>();
  for (const [session, log] of logs) byIdPerSession.set(session, new Map(log.events.map((e) => [e.id, e])));

  // 1. Each candidate's origin: the root of its anchor's ancestry (the anchor itself without a log).
  interface Origin { id: string; session: string; direction: Dir; bar: number; time: number; level: string | null; ancestry: string[] }
  const origins = new Map<string, Origin>();
  const originOfCandidate: string[] = [];
  candidates.forEach((c, idx) => {
    const byId = byIdPerSession.get(c.session) ?? new Map<string, MarketEvent>();
    const chain = ancestryOf(c.anchorEventId, byId);
    const rootId = chain[chain.length - 1];
    const root = byId.get(rootId);
    const key = `${c.session}|${c.direction}|${rootId}`;
    if (!origins.has(key)) {
      origins.set(key, {
        id: rootId,
        session: c.session,
        direction: c.direction,
        bar: root?.barIndex ?? c.anchorIndex,
        time: root?.time ?? c.anchorIndex,
        level: levelKeyOf(root?.level ?? null),
        ancestry: root ? ancestryOf(rootId, byId) : [rootId],
      });
    }
    originOfCandidate[idx] = key;
  });

  // 2. Origins → moves, earliest origin first (a total order), each move's window fixed at its first origin.
  const ordered = [...origins.entries()].sort(([, a], [, b]) => a.session.localeCompare(b.session) || a.bar - b.bar || a.direction.localeCompare(b.direction) || a.id.localeCompare(b.id));
  interface Move { first: Origin; startBar: number; originKeys: string[] }
  const moves: Move[] = [];
  const moveOfOrigin = new Map<string, Move>();
  for (const [key, o] of ordered) {
    const same = o.level == null
      ? undefined
      : moves.find((m) => m.first.session === o.session && m.first.direction === o.direction && m.first.level === o.level && o.bar - m.startBar <= PARENT_SPAN_BARS);
    const move = same ?? { first: o, startBar: o.bar, originKeys: [] };
    if (!same) moves.push(move);
    move.originKeys.push(key);
    moveOfOrigin.set(key, move);
  }

  // 3. One parent per move; candidates oldest first (decision bar, then trigger id).
  const order = candidates.map((c, idx) => ({ c, idx })).sort((a, b) => a.c.decisionIndex - b.c.decisionIndex || a.c.triggerId.localeCompare(b.c.triggerId) || a.idx - b.idx);
  const parentOfMove = new Map<Move, ParentSetup>();
  for (const m of moves) {
    parentOfMove.set(m, {
      parentId: parentIdFor(symbol, m.first.session, m.first.direction, { originEventId: m.first.id, originLevel: m.first.level, ancestry: m.first.ancestry, windowStart: m.first.time }),
      session: m.first.session,
      direction: m.first.direction,
      anchorEventId: m.first.id,
      anchorIndex: m.first.bar,
      candidates: [],
      triggerIds: [],
      families: [],
      stages: { firstAvailable: null, bos: null, displacement: null, retest: null },
    });
  }
  for (const { c, idx } of order) {
    const p = parentOfMove.get(moveOfOrigin.get(originOfCandidate[idx])!)!;
    p.candidates.push(idx);
    if (!p.triggerIds.includes(c.triggerId)) p.triggerIds.push(c.triggerId);
    if (!p.families.includes(c.family)) p.families.push(c.family);
    p.stages.firstAvailable = Math.min(p.stages.firstAvailable ?? Infinity, c.decisionIndex);
  }
  const parents = moves.map((m) => parentOfMove.get(m)!).filter((p) => p.candidates.length > 0);

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
  return parents;
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
