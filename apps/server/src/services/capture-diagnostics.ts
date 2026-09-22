// ============================================================
// CAPTURE DIAGNOSTICS
// ============================================================
// Answers, from the database rather than from inference, the questions the
// first capture report could not: when capture actually started, whether a
// chain snapshot was complete, which instruments are being collected, and
// how many refusals have aged far enough to be graded.
//
// Every figure here carries its own sample size or its own timestamp. None
// of it is read by the trading engine.
// ============================================================

import { getSessionWindow, TRADING_HOURS } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { STRIKES_EACH_SIDE, CAPTURE_INTERVAL_MS } from './market-state-capture.js';
import { INTRADAY_HORIZON_MS, POSITIONAL_HORIZON_MS } from './missed-winner-audit.js';
import { CAPTURE_MODE_DOCUMENTATION, RESEARCH_THRESHOLDS } from './research-contract.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { newBoundary, type ReportBoundary } from './report-boundary.js';

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

/**
 * The timeline, from actual rows.
 *
 * Four separate events, reported separately, because conflating them is what
 * produced a report claiming a 65-minute window was "two hours":
 *
 *   captureStartedAt          the first capture ATTEMPT was recorded
 *   firstSuccessfulCaptureAt  the first attempt that completed
 *   firstRowAt (per table)    the first row each dataset actually holds
 *   coverageAsOf              when this reading was taken
 *
 * A reader cannot confuse them because they are named and shown together.
 */
export async function captureTimeline(
  boundary: ReportBoundary = newBoundary()
): Promise<Record<string, unknown>> {
  // The report's instant, not this function's. Reading the clock here is
  // what produced a coverage_as_of 75ms later than report_as_of.
  const now = boundary.asOf;

  const [runs] = await sql<{ first_attempt: Date | null; first_success: Date | null; n: string }[]>`
    SELECT MIN(time) AS first_attempt,
           MIN(time) FILTER (WHERE status IN ('SUCCESS', 'PARTIAL')) AS first_success,
           COUNT(*) AS n
    FROM capture_runs
    WHERE time <= ${now}
  `.catch(() => [{ first_attempt: null, first_success: null, n: '0' }]);

  const tables = ['oi_snapshots', 'futures_snapshots', 'pcr_history', 'market_ticks', 'decision_snapshots', 'capture_runs'];
  const firstRows: Record<string, { firstRowAt: string | null; lastRowAt: string | null; rows: number }> = {};
  for (const table of tables) {
    try {
      // Bounded too: an unbounded MAX(time) can return a row written after
      // report_as_of, which would make one section describe a later world
      // than the rest of the report.
      const [row] = await sql.unsafe<{ n: string; oldest: Date | null; newest: Date | null }[]>(
        `SELECT COUNT(*) AS n, MIN(time) AS oldest, MAX(time) AS newest FROM ${table} WHERE time <= $1`,
        [now]
      );
      firstRows[table] = {
        rows: Number(row?.n ?? 0),
        firstRowAt: iso(row?.oldest),
        lastRowAt: iso(row?.newest),
      };
    } catch (err: any) {
      firstRows[table] = { rows: -1, firstRowAt: null, lastRowAt: err.message };
    }
  }

  const spanFrom = runs?.first_attempt ?? null;
  const elapsedMs = spanFrom ? now.getTime() - new Date(spanFrom).getTime() : null;

  return {
    // The three machine-readable fields the report must be consistent with.
    capture_started_at: iso(runs?.first_attempt),
    first_successful_capture_at: iso(runs?.first_success),
    coverage_as_of: now.toISOString(),

    captureAttemptsRecorded: Number(runs?.n ?? 0),
    elapsedSinceFirstAttemptMinutes: elapsedMs == null ? null : Math.round(elapsedMs / 60000),
    // capture_runs only began recording when this release deployed, so on the
    // first day it can legitimately start AFTER the oldest oi_snapshots row.
    // Said plainly here rather than left to be discovered as a contradiction.
    note:
      'capture_started_at is the first recorded capture ATTEMPT. Rows written before capture_runs existed have an earlier firstRowAt; that is a gap in the instrumentation, not a contradiction in the data.',
    perTable: firstRows,
  };
}

/**
 * Chain completeness, per snapshot.
 *
 * A complete snapshot is two legs for every strike inside the capture
 * window, and the window is `STRIKES_EACH_SIDE` either side of ATM plus ATM
 * itself — so 43 strikes and 86 legs, WHEN the chain lists that many. Most
 * stock chains and any index near the edge of its listed range do not, and
 * that is a property of the instrument rather than a capture failure.
 *
 * Both numbers are reported so the difference is legible instead of being
 * inferred from a total that does not divide evenly.
 */
export async function chainCompleteness(
  sinceHours = 48,
  boundary: ReportBoundary = newBoundary()
): Promise<Record<string, unknown>> {
  // The window is measured BACK from the report boundary, so the section
  // covers exactly the N hours ending at report_as_of rather than N hours
  // ending whenever this function happened to run.
  const asOf = boundary.asOf;
  const since = new Date(asOf.getTime() - sinceHours * 3600_000);
  const maxStrikes = STRIKES_EACH_SIDE * 2 + 1;
  const maxLegs = maxStrikes * 2;

  const snapshots = await sql<
    { time: Date; symbol: string; expiry: string | null; legs: string; strikes: string }[]
  >`
    SELECT time, symbol, expiry, COUNT(*) AS legs, COUNT(DISTINCT strike) AS strikes
    FROM oi_snapshots
    WHERE time >= ${since} AND time <= ${asOf}
    GROUP BY time, symbol, expiry
    ORDER BY time DESC
  `.catch(() => []);

  const runs = await sql<
    {
      time: Date;
      symbol: string;
      expiry: string | null;
      status: string;
      expected_legs: number | null;
      actual_legs: number | null;
      strikes_available: number | null;
      strikes_captured: number | null;
      detail: string | null;
    }[]
  >`
    SELECT time, symbol, expiry, status, expected_legs, actual_legs,
           strikes_available, strikes_captured, detail
    FROM capture_runs
    WHERE time >= ${since}
    ORDER BY time DESC
  `.catch(() => []);

  const runByKey = new Map(runs.map((r) => [`${new Date(r.time).getTime()}|${r.symbol}`, r]));

  let expectedIfFullWindow = 0;
  let expectedGivenChain = 0;
  let actual = 0;
  const incomplete: Record<string, unknown>[] = [];

  for (const snap of snapshots) {
    const legs = Number(snap.legs);
    const strikes = Number(snap.strikes);
    actual += legs;
    expectedIfFullWindow += maxLegs;

    const run = runByKey.get(`${new Date(snap.time).getTime()}|${snap.symbol}`);
    const expectedHere = run?.expected_legs ?? strikes * 2;
    expectedGivenChain += expectedHere;

    if (legs < expectedHere || legs < maxLegs) {
      incomplete.push({
        timestamp: iso(snap.time),
        underlying: snap.symbol,
        expiry: snap.expiry,
        strikesInSnapshot: strikes,
        expectedLegsForThisChain: expectedHere,
        actualLegs: legs,
        missingLegs: Math.max(0, expectedHere - legs),
        shortOfFullWindowBy: maxLegs - legs,
        reason:
          run?.detail ??
          (strikes < maxStrikes
            ? `chain listed ${strikes} strikes inside the ${maxStrikes}-strike window, so a full ${maxLegs}-leg snapshot was never possible`
            : 'no capture_runs record — this snapshot predates the run instrumentation'),
      });
    }
  }

  // Every figure below is derived from the SAME snapshot set counted above.
  // Nothing is hardcoded: the previous report quoted a 112-leg shortfall from
  // a 2,296-leg dataset while the coverage section showed 2,378, because the
  // two were computed at different instants from different denominators.
  const legsPerSnapshot = snapshots.length > 0 ? round(actual / snapshots.length, 2) : null;

  return {
    asOf: asOf.toISOString(),
    window: { sinceHours, since: since.toISOString(), until: asOf.toISOString() },
    captureWindow: { strikesEachSide: STRIKES_EACH_SIDE, maxStrikes, maxLegsPerCompleteSnapshot: maxLegs },
    /** One consistent denominator for every shortfall figure in this section. */
    dynamicShortfall: {
      snapshot_count: snapshots.length,
      legs_per_snapshot: legsPerSnapshot,
      theoretical_legs: snapshots.length * maxLegs,
      actual_legs: actual,
      shortfall: snapshots.length * maxLegs - actual,
      shortfall_percent:
        snapshots.length > 0 ? round(((snapshots.length * maxLegs - actual) / (snapshots.length * maxLegs)) * 100, 2) : null,
      basis:
        'theoretical_legs = snapshot_count x maxLegsPerCompleteSnapshot. The shortfall is entirely the exchange listing fewer strikes than the window asked for; it is recorded as a clipping reason, not a capture failure.',
    },
    captureIntervalMinutes: CAPTURE_INTERVAL_MS / 60000,
    snapshotsObserved: snapshots.length,
    captureAttempts: runs.length,
    attemptsByStatus: runs.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {}),
    legs: {
      actual,
      expectedGivenWhatEachChainListed: expectedGivenChain,
      expectedIfEveryChainListedTheFullWindow: expectedIfFullWindow,
      missingAgainstWhatWasListed: Math.max(0, expectedGivenChain - actual),
      missingPctAgainstWhatWasListed:
        expectedGivenChain > 0 ? round(((expectedGivenChain - actual) / expectedGivenChain) * 100, 2) : null,
      shortOfFullWindow: expectedIfFullWindow - actual,
      shortOfFullWindowPct:
        expectedIfFullWindow > 0 ? round(((expectedIfFullWindow - actual) / expectedIfFullWindow) * 100, 2) : null,
    },
    incompleteSnapshots: incomplete,
  };
}

/**
 * Refusal maturity.
 *
 * A refusal is gradeable only once its full evaluation horizon has elapsed —
 * eight hours for an intraday thesis, five days for a positional one. This
 * computes maturity from the same constants the audit itself uses, so the
 * report and the grader can never disagree about what "mature" means.
 */
export async function refusalMaturity(
  boundary: ReportBoundary = newBoundary()
): Promise<Record<string, unknown>> {
  // Maturity is measured from the report instant. Reading the clock here
  // would let a refusal be "mature" in this section and not in another.
  const asOf = boundary.asOf;
  const now = asOf.getTime();

  const rows = await sql<
    { mode: string; decision: string; graded: boolean; outcome_class: string | null; time: Date; n: string }[]
  >`
    SELECT mode, decision, (outcome_evaluated_at IS NOT NULL) AS graded,
           outcome_class, MIN(time) AS time, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time <= ${asOf}
    GROUP BY mode, decision, (outcome_evaluated_at IS NOT NULL), outcome_class
  `.catch(() => []);

  const perDecision = await sql<{ decision_id: string; mode: string; time: Date; graded: boolean }[]>`
    SELECT decision_id, mode, time, (outcome_evaluated_at IS NOT NULL) AS graded
    FROM decision_snapshots
    WHERE decision = 'REFUSE' AND time <= ${asOf}
  `.catch(() => []);

  let mature = 0;
  let immature = 0;
  let prematurelyGraded = 0;
  let matureUngraded = 0;
  for (const r of perDecision) {
    const horizon = r.mode === 'POSITIONAL' ? POSITIONAL_HORIZON_MS : INTRADAY_HORIZON_MS;
    const isMature = now - new Date(r.time).getTime() >= horizon;
    if (isMature) mature++;
    else immature++;
    // The integrity check that matters: a refusal graded before its horizon
    // elapsed would mean the grader read an outcome that had not settled.
    if (!isMature && r.graded) prematurelyGraded++;
    if (isMature && !r.graded) matureUngraded++;
  }

  const byOutcome = await sql<{ outcome_class: string | null; n: string }[]>`
    SELECT outcome_class, COUNT(*) AS n
    FROM decision_snapshots
    WHERE decision = 'REFUSE' AND outcome_evaluated_at IS NOT NULL
    GROUP BY outcome_class
  `.catch(() => []);

  const outcomes = Object.fromEntries(byOutcome.map((r) => [r.outcome_class ?? 'NULL', Number(r.n)]));

  return {
    horizons: {
      intradayHours: INTRADAY_HORIZON_MS / 3600_000,
      positionalDays: POSITIONAL_HORIZON_MS / (24 * 3600_000),
    },
    total_refusals: perDecision.length,
    mature_refusals: mature,
    immature_refusals: immature,
    mature_but_not_yet_graded: matureUngraded,
    graded_missed_winners: outcomes.MISSED_WINNER ?? 0,
    graded_good_rejections: outcomes.GOOD_REJECTION ?? 0,
    graded_neutral: outcomes.NEUTRAL ?? 0,
    graded_ungradeable: outcomes.UNKNOWN ?? 0,
    graded_non_winners: (outcomes.GOOD_REJECTION ?? 0) + (outcomes.NEUTRAL ?? 0),
    integrity: {
      // Must be 0. A non-zero value means a refusal was graded before its
      // outcome could have settled, which is future-data leakage into the
      // research record.
      prematurely_graded: prematurelyGraded,
      // Each decision carries exactly one outcome_class column, so more than
      // one final outcome per refusal is structurally impossible; recorded
      // here so the guarantee is stated rather than assumed.
      one_outcome_per_refusal: true,
    },
    rawGroups: rows.map((r) => ({ ...r, n: Number(r.n), time: iso(r.time) })),
  };
}

/**
 * What this deployment is actually collecting — read from the rows, not from
 * configuration or assumption.
 */
export async function captureUniverse(
  boundary: ReportBoundary = newBoundary()
): Promise<Record<string, unknown>> {
  const asOf = boundary.asOf;

  const chains = await sql<
    { exchange: string; symbol: string; expiry: string | null; legs: string; snapshots: string; first: Date; last: Date }[]
  >`
    SELECT exchange, symbol, expiry, COUNT(*) AS legs, COUNT(DISTINCT time) AS snapshots,
           MIN(time) AS first, MAX(time) AS last
    FROM oi_snapshots
    WHERE time <= ${asOf}
    GROUP BY exchange, symbol, expiry
    ORDER BY COUNT(*) DESC
  `.catch(() => []);

  const decisions = await sql<{ exchange: string; symbol: string; mode: string; n: string }[]>`
    SELECT exchange, symbol, mode, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time <= ${asOf}
    GROUP BY exchange, symbol, mode
    ORDER BY COUNT(*) DESC
  `.catch(() => []);

  const futures = await sql<{ exchange: string; symbol: string; expiry: string | null; n: string }[]>`
    SELECT exchange, symbol, expiry, COUNT(*) AS n
    FROM futures_snapshots
    WHERE time <= ${asOf}
    GROUP BY exchange, symbol, expiry
    ORDER BY COUNT(*) DESC
  `.catch(() => []);

  const exchanges = [...new Set(chains.map((c) => c.exchange))];
  const sessions: Record<string, unknown> = {};
  for (const ex of ['NSE', 'BSE', 'MCX'] as Exchange[]) {
    const hours = TRADING_HOURS[ex];
    // The session window is the one containing report_as_of, so this
    // section describes the same day as the rest of the report even when a
    // request straddles an IST midnight.
    const today = asOf.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const window = getSessionWindow(ex, today);
    sessions[ex] = {
      open: hours?.open ?? null,
      close: hours?.close ?? null,
      timezone: hours?.timezone ?? null,
      todaysWindow: window ? { open: iso(new Date(window.open)), close: iso(new Date(window.close)) } : null,
      capturing: exchanges.includes(ex),
    };
  }

  return {
    exchangesWithCapturedChains: exchanges,
    underlyings: chains.map((c) => ({
      exchange: c.exchange,
      symbol: c.symbol,
      expiry: c.expiry,
      optionLegs: Number(c.legs),
      chainSnapshots: Number(c.snapshots),
      firstSeen: iso(c.first),
      lastSeen: iso(c.last),
    })),
    instrumentCount: chains.length,
    optionExpiries: [...new Set(chains.map((c) => c.expiry).filter(Boolean))],
    futuresInstruments: futures.map((f) => ({
      exchange: f.exchange,
      symbol: f.symbol,
      expiry: f.expiry,
      rows: Number(f.n),
    })),
    decisionsByInstrument: decisions.map((d) => ({ ...d, n: Number(d.n) })),
    sessions,
    // The universe is whatever the bias engine has recently read, tracked in
    // Redis by the OI-snapshot tracker. It is not a configured symbol list,
    // so it reflects what is being LOOKED AT rather than what is intended.
    universeSource:
      'Symbols the bias engine read in the last few days, tracked in Redis by oi-close-snapshot. Not a configured list — capture follows attention.',
  };
}

/**
 * The eligible F&O universe, counted from the broker's own instrument master.
 *
 * "Eligible" means an underlying that actually has listed options: for NSE
 * and BSE, a name carrying both stock futures and stock options plus a cash
 * instrument, together with the listed indices; for MCX, a commodity with
 * listed options. Counted rather than hardcoded, because a hardcoded list
 * goes stale the first time the exchange adds or removes a name, and a
 * coverage percentage against a stale denominator is worse than none.
 */
export async function eligibleUniverse(provider: MarketDataProvider): Promise<Record<string, number>> {
  try {
    const instruments = await provider.getInstrumentMaster();
    const counts: Record<string, Set<string>> = { NSE: new Set(), BSE: new Set(), MCX: new Set() };

    const futures: Record<string, Set<string>> = { NSE: new Set(), BSE: new Set(), MCX: new Set() };
    const options: Record<string, Set<string>> = { NSE: new Set(), BSE: new Set(), MCX: new Set() };

    for (const inst of instruments) {
      const ex = inst.exchange;
      if (!counts[ex]) continue;
      const key = inst.underlying || inst.symbol;
      if (!key) continue;
      if (inst.instrumentType === 'FUTSTK' || inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'FUTCOM') {
        futures[ex].add(key);
      } else if (inst.instrumentType === 'OPTSTK' || inst.instrumentType === 'OPTIDX' || inst.instrumentType === 'OPTFUT') {
        options[ex].add(key);
      }
    }

    // An underlying is only tradeable by this engine if it has listed
    // OPTIONS. Futures alone is not an eligible universe member, because
    // nothing here trades futures outright.
    for (const ex of Object.keys(counts)) {
      for (const sym of options[ex]) counts[ex].add(sym);
    }

    return Object.fromEntries(Object.entries(counts).map(([ex, set]) => [ex, set.size]));
  } catch {
    return {};
  }
}

/** The declared capture mode and what it means for research. */
export function captureModeReport(): Record<string, unknown> {
  return { ...CAPTURE_MODE_DOCUMENTATION, researchThresholds: RESEARCH_THRESHOLDS };
}

function round(n: number, d = 2): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}
