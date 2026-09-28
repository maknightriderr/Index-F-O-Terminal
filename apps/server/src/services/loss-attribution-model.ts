// ============================================================
// LOSS ATTRIBUTION — pure aggregation (Phase 1)
// ============================================================
// Groups SIMULATED paper-trade outcomes by the dimensions a loss review
// needs, and answers a fixed set of questions as pre-built groupings rather
// than ad-hoc queries. Everything here is a read over recorded decisions;
// nothing filters or gates a live setup.
//
// TWO R MEASURES, NEVER MIXED
//   simR      decision_snapshots.outcome_r — the missed-winner audit's replay
//             of the thesis on the UNDERLYING, in stop-distance units. Present
//             for every graded decision, old or new.
//   premiumR  decision_snapshots.eventual_r — the gross OPTION-PREMIUM R of
//             the live paper close, backfilled from Phase 1 onward only.
// Win/loss counts use simR, because it is the one populated across the whole
// history. premiumR is reported beside it with its own n.
//
// SAMPLE SIZE IS STATED, NOT IMPLIED
// Every group carries its n and a sufficiency label. ADEQUATE means "enough
// rows to be worth reading", not "statistically significant".
// ============================================================

import { classifyDteBucket } from '@fno/shared';
import { EXIT_REASONS, type ExitReason } from './exit-reason.js';

export interface AttributionRow {
  decisionId: string;
  time: number;
  symbol: string;
  bias: string | null;
  regime: string | null;
  confidence: number | null;
  /** primary_strategy_label, else the older setup_family, else UNLABELLED. */
  strategy: string;
  side: 'CE' | 'PE' | null;
  /** |strike - spot| / ATR at the decision. */
  strikeDistanceAtr: number | null;
  delta: number | null;
  dte: number | null;
  /** IV in %. */
  ivPct: number | null;
  sessionBucket: string | null;
  signalAgeSeconds: number | null;
  spreadPct: number | null;
  exitReason: ExitReason | null;
  mfeAtr: number | null;
  maeAtr: number | null;
  simR: number | null;
  premiumR: number | null;
  eventualExitReason: ExitReason | null;
  deadAt: number | null;
  /** Phase 2 — which close branch fired (premium stop/target vs bias reversal). Null before Phase 2. */
  invalidationReason?: string | null;
  /** Phase 2 — OTHER live paper setups in the same direction when this one was minted. */
  sameDirectionExposure?: number | null;
  /** Phase 2 — OTHER live same-direction setups on a correlated index. */
  correlatedExposure?: number | null;
  /** Phase 3 (spec §15) — minutes since session open, decision_snapshots.minutes_from_session_open (Phase 1 column; already populated). */
  minutesFromSessionOpen?: number | null;
  /** Phase 3 (spec §15) — opening-classifier.ts's label. Null outside the opening window or before Phase 3 recorded it. */
  openingEnvironment?: string | null;
  /** Phase 3 (spec §16) — minutes since the most recent recoverable stop-loss (see market-bias.ts's readMinutesSinceLastLoss). Null when not recoverable. */
  minutesSinceLastLoss?: number | null;
  /** Validation review — decision_snapshots.logic_version. Null = recorded before stamping (migration 026). */
  logicVersion?: string | null;
  /** Momentum-break round — decision_snapshots.setup_family ('MOMENTUM' for a momentum-break decision). */
  setupFamily?: string | null;
}

/** Which setup family a decision belongs to: the momentum-break trigger, or the consensus engine (everything else, including pre-round rows). */
export function strategyFamilyOf(r: Pick<AttributionRow, 'setupFamily'>): 'MOMENTUM_BREAK' | 'CONSENSUS' {
  return r.setupFamily === 'MOMENTUM' ? 'MOMENTUM_BREAK' : 'CONSENSUS';
}

/**
 * The three R definitions in this system, named once so every screen labels
 * them the same way. They are different quantities and are never mixed.
 */
export const R_DEFINITIONS = {
  simR: 'Underlying replay R — decision_snapshots.outcome_r: the missed-winner audit replay of the thesis on the underlying, in stop-distance units.',
  premiumR: 'Premium R (gross) — decision_snapshots.eventual_r: the option-premium R of the live paper close, before costs.',
  backtestingR: 'Premium R (net) — Backtesting: the option-premium R of the paper close after estimated round-trip costs.',
} as const;

/** How an unstamped (pre-026) decision is grouped in the logic-version split. */
export const PRE_REVIEW_LOGIC_VERSION = 'PRE_REVIEW';

export type SampleSufficiency = 'INSUFFICIENT' | 'LOW' | 'ADEQUATE';

export const SAMPLE_INSUFFICIENT_BELOW = 10;
export const SAMPLE_LOW_BELOW = 30;

export function sampleSufficiency(n: number): SampleSufficiency {
  if (n < SAMPLE_INSUFFICIENT_BELOW) return 'INSUFFICIENT';
  if (n < SAMPLE_LOW_BELOW) return 'LOW';
  return 'ADEQUATE';
}

export interface GroupStats {
  key: string;
  n: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: number | null;
  avgSimR: number | null;
  totalSimR: number;
  premiumR: { n: number; avg: number | null };
  exitReasons: Record<ExitReason, number>;
  exitReasonPct: Record<ExitReason, number | null>;
  sample: SampleSufficiency;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function emptyExitCounts(): Record<ExitReason, number> {
  return Object.fromEntries(EXIT_REASONS.map((e) => [e, 0])) as Record<ExitReason, number>;
}

export function summarise(key: string, rows: readonly AttributionRow[]): GroupStats {
  const graded = rows.filter((r) => r.simR != null);
  const wins = graded.filter((r) => r.simR! > 0).length;
  const losses = graded.filter((r) => r.simR! < 0).length;
  const totalSimR = graded.reduce((s, r) => s + r.simR!, 0);
  const prem = rows.filter((r) => r.premiumR != null);
  const exitReasons = emptyExitCounts();
  let withExit = 0;
  for (const r of rows) {
    if (r.exitReason) {
      exitReasons[r.exitReason] += 1;
      withExit += 1;
    }
  }
  const exitReasonPct = Object.fromEntries(
    EXIT_REASONS.map((e) => [e, withExit > 0 ? r2((exitReasons[e] / withExit) * 100) : null])
  ) as Record<ExitReason, number | null>;
  return {
    key,
    n: graded.length,
    wins,
    losses,
    flat: graded.length - wins - losses,
    winRate: graded.length > 0 ? r2((wins / graded.length) * 100) : null,
    avgSimR: graded.length > 0 ? r4(totalSimR / graded.length) : null,
    totalSimR: r4(totalSimR),
    premiumR: { n: prem.length, avg: prem.length > 0 ? r4(prem.reduce((s, r) => s + r.premiumR!, 0) / prem.length) : null },
    exitReasons,
    exitReasonPct,
    sample: sampleSufficiency(graded.length),
  };
}

export function groupBy(rows: readonly AttributionRow[], keyOf: (r: AttributionRow) => string): GroupStats[] {
  const groups = new Map<string, AttributionRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  // Worst total first: the question is where the losses come from.
  return [...groups.entries()].map(([k, g]) => summarise(k, g)).sort((a, b) => a.totalSimR - b.totalSimR);
}

// --- Buckets. Reporting only; none of these is a threshold anywhere else. ---

function bucket(v: number | null, edges: readonly number[], labels: readonly string[]): string {
  if (v == null || !Number.isFinite(v)) return 'UNKNOWN';
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

export const buckets = {
  strikeDistanceAtr: (v: number | null) => bucket(v, [0.25, 0.5, 1, 2], ['<0.25 ATR (ATM)', '0.25-0.5 ATR', '0.5-1 ATR', '1-2 ATR', '2+ ATR']),
  delta: (v: number | null) => bucket(v == null ? null : Math.abs(v), [0.2, 0.35, 0.5, 0.65], ['<0.20', '0.20-0.35', '0.35-0.50', '0.50-0.65', '0.65+']),
  // Phase 2: the one shared DTE bucket definition (also persisted as
  // decision_snapshots.dte_bucket), instead of a report-local set of edges.
  dte: (v: number | null) => classifyDteBucket(v) ?? 'UNKNOWN',
  ivPct: (v: number | null) => bucket(v, [15, 25, 35, 50], ['<15%', '15-25%', '25-35%', '35-50%', '50%+']),
  signalAgeSeconds: (v: number | null) => bucket(v, [5, 30, 60, 300], ['<5s', '5-30s', '30-60s', '1-5m', '5m+']),
  spreadPct: (v: number | null) => bucket(v, [1, 2, 3.5, 5], ['<1%', '1-2%', '2-3.5%', '3.5-5%', '5%+']),
  excursionAtr: (v: number | null) => bucket(v, [0.25, 0.5, 1, 2], ['<0.25 ATR', '0.25-0.5 ATR', '0.5-1 ATR', '1-2 ATR', '2+ ATR']),
  // Phase 3 (spec §15) — the opening window's own 15-minute sub-windows.
  // Only meaningful under SETUP_OPENING_GUARD_MINUTES=60 (market-bias.ts);
  // a value at/above 60 falls into the open-ended last label.
  minutesSinceOpen15: (v: number | null) => bucket(v, [15, 30, 45, 60], ['0-15m', '15-30m', '30-45m', '45-60m', '60m+']),
};

export interface AttributionQuestion {
  id: string;
  question: string;
  dimension: string;
  keyOf: (r: AttributionRow) => string;
  /** Restrict to losing trades before grouping (for "how did losers behave" questions). */
  losersOnly?: boolean;
}

/** The pre-built questions. Fixed, so the same question gets the same query every time. */
export const ATTRIBUTION_QUESTIONS: readonly AttributionQuestion[] = [
  { id: 'Q1', question: 'Which strategies lose the most?', dimension: 'strategy', keyOf: (r) => r.strategy },
  { id: 'Q2', question: 'Which symbols lose the most?', dimension: 'symbol', keyOf: (r) => r.symbol },
  { id: 'Q3', question: 'Does direction (bullish CE vs bearish PE) matter?', dimension: 'direction', keyOf: (r) => `${r.bias ?? 'UNKNOWN'}${r.side ? ` ${r.side}` : ''}` },
  { id: 'Q4', question: 'Does strike distance from spot matter?', dimension: 'strike_distance', keyOf: (r) => buckets.strikeDistanceAtr(r.strikeDistanceAtr) },
  { id: 'Q5', question: 'Does the entry delta matter?', dimension: 'delta', keyOf: (r) => buckets.delta(r.delta) },
  { id: 'Q6', question: 'Does days-to-expiry matter?', dimension: 'dte', keyOf: (r) => buckets.dte(r.dte) },
  { id: 'Q7', question: 'Does implied volatility at entry matter?', dimension: 'iv', keyOf: (r) => buckets.ivPct(r.ivPct) },
  { id: 'Q8', question: 'Does time of day matter?', dimension: 'time_of_day', keyOf: (r) => r.sessionBucket ?? 'UNKNOWN' },
  { id: 'Q9', question: 'Which market regimes lose?', dimension: 'regime', keyOf: (r) => r.regime ?? 'UNKNOWN' },
  { id: 'Q10', question: 'Does signal age (input staleness) at entry matter?', dimension: 'signal_age', keyOf: (r) => buckets.signalAgeSeconds(r.signalAgeSeconds) },
  { id: 'Q11', question: 'Does the bid-ask spread at entry matter?', dimension: 'spread', keyOf: (r) => buckets.spreadPct(r.spreadPct) },
  { id: 'Q12', question: 'How do losing trades exit, and did they ever work first (MFE)?', dimension: 'exit_reason x MFE (losers only)', keyOf: (r) => `${r.exitReason ?? 'UNGRADED'} | MFE ${buckets.excursionAtr(r.mfeAtr)}`, losersOnly: true },
];

export interface QuestionAnswer {
  id: string;
  question: string;
  dimension: string;
  groups: GroupStats[];
}

export interface DeadTradeReport {
  flaggedDead: GroupStats;
  neverFlagged: GroupStats;
  /** Of the dead-flagged trades with a recorded premium close, how many ended above zero. */
  recoveredPct: number | null;
  note: string;
}

export interface AttributionReport {
  simulated: true;
  note: string;
  population: { rows: number; graded: number; from: string | null; to: string | null };
  overall: GroupStats;
  questions: QuestionAnswer[];
  mae: GroupStats[];
  deadTrades: DeadTradeReport;
  /** Phase 2 — losses by which close branch fired. Rows before Phase 2 group as NOT_RECORDED. */
  invalidation: GroupStats[];
  /** Phase 2 — outcomes by concurrent same-direction / correlated exposure at creation. Observational. */
  exposure: { sameDirection: GroupStats[]; correlated: GroupStats[]; note: string };
  /** Validation review — the same outcomes split by the logic version the decision was made under. */
  byLogicVersion: GroupStats[];
  /** Momentum-break round — the same outcomes split by setup family (MOMENTUM_BREAK vs CONSENSUS), never pooled. */
  byStrategy: GroupStats[];
  /** Validation review — what simR and premiumR are, verbatim, for labelling. */
  rDefinitions: typeof R_DEFINITIONS;
}

const exposureBucket = (v: number | null | undefined) => (v == null ? 'NOT_RECORDED' : v === 0 ? '0 others' : v === 1 ? '1 other' : '2+ others');

export const SIMULATION_NOTE =
  'PAPER TRADES ONLY. Every figure is a SIMULATED OUTCOME graded against stop/target levels — no order was placed, ' +
  'nothing was filled, and no number here is account P&L. simR is the underlying replay; premiumR is the option-premium ' +
  'paper close (recorded from Phase 1 onward). Sample sizes are stated per group; ADEQUATE is not a significance claim.';

export function buildAttributionReport(rows: readonly AttributionRow[]): AttributionReport {
  const times = rows.map((r) => r.time).filter((t) => Number.isFinite(t));
  const questions = ATTRIBUTION_QUESTIONS.map((q) => {
    const pool = q.losersOnly ? rows.filter((r) => r.simR != null && r.simR < 0) : rows;
    return { id: q.id, question: q.question, dimension: q.dimension, groups: groupBy(pool, q.keyOf) };
  });

  const dead = rows.filter((r) => r.deadAt != null);
  const deadWithPremium = dead.filter((r) => r.premiumR != null);
  return {
    simulated: true,
    note: SIMULATION_NOTE,
    population: {
      rows: rows.length,
      graded: rows.filter((r) => r.simR != null).length,
      from: times.length ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    },
    overall: summarise('ALL', rows),
    questions,
    mae: groupBy(rows, (r) => `MAE ${buckets.excursionAtr(r.maeAtr)}`),
    deadTrades: {
      flaggedDead: summarise('FLAGGED_DEAD', dead),
      neverFlagged: summarise('NEVER_FLAGGED', rows.filter((r) => r.deadAt == null)),
      recoveredPct: deadWithPremium.length > 0 ? r2((deadWithPremium.filter((r) => r.premiumR! > 0).length / deadWithPremium.length) * 100) : null,
      note:
        'Dead = trade-health\'s existing rule (under 0.25 ATR of favourable move by 30 minutes) fired. Reporting only: no trade was ' +
        'closed on it. Recorded from Phase 1 onward, so older trades all sit in NEVER_FLAGGED.',
    },
    invalidation: groupBy(rows, (r) => r.invalidationReason ?? 'NOT_RECORDED'),
    exposure: {
      sameDirection: groupBy(rows, (r) => `same-direction: ${exposureBucket(r.sameDirectionExposure)}`),
      correlated: groupBy(rows, (r) => `correlated: ${exposureBucket(r.correlatedExposure)}`),
      note:
        'Simulated portfolio accounting only — paper setups, not broker positions. Counts the OTHER live paper setups when each ' +
        'setup was minted. Observational: nothing is blocked or sized on it. Recorded from Phase 2 onward.',
    },
    byLogicVersion: groupBy(rows, (r) => r.logicVersion ?? PRE_REVIEW_LOGIC_VERSION),
    byStrategy: groupBy(rows, strategyFamilyOf),
    rDefinitions: R_DEFINITIONS,
  };
}

export interface SplitReport {
  splitAt: string;
  splitReason: string;
  inSample: AttributionReport;
  outOfSample: AttributionReport;
}

/**
 * The same report either side of a boundary. Phase 1 changes nothing about
 * which setups are generated, so "before/after" here is the data-quality
 * cutover already present in the data — a natural in-sample/out-of-sample
 * split, not an intervention.
 */
export function buildSplitReport(rows: readonly AttributionRow[], splitAt: number, splitReason: string): SplitReport {
  return {
    splitAt: new Date(splitAt).toISOString(),
    splitReason,
    inSample: buildAttributionReport(rows.filter((r) => r.time < splitAt)),
    outOfSample: buildAttributionReport(rows.filter((r) => r.time >= splitAt)),
  };
}

// ============================================================
// OPENING-HOUR GRANULAR BREAKDOWN (Phase 3, spec §15)
// ============================================================
// SETUP_OPENING_GUARD_MINUTES already refuses the whole first 60 minutes,
// on the evidence that they lost 7.5R across 20 trades. This does not
// revisit that — it re-buckets the same window into 15-minute sub-windows
// crossed with opening-classifier.ts's environment label, pure reporting
// over decision_snapshots.time vs session open, reusing the same
// groupBy/summarise/sample-sufficiency machinery as every other question
// above rather than a bespoke aggregation.
// ============================================================

export interface OpeningHourReport {
  /** Every recorded decision (TAKE or REFUSE, per the query scope) inside the 0-60m opening window. */
  overall: GroupStats;
  byWindow: GroupStats[];
  byEnvironment: GroupStats[];
  byWindowAndEnvironment: GroupStats[];
  note: string;
}

const UNLABELLED_OPENING_ENV = 'UNLABELLED (recorded before Phase 3, or the window minutes were unavailable)';

export function buildOpeningHourReport(rows: readonly AttributionRow[]): OpeningHourReport {
  const inWindow = rows.filter((r) => r.minutesFromSessionOpen != null && r.minutesFromSessionOpen < 60);
  const envKey = (r: AttributionRow) => r.openingEnvironment ?? UNLABELLED_OPENING_ENV;
  return {
    overall: summarise('OPENING WINDOW (0-60m)', inWindow),
    byWindow: groupBy(inWindow, (r) => buckets.minutesSinceOpen15(r.minutesFromSessionOpen ?? null)),
    byEnvironment: groupBy(inWindow, envKey),
    byWindowAndEnvironment: groupBy(inWindow, (r) => `${buckets.minutesSinceOpen15(r.minutesFromSessionOpen ?? null)} | ${envKey(r)}`),
    note:
      'Granular breakdown of the opening 60 minutes (spec §15) — SETUP_OPENING_GUARD_MINUTES and the OPENING_HOUR gate are UNCHANGED by this; ' +
      'it only re-buckets what already happened inside and around that window. opening_environment populates from Phase 3 onward — rows recorded ' +
      'earlier, or where the classifier had no minutes-since-open to work from, group as UNLABELLED. Sample sizes are stated per group; ' +
      'ADEQUATE is not a significance claim.',
  };
}

// ============================================================
// COOLDOWN-EFFECTIVENESS RECALCULATION (Phase 3, spec §16)
// ============================================================
// The cooldown gate's own docstring (market-bias.ts, losingCloseCooldownReason)
// carries a one-time, 39-setup study frozen at the moment it was measured:
//   within 15 minutes: 12 trades, -0.28R    15-60 minutes: 7 trades, +0.82R
//   60+ minutes: 20 trades, +0.41R          same symbol+side within the hour: 5, -0.48R
// minutes_since_last_loss now makes that comparison re-runnable on LIVE data
// as it accumulates. It is recoverable only while the Redis TTL behind it is
// still alive (see readMinutesSinceLastLoss in market-bias.ts): 0-15 minutes
// from the any-symbol post-loss settle key, 15-60 minutes ONLY from this
// symbol+direction's own SL cooldown key. That asymmetry means the 15-60m
// bucket below IS the "same symbol+direction" case by construction — there
// is no way for a DIFFERENT symbol's loss between 15 and 60 minutes ago to
// produce a value here, which is a real gap against the original study's
// four buckets, stated plainly rather than guessed at.
//
// No cooldown constant is read, checked or proposed for change by this
// report — one re-run is not out-of-sample evidence (see the project's own
// evidence-gate rule), it only makes the comparison possible going forward.
// ============================================================

export interface CooldownEffectivenessReport {
  overall: GroupStats;
  byBucket: GroupStats[];
  note: string;
}

function cooldownBucket(minutesSinceLastLoss: number | null | undefined): string {
  if (minutesSinceLastLoss == null) return 'NO_RECENT_LOSS_OR_NOT_RECOVERABLE';
  if (minutesSinceLastLoss < 15) return 'within-15min (any symbol just lost)';
  if (minutesSinceLastLoss <= 60) return 'same-symbol-same-side-within-hour (15-60min)';
  return '60min+ since last recoverable loss';
}

export function buildCooldownEffectivenessReport(rows: readonly AttributionRow[]): CooldownEffectivenessReport {
  const withReading = rows.filter((r) => r.minutesSinceLastLoss != null);
  return {
    overall: summarise('FOLLOWED A RECOVERABLE RECENT LOSS', withReading),
    byBucket: groupBy(withReading, (r) => cooldownBucket(r.minutesSinceLastLoss)),
    note:
      'Re-bucketed on CURRENT decision_snapshots data (spec §16), reproducing the shape of the frozen 39-setup study in the cooldown gate\'s own ' +
      "docstring — not the same rows, and not a claim the numbers will match. minutes_since_last_loss only survives beyond 15 minutes for THIS " +
      "symbol+direction's own cooldown key, so the 15-60min bucket here is the same-symbol-same-side case by construction; a different symbol's " +
      "loss 15-60 minutes ago cannot be distinguished from no loss at all and falls out of this report entirely — a real limitation of the current " +
      'Redis-TTL-only design, not a rounding choice. No cooldown constant is read or proposed for change by this report; one run on live data is ' +
      'not out-of-sample evidence. Sample sizes are stated per bucket; ADEQUATE is not a significance claim.',
  };
}
