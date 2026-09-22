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
// Nothing here is read by the trading engine.
// ============================================================

import { sql } from '../lib/db.js';
import {
  SNAPSHOT_POPULATION_DEFINITIONS,
  CAPTURE_RUN_POPULATION_DEFINITIONS,
  attributionKey,
  reconcile,
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
  lineage_era_started_at: string | null;
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

  const empty = { snapshots: [] as SnapshotRow[], runs: [] as RunRow[] };
  const { snapshots, runs } = await sql
    .begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
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
      return { snapshots: snapshotRows, runs: runRows };
    })
    .catch(() => empty);

  const runIds = new Set(runs.map((r) => r.id));

  // The lineage era begins at the earliest snapshot actually carrying a run
  // id. Derived from the rows, because a run that ran before the column
  // existed cannot have a linked snapshot.
  const linkedTimes = snapshots.filter((s) => s.run_id != null).map((s) => new Date(s.time).getTime());
  const eraStart = linkedTimes.length > 0 ? Math.min(...linkedTimes) : null;

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

    const at = new Date(s.time).getTime();
    const insideEra = eraStart != null && at >= eraStart;

    if (s.run_id == null) {
      if (insideEra) {
        // THE INVARIANT. A row inside the lineage era with no run id is a
        // capture-path failure, not history. Filing it as pre-lineage would
        // make it indistinguishable from a legitimately old snapshot.
        violations.push({
          timestamp: new Date(s.time).toISOString(),
          exchange: s.exchange,
          symbol: s.symbol,
          expiry: s.expiry,
          legs,
          issue:
            'snapshot written at or after lineage_era_started_at but carries no capture_run_id — the capture path wrote a row without stamping it',
        });
        // Counted post-lineage BY ERA so the violation cannot hide inside the
        // pre-lineage count. It is neither linked nor orphan — it has no id
        // to match or fail to match — so `post = linked + orphan` also fails,
        // which is the intended loud second signal.
        global.post_lineage_snapshot_count++;
        global.post_lineage_leg_count += legs;
        entry.post_lineage_snapshot_count++;
        entry.post_lineage_leg_count += legs;
        continue;
      }
      global.pre_lineage_snapshot_count++;
      global.pre_lineage_leg_count += legs;
      entry.pre_lineage_snapshot_count++;
      entry.pre_lineage_leg_count += legs;
      continue;
    }

    global.post_lineage_snapshot_count++;
    global.post_lineage_leg_count += legs;
    entry.post_lineage_snapshot_count++;
    entry.post_lineage_leg_count += legs;

    if (runIds.has(s.run_id)) {
      global.linked_snapshot_count++;
      entry.linked_snapshot_count++;
      snapshotsPerRun.set(s.run_id, (snapshotsPerRun.get(s.run_id) ?? 0) + 1);
    } else {
      global.orphan_snapshot_count++;
      entry.orphan_snapshot_count++;
    }
  }

  // ---- Capture-run populations. Runs, not snapshots. ----
  const successfulAll = runs.filter((r) => r.status === 'SUCCESS' || r.status === 'PARTIAL');
  const successfulInEra = successfulAll.filter((r) => eraStart != null && new Date(r.time).getTime() >= eraStart);
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
    lineage_era_started_at: eraStart == null ? null : new Date(eraStart).toISOString(),
    snapshots: global,
    runs: globalRuns,
    bySymbol,
    unattributed,
    post_lineage_null_run_id_count: violations.length,
    lineageEraViolations: violations,
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
