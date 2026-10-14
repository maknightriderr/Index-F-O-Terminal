// ============================================================
// TERMINAL VIEW TYPES — read-only views the UI renders (types only)
// ============================================================
// Contracts between the server's read-only endpoints (paper trades, cached
// scans, bias snapshots, health extras) and the web terminal. No logic here:
// every figure is computed server-side from the authoritative records.
// ============================================================

import type { BiasDirection, Exchange, MarketRegime, TradingMode } from './index.js';

/** How a read-only endpoint obtained what it returned. Never a live computation. */
export type ReadSource = 'CACHE' | 'LAST_KNOWN' | 'DATABASE' | 'NONE';

/** Common envelope metadata of the read-only endpoints. */
export interface ReadOnlyMeta {
  /** Always true: the endpoint never computes, scans, mints or writes. */
  readOnly: true;
  source: ReadSource;
  /** When the underlying observation was made (epoch ms); null when unknown. */
  asOf: number | null;
  /** Seconds between `asOf` and the response; null when `asOf` is null. */
  ageSeconds: number | null;
  /** Why there is no data, when there is none. */
  unavailableReason?: string;
  timestamp: number;
}

// ---------------- paper trades ----------------

export type PaperTradeState = 'OPEN' | 'WIN' | 'LOSS' | 'EXPIRED';

/** Explicit tracking / population status — an untracked, voided or lost trade is never shown as a valid open trade. */
export type PaperTradeStatus = 'OPEN_TRACKED' | 'OPEN_UNTRACKED' | 'CLOSED' | 'VOIDED' | 'TRACKING_LOST' | 'OFF_SESSION' | 'SPREAD' | 'INCOMPLETE';

export type PaperTradeCostBasis = 'ESTIMATED_MODEL' | 'DEFAULT_ASSUMPTION' | 'UNAVAILABLE';

export interface PaperTradeView {
  id: string;
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  structureType: 'NAKED_LONG' | 'SPREAD';
  side: 'CE' | 'PE' | null;
  strike: number | null;
  expiry: string | null;
  direction: BiasDirection;
  /** The engine / trigger that won the slot (signals.inputs.source); null on rows before it was recorded. */
  family: string | null;
  strategyLabel: string;
  logicVersion: string | null;
  mintedAt: number;
  state: PaperTradeState;
  status: PaperTradeStatus;
  /** True only when the trade counts in performance figures. */
  includedInPerformance: boolean;
  /** Why it does not (VOIDED, TRACKING_LOST, OFF_SESSION, SPREAD, NO_GEOMETRY, OPEN), else null. */
  excludedReason: string | null;
  cohort: 'PRE' | 'POST_A' | 'POST_B';
  /** Minted from the measurement-reliable cutoff (server configuration), not before. */
  measurementReliable: boolean;
  entry: number | null;
  /** The stop at the mint. */
  initialStop: number | null;
  /** The current stop of an open trade (it trails); null for a closed one. */
  currentStop: number | null;
  target: number | null;
  /** Planned reward:risk recorded at the mint. */
  plannedRiskReward: number | null;
  exitPrice: number | null;
  exitAt: number | null;
  closeReason: string | null;
  holdMinutes: number | null;
  /** (exit − entry) / (entry − initial stop); null while open or without geometry. */
  grossR: number | null;
  /** Gross R minus the ESTIMATED cost in R. */
  netR: number | null;
  returnPercent: number | null;
  estimatedCost: {
    pct: number | null;
    basis: PaperTradeCostBasis;
    costR: number | null;
    /** From the per-trade cost record (trade_cost_records), when one exists. */
    record: { spreadSource: 'QUOTE' | 'FALLBACK_ASSUMED' | null; totalPerLotInr: number | null; costPctOfPlannedGrossProfit: number | null } | null;
  };
  /** Present for an open trade only. */
  live: null | {
    premium: number | null;
    observedAt: number | null;
    ageSeconds: number | null;
    unrealisedGrossR: number | null;
    unrealisedNetR: number | null;
    /** In ₹; only when the open trade's position size is known. */
    unrealisedPnlInr: number | null;
    quantity: number | null;
    health: { state: string; at: number; reason: string } | null;
    /** A Redis slot is tracking this trade right now. */
    slotTracked: boolean;
  };
  /** Always states that no order was placed. */
  disclosure: string;
}

export interface PaperTradesResponse {
  trades: PaperTradeView[];
  counts: {
    /** Rows in this response. */
    total: number;
    open: number;
    openUntracked: number;
    closed: number;
    excludedFromPerformance: number;
    /** Every paper trade ever recorded (not just the rows returned). Null when it could not be counted. */
    recorded: number | null;
    /** True when older closed trades exist that this response does not include (the response is the newest window). */
    truncated: boolean;
  };
  measurementReliableFrom: string;
  cohortBoundaries: { baselineChangeAt: string; trackingFixDeployedAt: string };
}

// ---------------- bias snapshot (read-only) ----------------

export interface BiasSnapshot {
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  direction: BiasDirection | null;
  confidence: number | null;
  regime: MarketRegime | string | null;
  /** Where this assessment comes from: the engine's cached result or the last recorded decision. */
  origin: 'ENGINE_CACHE' | 'LAST_DECISION_RECORD';
  /** When the assessment was made (epoch ms). */
  assessedAt: number | null;
  pcr: number | null;
  vix: number | null;
  underlyingPrice: number | null;
  /** The cached bias result in full when origin is ENGINE_CACHE (what the dashboard cards already render); null otherwise. */
  result: unknown | null;
  /** The last decision's own reason text when origin is LAST_DECISION_RECORD. */
  reason: string | null;
}
