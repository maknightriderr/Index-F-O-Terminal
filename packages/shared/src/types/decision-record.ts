// ============================================================
// DECISION SNAPSHOT + DECISION RECORD (Phase 2, 2026-10-05)
// ============================================================
// SignalDecisionSnapshot — the immutable INPUT of one signal decision: the
// bars, quotes and stored state the engines read, each with its data quality,
// and every version the decision ran under. Nothing derived by the decision
// (events, candidates, arbitration) is in it.
//
// DecisionRecord — what the deterministic decision core derived from exactly
// one snapshot. replay(snapshotId) re-derives it offline from the stored
// snapshot; the canonical forms must be identical except for the fields in
// NONDETERMINISTIC_RECORD_FIELDS.
// ============================================================

import type { Exchange, FuturesChainResponse, OptionChain, TradingMode } from './index.js';

export const SNAPSHOT_SCHEMA_VERSION = 'SNAP-1.0';
export const DECISION_RECORD_SCHEMA_VERSION = 'DR-1.0';

/**
 * THE one list of DecisionRecord fields that may differ between the live
 * decision and its replay: generated timestamps / ids only. Everything else
 * — decisions, candidates, rankings, reasons, parent ids, option selection,
 * arbitration — must match exactly.
 */
export const NONDETERMINISTIC_RECORD_FIELDS = ['generatedAt'] as const;
export type NondeterministicRecordField = (typeof NONDETERMINISTIC_RECORD_FIELDS)[number];

/**
 * OK            as of the decision bar, within tolerance
 * STALE_INPUT   older than its tolerance at T
 * FUTURE_INPUT  as of AFTER T (look-ahead): never used as if it were as of T —
 *               whatever is derived from it is marked degraded
 * MISSING       not available
 */
export type InputQualityStatus = 'OK' | 'STALE_INPUT' | 'FUTURE_INPUT' | 'MISSING';

export interface InputQuality {
  /** When the data was true (epoch ms); null when missing. */
  asOf: number | null;
  /** T — the close of the decision bar on the exchange calendar (epoch ms). */
  decisionBarTime: number;
  /** DERIVED: decisionBarTime − asOf (negative = after T). Recomputable from the two; null when missing. */
  ageMs: number | null;
  /** Provider / endpoint that produced it (e.g. 'angel-one:rest:candles'). */
  source: string;
  status: InputQualityStatus;
  /** The tolerance the status was judged against (ms). */
  toleranceMs: number;
}

export type SnapshotInputKey = 'ohlcv15m' | 'ohlcv1h' | 'ohlcv5m' | 'futuresQuote' | 'optionChain' | 'optionMetrics' | 'corporateActions';

export interface SnapshotDataQuality {
  inputs: Record<SnapshotInputKey, InputQuality>;
  /** Any input not OK (MISSING inputs that are not applicable are OK). */
  degraded: boolean;
  /** One line per input that is not OK. */
  reasons: string[];
  /** Overall flags. */
  flags: { anyFuture: boolean; anyStale: boolean; anyMissing: boolean };
}

export interface SnapshotVersions {
  gitCommit: string | null;
  analyticsVersion: string;
  /** The live logic stamp (version + flag hash) the signal engine ran under. */
  signalEngineVersion: string;
  logicFlagsHash: string;
  optionModelVersion: string;
  parentingVersion: string;
  arbitrationVersion: string;
  ruleVersion: string;
  strategyVersion: string;
  /** Per trigger id: its rule version. */
  triggerVersions: Record<string, string>;
  riskVersion: string;
  costModelVersion: string;
  snapshotSchemaVersion: string;
}

/** A bar as the engines read it (open time, epoch ms). */
export interface SnapshotBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SnapshotConfig {
  /** Each trigger's live stage. */
  triggerStages: Record<string, string>;
  structureOn: boolean;
  structureEntryTimeframe: '15m' | '5m';
  structureEntryMode: 'TOUCH' | 'REJECTION_CLOSE';
  /** The engine parameters the decision core reads (STRUCTURE_PARAMS, FNO_VALIDATION_PARAMS). */
  params: Record<string, unknown>;
  /** sha256 of the canonical config — replay refuses to run under a different one. */
  configHash: string;
}

export interface SignalDecisionSnapshot {
  readonly snapshotId: string;
  readonly schemaVersion: string;
  readonly symbol: string;
  readonly exchange: Exchange;
  readonly mode: TradingMode;
  /** T: the close of the newest 15m bar closed at the poll (exchange session calendar). */
  readonly decisionBarTime: number;
  /** When the poll ran — the decision clock of the record. */
  readonly polledAt: number;
  /** NEW_BAR: first poll after T closed. SPOT_FILL: a later poll of the bar where a limit filled on the live spot. */
  readonly captureReason: 'NEW_BAR' | 'SPOT_FILL';
  readonly versions: Readonly<SnapshotVersions>;
  readonly config: Readonly<SnapshotConfig>;
  readonly dataQuality: Readonly<SnapshotDataQuality>;
  readonly inputs: Readonly<{
    /** Closed 15m bars ≤ T (the window the engines read). */
    ohlcv15m: readonly SnapshotBar[];
    /** Closed 5m bars (5m entry timeframe only). */
    ohlcv5m: readonly SnapshotBar[] | null;
    /** The 1h closes the HV read used (context only). */
    ohlcv1hCloses: readonly number[];
    spot: number | null;
    futures: FuturesChainResponse | null;
    /** Stored compressed (gzip + base64) in the database. */
    optionChain: OptionChain | null;
    optionMetrics: { pcr: number | null; atmIvPct: number | null; hvPct: number | null; ivVsHv: string | null };
    marketRegime: { regime: string; source: string } | null;
    /** The liquidity map of today's session on the closed 15m bars (diagnostic; the engines build their own pools from the same bars). */
    liquidityMap: readonly unknown[];
    corporateActions: { applicable: boolean; actions: readonly unknown[] };
    /** Stored state the engines read (Redis), as read before the decision. */
    structureState: unknown | null;
    familyRouterState: unknown | null;
    /** Anchor keys of parent moves already paper-traded today. */
    slotTradedKeys: readonly string[];
  }>;
}

export interface DecisionCandidateRecord {
  candidateId: string;
  source: string;
  direction: 'BULLISH' | 'BEARISH';
  /** Bar the rule decided on (open time) / the S1 fill bar. */
  decisionTime: number;
  stage: string;
  bucket: string | null;
  entry: number | null;
  stop: number | null;
  t1: number | null;
  rToT1: number | null;
  parentId: string | null;
  anchorKeys: string[];
  eventIds: string[];
  eligible: boolean;
  reason: string | null;
  handedToSlot: boolean;
  /** True when an input the candidate depends on was not OK at T (see dataQuality). */
  degraded: boolean;
  observation: { role: string; rank: number | null; reason: string | null; selectedTriggerId: string | null } | null;
}

export interface DecisionOptionCandidateRecord {
  candidateId: string;
  side: string | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  costPctOfPremium: number | null;
  netR: number | null;
  quality: string | null;
  degraded: boolean;
}

export interface DecisionRecord {
  schemaVersion: string;
  snapshotId: string;
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  decisionBarTime: number;
  decidedAt: number;
  /** NONDETERMINISTIC (declared): when this record object was generated. */
  generatedAt: number;
  degraded: boolean;
  degradedReasons: string[];
  structure: {
    status: 'OFF' | 'NOT_ENOUGH_BARS' | 'ADVANCED';
    reset: { from: string; to: string } | null;
    transitions: unknown[];
    lifecycles: Array<{ id: string; stage: string; direction: string; entry: number | null; stop: number | null; t1: number | null; outcome: string | null }>;
    fill: { lifecycleId: string; kind: string; price: number | null } | null;
  };
  families: {
    status: 'NOT_RUN' | 'NO_NEW_BAR' | 'EVALUATED';
    session: string | null;
    evaluatedBarTimes: number[];
    events: unknown[];
    linkage: unknown | null;
    watch: Array<{ lifecycleId: string; lastIndex: number; ended: { reason: string; at: number } | null }>;
  };
  /** Every trigger candidate decided this time (families) and the S1 fill. */
  candidates: DecisionCandidateRecord[];
  /** Candidate → the events it used, in order (written as its own association). */
  triggerEventIds: Array<{ candidateId: string; eventIds: string[] }>;
  /** The common decision-time metrics of every candidate handed to the slot. */
  metrics: Array<Record<string, unknown>>;
  optionCandidates: DecisionOptionCandidateRecord[];
  arbitration: {
    /** Candidates refused before ranking because their parent move already traded today. */
    parentAlreadyTraded: string[];
    /** Pre-build ranking on the measured common criteria (the slot re-ranks once option legs are built). */
    order: string[];
    used: string[];
    skipped: string[];
    lostOn: Record<string, string>;
  } | null;
  finalStatus: 'NO_CANDIDATE' | 'NO_ELIGIBLE_CANDIDATE' | 'CANDIDATES_TO_SLOT';
  /** Top of the pre-build ranking (null when nothing reached the slot). */
  selectedCandidateId: string | null;
  /** Parts of the live poll the record does not re-derive (their rows carry the snapshot id). */
  notReplayed: string[];
}
