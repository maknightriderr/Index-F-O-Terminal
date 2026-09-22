// ============================================================
// SNAPSHOT POPULATIONS
// ============================================================
// One query, one boundary, six explicitly named populations — used by BOTH
// the lineage section and the universe section so the two cannot diverge.
//
// WHY THIS EXISTS
//
// The previous report put "CRUDEOIL 13, NATURALGAS 13, GOLD 9, SILVER 6"
// (summing to 41) in the same table as "All instruments, post-lineage: 24".
// Two things were wrong at once:
//
//   The 41 was the TOTAL snapshot count — every snapshot ever written. The
//   24 was the POST-LINEAGE count. Different populations, presented as one.
//
//   The 41 was read at 17:01 and the 24 at 19:21. Different instants too.
//   Between them 23 more post-lineage snapshots were captured.
//
// A `Snapshots` column whose population is ambiguous is how both happened.
// Every field below names its population, and the lineage and universe
// sections are computed from this one function rather than from two queries
// that can drift apart.
//
// Nothing here is read by the trading engine.
// ============================================================

import { sql } from '../lib/db.js';
import {
  POPULATION_DEFINITIONS,
  type SnapshotPopulation,
  type SymbolPopulation,
  type PopulationReconciliation,
} from './snapshot-population-model.js';

export { POPULATION_DEFINITIONS } from './snapshot-population-model.js';
export type {
  SnapshotPopulation,
  SymbolPopulation,
  PopulationReconciliation,
} from './snapshot-population-model.js';

interface SnapshotRow {
  exchange: string;
  symbol: string;
  expiry: string | null;
  run_id: string | null;
  legs: string;
  time: Date;
}

/**
 * Every population, global and per symbol, from one pass over one boundary.
 *
 * The lineage and universe sections both consume this. Neither runs its own
 * snapshot query, which is the structural reason they can no longer report
 * different denominators for the same thing.
 */
export async function snapshotPopulations(asOf: Date): Promise<{
  as_of: string;
  population_definitions: typeof POPULATION_DEFINITIONS;
  lineage_era_started_at: string | null;
  global: SnapshotPopulation;
  bySymbol: SymbolPopulation[];
  runs_before_lineage: number;
  reconciliation: PopulationReconciliation;
}> {
  // One row per snapshot: a (time, symbol, expiry) group, with the run id
  // carried on the rows themselves.
  const snapshots = await sql<SnapshotRow[]>`
    SELECT exchange, symbol, expiry, time,
           MAX(capture_run_id::text) AS run_id,
           COUNT(*) AS legs
    FROM oi_snapshots
    WHERE time <= ${asOf}
    GROUP BY exchange, symbol, expiry, time
    ORDER BY time ASC
  `.catch(() => []);

  const runs = await sql<{ id: string; time: Date; status: string }[]>`
    SELECT id::text AS id, COALESCE(capture_started_at, time) AS time, status
    FROM capture_runs
    WHERE COALESCE(capture_started_at, time) <= ${asOf}
  `.catch(() => []);

  const runIds = new Set(runs.map((r) => r.id));

  // The lineage era begins at the earliest snapshot actually carrying a run
  // id. Derived from the rows, because a run that ran before the column
  // existed cannot have a linked snapshot and must not be judged as though
  // it could.
  const linkedTimes = snapshots.filter((s) => s.run_id != null).map((s) => new Date(s.time).getTime());
  const eraStart = linkedTimes.length > 0 ? Math.min(...linkedTimes) : null;

  // The expiry component of a symbol's key, normalised to a date string so a
  // Date from one query and a string from another cannot produce two keys for
  // the same chain.
  const expiryKeyOf = (v: string | Date | null): string =>
    v == null ? '' : new Date(v).toISOString().slice(0, 10);

  const blank = (): SnapshotPopulation => ({
    historical_snapshot_count: 0,
    pre_lineage_snapshot_count: 0,
    post_lineage_snapshot_count: 0,
    linked_snapshot_count: 0,
    orphan_snapshot_count: 0,
    successful_capture_run_count: 0,
    historical_leg_count: 0,
    pre_lineage_leg_count: 0,
    post_lineage_leg_count: 0,
  });

  const global = blank();
  const bySymbolMap = new Map<string, SymbolPopulation>();

  for (const s of snapshots) {
    const legs = Number(s.legs);
    const key = `${s.exchange}|${s.symbol}|${expiryKeyOf(s.expiry)}`;
    let entry = bySymbolMap.get(key);
    if (!entry) {
      entry = {
        ...blank(),
        exchange: s.exchange,
        symbol: s.symbol,
        expiry: s.expiry,
        first_seen: new Date(s.time).toISOString(),
        last_seen: new Date(s.time).toISOString(),
      };
      bySymbolMap.set(key, entry);
    }
    entry.last_seen = new Date(s.time).toISOString();

    for (const bucket of [global, entry]) {
      bucket.historical_snapshot_count++;
      bucket.historical_leg_count += legs;
    }

    // Membership is decided by the PERSISTED column, never by a timestamp
    // comparison. A snapshot with no run id is historically unlinked, full
    // stop — it does not become linked because a later snapshot of the same
    // instrument has a run.
    if (s.run_id == null) {
      for (const bucket of [global, entry]) {
        bucket.pre_lineage_snapshot_count++;
        bucket.pre_lineage_leg_count += legs;
      }
      continue;
    }

    for (const bucket of [global, entry]) {
      bucket.post_lineage_snapshot_count++;
      bucket.post_lineage_leg_count += legs;
      if (runIds.has(s.run_id)) bucket.linked_snapshot_count++;
      else bucket.orphan_snapshot_count++;
    }
  }

  // Successful runs, scoped to the lineage era and attributed per symbol.
  const successfulInEra = runs.filter(
    (r) => (r.status === 'SUCCESS' || r.status === 'PARTIAL') && eraStart != null && new Date(r.time).getTime() >= eraStart
  );
  global.successful_capture_run_count = successfulInEra.length;

  // Grouped by (exchange, symbol, EXPIRY) to match how bySymbolMap is keyed.
  //
  // Grouping by symbol alone attributed a symbol's whole run count to EVERY
  // expiry row it had. FINNIFTY carries two expiries, so its 25 runs were
  // counted twice and the per-symbol total came to 891 against a global 866.
  // The expiry is part of a capture's identity — one run captures one chain
  // for one expiry — so it has to be part of the join key.
  const runsBySymbol = await sql<{ symbol: string; exchange: string; expiry: string | null; n: string }[]>`
    SELECT symbol, exchange, expiry, COUNT(*) AS n
    FROM capture_runs
    WHERE COALESCE(capture_started_at, time) <= ${asOf}
      AND status IN ('SUCCESS', 'PARTIAL')
      ${eraStart != null ? sql`AND COALESCE(capture_started_at, time) >= ${new Date(eraStart)}` : sql`AND FALSE`}
    GROUP BY symbol, exchange, expiry
  `.catch(() => []);

  const expiryKey = (v: string | Date | null): string => (v == null ? '' : new Date(v).toISOString().slice(0, 10));
  for (const r of runsBySymbol) {
    const entry = bySymbolMap.get(`${r.exchange}|${r.symbol}|${expiryKey(r.expiry)}`);
    if (entry) entry.successful_capture_run_count += Number(r.n);
  }

  const runsBeforeLineage =
    runs.filter(
      (r) =>
        (r.status === 'SUCCESS' || r.status === 'PARTIAL') &&
        (eraStart == null || new Date(r.time).getTime() < eraStart)
    ).length;

  const bySymbol = [...bySymbolMap.values()].sort(
    (a, b) => b.historical_snapshot_count - a.historical_snapshot_count
  );

  // Reconciliation. These identities hold by construction; asserting them
  // here means a future refactor that breaks one is visible in the payload
  // rather than in a report six weeks later.
  const sumPost = bySymbol.reduce((a, s) => a + s.post_lineage_snapshot_count, 0);
  const sumLinked = bySymbol.reduce((a, s) => a + s.linked_snapshot_count, 0);
  const sumHistorical = bySymbol.reduce((a, s) => a + s.historical_snapshot_count, 0);
  // The identity that was missing, and that let a double-attributed run count
  // through: per-symbol successful runs must sum to the global figure.
  const sumRuns = bySymbol.reduce((a, s) => a + s.successful_capture_run_count, 0);

  const checks = {
    historical_splits_into_pre_and_post:
      global.historical_snapshot_count === global.pre_lineage_snapshot_count + global.post_lineage_snapshot_count,
    post_splits_into_linked_and_orphan:
      global.post_lineage_snapshot_count === global.linked_snapshot_count + global.orphan_snapshot_count,
    linked_within_post: global.linked_snapshot_count <= global.post_lineage_snapshot_count,
    per_symbol_post_sums_to_global: sumPost === global.post_lineage_snapshot_count,
    per_symbol_linked_sums_to_global: sumLinked === global.linked_snapshot_count,
    per_symbol_historical_sums_to_global: sumHistorical === global.historical_snapshot_count,
    per_symbol_runs_sum_to_global: sumRuns === global.successful_capture_run_count,
  };
  const holds = Object.values(checks).every(Boolean);

  return {
    as_of: asOf.toISOString(),
    population_definitions: POPULATION_DEFINITIONS,
    lineage_era_started_at: eraStart == null ? null : new Date(eraStart).toISOString(),
    global,
    bySymbol,
    runs_before_lineage: runsBeforeLineage,
    reconciliation: {
      ...checks,
      holds,
      detail: holds
        ? 'every identity holds: historical = pre + post, post = linked + orphan, linked <= post, and the per-symbol totals sum to the global ones'
        : `MISMATCH: ${Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(', ')}`,
    },
  };
}
