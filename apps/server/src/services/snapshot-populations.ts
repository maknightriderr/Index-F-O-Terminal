// ============================================================
// SNAPSHOT POPULATIONS
// ============================================================
// One query, one boundary, computed ONCE per report and handed to every
// consumer.
//
// WHY THIS EXISTS
//
// A previous report put per-symbol snapshot counts (summing to 41, the TOTAL
// population, read at 17:01) in the same table as a post-lineage count (24,
// read at 19:21). Two populations and two instants presented as one figure.
//
// The first fix gave both consumers the same function and the same `as_of`.
// That was still two independent calculations against a live table: two
// queries milliseconds apart can observe different data, and "same as_of"
// only proved they asked the same question, not that they got the same
// answer. Now the calculation runs once and its immutable result is passed
// to both consumers.
//
// THE LINEAGE-ERA INVARIANT
//
// Membership in the post-lineage population is decided by the persisted
// capture_run_id. That alone cannot catch the failure where the capture path
// writes a row in the lineage era WITHOUT stamping it: such a row would be
// filed as pre-lineage history, indistinguishable from a legitimately old
// snapshot, and the capture service could stop stamping without anything
// noticing. So the era is tracked by time as well, and a snapshot inside it
// carrying no run id is surfaced as a data-integrity failure.
//
// WHERE THE ERA BOUNDARY COMES FROM
//
// It used to be the earliest snapshot that actually carried a run id, which
// answers when stamping first SUCCEEDED rather than when it became
// MANDATORY. A boundary derived from the first surviving row cannot detect a
// failure before it, because the failure just moves the boundary. It is now
// read from an authoritative persisted marker — the deployment that
// activated the contract — and there is NO fallback: if the marker is
// missing, this refuses to classify rather than quietly reverting.
//
// Nothing here is read by the trading engine.
// ============================================================

import { sql } from '../lib/db.js';
import { lineageEra, LineageContractError, type LineageEra } from './lineage-contract.js';
import {
  SNAPSHOT_POPULATION_DEFINITIONS,
  CAPTURE_RUN_POPULATION_DEFINITIONS,
  attributionKey,
  reconcile,
  classifySnapshot,
  type SnapshotPopulation,
  type CaptureRunPopulation,
  type SymbolPopulation,
  type PopulationReconciliation,
  type LineageEraViolation,
  type UnattributedCounts,
} from './snapshot-population-model.js';

export {
  SNAPSHOT_POPULATION_DEFINITIONS,
  CAPTURE_RUN_POPULATION_DEFINITIONS,
  POPULATION_DEFINITIONS,
  attributionKey,
  expiryKey,
} from './snapshot-population-model.js';
export type {
  SnapshotPopulation,
  CaptureRunPopulation,
  SymbolPopulation,
  PopulationReconciliation,
  LineageEraViolation,
  UnattributedCounts,
} from './snapshot-population-model.js';

interface SnapshotRow {
  exchange: string | null;
  symbol: string | null;
  expiry: string | null;
  run_id: string | null;
  legs: string;
  time: Date;
}

interface RunRow {
  id: string;
  time: Date;
  status: string;
  symbol: string | null;
  exchange: string | null;
  expiry: string | null;
}

export interface PopulationResult {
  as_of: string;
  snapshot_population_definitions: typeof SNAPSHOT_POPULATION_DEFINITIONS;
  capture_run_population_definitions: typeof CAPTURE_RUN_POPULATION_DEFINITIONS;
  lineage_era_started_at: string;
  /** Always 'authoritative_contract_marker'; anything else raises instead. */
  lineage_era_source: string;
  lineage_era_source_reference: string;
  lineage_era_derivation: string;
  /** The five SNAPSHOT populations. */
  snapshots: SnapshotPopulation;
  /** The CAPTURE-RUN populations. A count of runs, not a slice of the snapshots. */
  runs: CaptureRunPopulation;
  bySymbol: SymbolPopulation[];
  unattributed: UnattributedCounts;
  /** Snapshots inside the lineage era with no run id. Must be 0. */
  post_lineage_null_run_id_count: number;
  lineageEraViolations: LineageEraViolation[];
  /**
   * Snapshots BEFORE the contract carrying a run id anyway.
   *
   * Should be impossible — the column did not exist — so this is an
   * anomaly counter rather than a population. Such a row stays pre-lineage
   * (a pre-contract row is never linked, per the historical-safety rule)
   * and is surfaced here instead of being quietly promoted.
   */
  pre_lineage_stamped_count: number;
  /**
   * Whether each successful run in the era wrote exactly one snapshot.
   *
   * NOT assumed from the two counts happening to be equal. If the capture
   * contract guarantees one run to one (symbol, expiry) snapshot, this is
   * where that guarantee is measured rather than inferred.
   */
  runToSnapshotRelationship: {
    runs_with_exactly_one_snapshot: number;
    runs_with_no_snapshot: number;
    runs_with_multiple_snapshots: number;
    one_run_one_snapshot_holds: boolean;
    note: string;
  };
  reconciliation: PopulationReconciliation;
}

/**
 * How many times the calculation has run.
 *
 * Exposed so a test can assert that one diagnostics request performs exactly
 * one calculation rather than one per consumer — the requirement being
 * 1 as_of, 1 calculation, 1 result, N consumers.
 */
let invocationCount = 0;
export function populationInvocationCount(): number {
  return invocationCount;
}
export function resetPopulationInvocationCount(): void {
  invocationCount = 0;
}

/**
 * Computes every population once, from one consistent read.
 *
 * Both reads run inside a single REPEATABLE READ transaction so the snapshot
 * table and the run table cannot be observed at different points in time.
 * Sharing an `as_of` is not by itself a guarantee that two queries saw the
 * same data.
 */
export async function getSnapshotPopulations(asOf: Date): Promise<PopulationResult> {
  invocationCount++;

  // The era marker is read inside the SAME transaction as the rows it
  // classifies, so the boundary and the data are one consistent observation.
  let era: LineageEra;
  let snapshots: SnapshotRow[];
  let runs: RunRow[];
  try {
    const read = await sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      const marker = await lineageEra(tx as unknown as { unsafe: typeof sql.unsafe });
      const snapshotRows = await tx<SnapshotRow[]>`
        SELECT exchange, symbol, expiry, time,
               MAX(capture_run_id::text) AS run_id,
               COUNT(*) AS legs
        FROM oi_snapshots
        WHERE time <= ${asOf}
        GROUP BY exchange, symbol, expiry, time
        ORDER BY time ASC
      `;
      const runRows = await tx<RunRow[]>`
        SELECT id::text AS id, COALESCE(capture_started_at, time) AS time, status,
               symbol, exchange, expiry
        FROM capture_runs
        WHERE COALESCE(capture_started_at, time) <= ${asOf}
      `;
      return { marker, snapshots: snapshotRows, runs: runRows };
    });
    era = read.marker;
    snapshots = read.snapshots;
    runs = read.runs;
  } catch (err) {
    // A missing or non-authoritative boundary is NOT degraded into an
    // inferred one. It is the caller's problem to report, because a report
    // that silently reverts to the derived boundary is the original defect
    // wearing the new name.
    if (err instanceof LineageContractError) throw err;
    throw new LineageContractError(
      `the population read failed (${(err as Error).message}). No population is reported rather than a partial one, because a partial read produces denominators that look complete.`
    );
  }

  const eraStart = era.activatedAt.getTime();

  const runIds = new Set(runs.map((r) => r.id));

  const blankSnapshots = (): SnapshotPopulation => ({
    historical_snapshot_count: 0,
    pre_lineage_snapshot_count: 0,
    post_lineage_snapshot_count: 0,
    linked_snapshot_count: 0,
    orphan_snapshot_count: 0,
    historical_leg_count: 0,
    pre_lineage_leg_count: 0,
    post_lineage_leg_count: 0,
  });

  const global = blankSnapshots();
  const globalRuns: CaptureRunPopulation = { successful_capture_run_count: 0, runs_before_lineage: 0 };
  const bySymbolMap = new Map<string, SymbolPopulation>();
  const violations: LineageEraViolation[] = [];
  const snapshotsPerRun = new Map<string, number>();
  let preLineageStamped = 0;

  const unattributed: UnattributedCounts = {
    unattributed_snapshot_count: 0,
    unattributed_run_count: 0,
    unattributed_symbol_count: 0,
    unattributed_expiry_count: 0,
  };

  for (const s of snapshots) {
    const legs = Number(s.legs);
    global.historical_snapshot_count++;
    global.historical_leg_count += legs;

    // A row missing its mandatory identity is counted, never dropped. Without
    // this it would vanish from the per-symbol view while the global count
    // still looked correct.
    if (s.exchange == null || s.symbol == null) {
      unattributed.unattributed_snapshot_count++;
      if (s.symbol == null) unattributed.unattributed_symbol_count++;
      if (s.expiry == null) unattributed.unattributed_expiry_count++;
      continue;
    }

    const key = attributionKey(s.exchange, s.symbol, s.expiry);
    let entry = bySymbolMap.get(key);
    if (!entry) {
      entry = {
        ...blankSnapshots(),
        successful_capture_run_count: 0,
        runs_before_lineage: 0,
        exchange: s.exchange,
        symbol: s.symbol,
        expiry: s.expiry,
        first_seen: new Date(s.time).toISOString(),
        last_seen: new Date(s.time).toISOString(),
      };
      bySymbolMap.set(key, entry);
    }
    entry.last_seen = new Date(s.time).toISOString();
    entry.historical_snapshot_count++;
    entry.historical_leg_count += legs;

    // Classification is by TIME against the authoritative contract boundary,
    // for every row. Presence of a run id decides linked-vs-orphan WITHIN
    // the post-lineage population; it no longer decides which population a
    // row belongs to, which is what let an unstamped row hide in history.
    //
    // The rule itself lives in the pure model, where each case can be
    // exercised directly instead of inferred from the shape of this loop.
    const verdict = classifySnapshot({
      at: new Date(s.time).getTime(),
      eraStart,
      runId: s.run_id,
      runExists: s.run_id != null && runIds.has(s.run_id),
    });

    if (verdict.counts_as === 'pre_lineage') {
      global.pre_lineage_snapshot_count++;
      global.pre_lineage_leg_count += legs;
      entry.pre_lineage_snapshot_count++;
      entry.pre_lineage_leg_count += legs;
      if (verdict.population === 'PRE_LINEAGE_STAMPED') preLineageStamped++;
      continue;
    }

    // Counted post-lineage BY ERA, so a violation cannot hide inside the
    // pre-lineage count. A violation is neither linked nor orphan — it has
    // no id to match or fail to match — so `post = linked + orphan` fails
    // too, which is the intended loud second signal.
    global.post_lineage_snapshot_count++;
    global.post_lineage_leg_count += legs;
    entry.post_lineage_snapshot_count++;
    entry.post_lineage_leg_count += legs;

    if (verdict.population === 'POST_LINEAGE_VIOLATION') {
      violations.push({
        timestamp: new Date(s.time).toISOString(),
        exchange: s.exchange,
        symbol: s.symbol,
        expiry: s.expiry,
        legs,
        issue: verdict.reason,
      });
      continue;
    }

    if (verdict.population === 'POST_LINEAGE_LINKED') {
      global.linked_snapshot_count++;
      entry.linked_snapshot_count++;
      snapshotsPerRun.set(s.run_id!, (snapshotsPerRun.get(s.run_id!) ?? 0) + 1);
    } else {
      global.orphan_snapshot_count++;
      entry.orphan_snapshot_count++;
    }
  }

  // ---- Capture-run populations. Runs, not snapshots. ----
  const successfulAll = runs.filter((r) => r.status === 'SUCCESS' || r.status === 'PARTIAL');
  const successfulInEra = successfulAll.filter((r) => new Date(r.time).getTime() >= eraStart);
  globalRuns.successful_capture_run_count = successfulInEra.length;
  globalRuns.runs_before_lineage = successfulAll.length - successfulInEra.length;

  for (const r of successfulInEra) {
    if (r.exchange == null || r.symbol == null) {
      unattributed.unattributed_run_count++;
      continue;
    }
    // Keyed by expiry as well as symbol: one run captures one chain for one
    // expiry, so a symbol with two expiries must not have its runs counted
    // against both.
    const entry = bySymbolMap.get(attributionKey(r.exchange, r.symbol, r.expiry));
    if (entry) entry.successful_capture_run_count++;
    else unattributed.unattributed_run_count++;
  }

  // ---- Run-to-snapshot relationship, measured rather than assumed ----
  let exactlyOne = 0;
  let none = 0;
  let multiple = 0;
  for (const r of successfulInEra) {
    const n = snapshotsPerRun.get(r.id) ?? 0;
    if (n === 1) exactlyOne++;
    else if (n === 0) none++;
    else multiple++;
  }

  const bySymbol = [...bySymbolMap.values()].sort(
    (a, b) => b.historical_snapshot_count - a.historical_snapshot_count
  );

  const reconciliation = reconcile({
    global,
    globalRuns,
    perSymbolHistorical: bySymbol.reduce((a, s) => a + s.historical_snapshot_count, 0),
    perSymbolPost: bySymbol.reduce((a, s) => a + s.post_lineage_snapshot_count, 0),
    perSymbolLinked: bySymbol.reduce((a, s) => a + s.linked_snapshot_count, 0),
    perSymbolRuns: bySymbol.reduce((a, s) => a + s.successful_capture_run_count, 0),
    unattributed,
    postLineageNullRunIdCount: violations.length,
  });

  return {
    as_of: asOf.toISOString(),
    snapshot_population_definitions: SNAPSHOT_POPULATION_DEFINITIONS,
    capture_run_population_definitions: CAPTURE_RUN_POPULATION_DEFINITIONS,
    lineage_era_started_at: era.activatedAt.toISOString(),
    lineage_era_source: era.source,
    lineage_era_source_reference: era.sourceReference,
    lineage_era_derivation: era.derivation,
    snapshots: global,
    runs: globalRuns,
    bySymbol,
    unattributed,
    post_lineage_null_run_id_count: violations.length,
    lineageEraViolations: violations,
    pre_lineage_stamped_count: preLineageStamped,
    runToSnapshotRelationship: {
      runs_with_exactly_one_snapshot: exactlyOne,
      runs_with_no_snapshot: none,
      runs_with_multiple_snapshots: multiple,
      one_run_one_snapshot_holds: none === 0 && multiple === 0,
      note:
        'Measured, not inferred from successful_capture_run_count happening to equal linked_snapshot_count. Those are a run count and a snapshot count; their equality is a property of the current capture service, not an identity of this model.',
    },
    reconciliation,
  };
}
