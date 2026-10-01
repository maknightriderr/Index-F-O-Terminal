// ============================================================
// EVENT ENGINE — types (research / shadow only)
// ============================================================
// The multi-path architecture's vocabulary: market state, opportunity
// (radar) events, the chronological event log, trigger definitions, the
// candidates they produce, and the parent setups that group them.
//
// TIMING CONTRACT (the no-look-ahead rule every module here keeps): an event
// at bar i is decided at bar i's CLOSE from bars [.., i] only; ATR and
// liquidity pools come from bars before i. `availableAt` is that close. A
// trigger's decision bar is the bar whose close completes its last event;
// nothing after it may change the trigger, entry, stop or target.
// ============================================================

export type Dir = 'BULLISH' | 'BEARISH';

export type MarketState = 'BALANCED' | 'COMPRESSION' | 'EXPANSION' | 'TRENDING_UP' | 'TRENDING_DOWN' | 'EXHAUSTION' | 'REVERSAL';

export type EventType =
  // Opportunity radar (something may be developing; never a trade by itself)
  | 'LIQUIDITY_NEAR'
  | 'MAJOR_LEVEL_BREAK'
  | 'COMPRESSION'
  | 'RANGE_EXPANSION'
  | 'VOLATILITY_BURST'
  | 'OPENING_RANGE_BREAK'
  | 'GAP_UP'
  | 'GAP_DOWN'
  | 'TREND_ACCELERATION'
  | 'ABNORMAL_MOVE'
  // Sequence events
  | 'SWEEP'
  | 'RECLAIM'
  | 'ACCEPTANCE'
  | 'FAILED_ACCEPTANCE'
  | 'COMPRESSION_BREAK'
  | 'MICRO_BOS'
  | 'DISPLACEMENT'
  | 'RETEST_HOLD'
  | 'RETEST_FAIL'
  | 'FOLLOW_THROUGH'
  | 'PULLBACK'
  | 'OPENING_RANGE_REJECTION';

/** The radar subset: these mark "something important may be developing". */
export const RADAR_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'LIQUIDITY_NEAR',
  'MAJOR_LEVEL_BREAK',
  'COMPRESSION',
  'RANGE_EXPANSION',
  'VOLATILITY_BURST',
  'OPENING_RANGE_BREAK',
  'GAP_UP',
  'GAP_DOWN',
  'TREND_ACCELERATION',
  'ABNORMAL_MOVE',
]);

export interface EventLevel {
  kind: string;
  price: number;
  rank?: number;
}

export interface MarketEvent {
  /** Stable within a series: `${type}:${direction ?? 'NONE'}:${barIndex}:${ref}`. */
  id: string;
  type: EventType;
  /** The trade direction the event points to (a swept HIGH pool → BEARISH). Null when neutral. */
  direction: Dir | null;
  /** The bar whose close confirms the event. */
  barIndex: number;
  /** That bar's open time (epoch ms). */
  time: number;
  /** When the event is first known: that bar's close (epoch ms). */
  availableAt: number;
  /** The reference price: the level for level events, else the bar close. */
  price: number;
  level?: EventLevel | null;
  /** The event this one follows from (RECLAIM → its SWEEP, ACCEPTANCE → its break). */
  parentId?: string | null;
  /** Measurements at the event, all from bars <= barIndex. */
  measures?: Record<string, number | null>;
}

export type TriggerFamily = 'LIQUIDITY_REVERSAL' | 'BREAKOUT_ACCEPTANCE' | 'TREND_CONTINUATION' | 'VOLATILITY_EXPANSION' | 'FAILED_AUCTION' | 'GAP_OPENING';

export type TriggerStatus = 'RESEARCH' | 'SHADOW' | 'PAPER' | 'ACTIVE' | 'RETIRED';

export interface TriggerDefinition {
  triggerId: string;
  family: TriggerFamily;
  version: string;
  name: string;
  /** The exact rule, as pre-registered. */
  exactRule: string;
  decisionBar: string;
  entryRule: string;
  stopRule: string;
  targetRule: string;
  allowedDataAtDecision: string;
  noLookAheadDefinition: string;
  status: TriggerStatus;
  /** Evidence already on record about this rule (e.g. a failed clean test). */
  priorEvidence?: string;
}

export type CandidateBucket = 'TRADE' | 'LOW_RR' | 'NO_TARGET' | 'INVALID_STOP';
export type MovePotentialClass = 'LOW' | 'NORMAL' | 'HIGH';
export type EntryTimingClass = 'EARLY' | 'OPTIMAL' | 'ACCEPTABLE' | 'LATE' | 'CHASING';

export interface MovePotential {
  /** Distance to T1 and to the next pool beyond it, in ATR. */
  t1DistanceAtr: number | null;
  t2DistanceAtr: number | null;
  /** Research-only pools (previous close, week/month H/L) lying between entry and T1. */
  obstaclesToT1: number;
  /** Session range so far ÷ the average session range of the previous 20 sessions. */
  moveConsumedPct: number | null;
  remainingMovePct: number | null;
  expectedR: number | null;
  class: MovePotentialClass;
}

export interface EntryTiming {
  barsSinceAnchor: number;
  /** Price travelled from the anchor to the entry, in ATR, signed in the trade's direction. */
  travelledAtr: number;
  /** Share of the anchor → T1 distance already travelled at entry. */
  moveConsumedPct: number | null;
  /** R still available to T1 at the entry. */
  currentRAvailable: number | null;
  class: EntryTimingClass;
}

export interface TriggerCandidate {
  triggerId: string;
  family: TriggerFamily;
  direction: Dir;
  session: string;
  /** The decision bar (its close is the entry). */
  decisionIndex: number;
  decisionTime: number;
  entry: number;
  stop: number;
  atr: number;
  t1: EventLevel | null;
  t2: EventLevel | null;
  rToT1: number | null;
  bucket: CandidateBucket;
  /** The first event of the sequence that produced this candidate. */
  anchorEventId: string;
  anchorIndex: number;
  anchorPrice: number;
  /** Every event the rule used, oldest first. */
  eventIds: string[];
  marketState: MarketState;
  movePotential: MovePotential;
  timing: EntryTiming;
  /** The rule's invalidation extreme the stop sits beyond (before the ATR buffer) — what a later re-check rebuilds from. */
  stopRef?: number;
}

export interface ParentSetup {
  parentId: string;
  session: string;
  direction: Dir;
  anchorEventId: string;
  anchorIndex: number;
  /** Candidate indexes into the caller's candidate array, oldest first. */
  candidates: number[];
  triggerIds: string[];
  families: TriggerFamily[];
  /** Entry stages along the same move (decision bar indexes; null when the stage never occurred). */
  stages: {
    firstAvailable: number | null;
    bos: number | null;
    displacement: number | null;
    retest: number | null;
  };
}
