// ============================================================
// SNAPSHOT POPULATION MODEL
// ============================================================
// The vocabulary: what each snapshot population means, and the identities
// that must hold between them.
//
// Pure, and in its own module for the same reason the outcome, stop and
// contract classifiers are — a test should be able to ask what
// `pre_lineage_snapshot_count` means, and whether the reconciliation
// identities are checked, without standing up a database pool.
//
// Nothing here is read by the trading engine.
// ============================================================

/**
 * What each count means. Written beside the query that produces it so a
 * definition and its number cannot separate.
 */
export const POPULATION_DEFINITIONS = {
  historical_snapshot_count:
    'Every option-chain snapshot in scope — one per (time, symbol, expiry) with time <= as_of. The union of pre-lineage and post-lineage.',
  pre_lineage_snapshot_count:
    'Snapshots carrying NO capture_run_id, because they were written before the lineage column existed. Historically unlinked and never back-filled.',
  post_lineage_snapshot_count:
    'Snapshots carrying a capture_run_id. Membership is decided by the persisted column on the row, not by comparing its timestamp to a cutover.',
  linked_snapshot_count:
    'Post-lineage snapshots whose capture_run_id matches an actual capture_runs row. Persisted evidence on both sides.',
  orphan_snapshot_count:
    'Post-lineage snapshots carrying a capture_run_id that no capture_runs row matches. Must be 0.',
  successful_capture_run_count:
    'capture_runs rows with status SUCCESS or PARTIAL whose start is at or after the lineage era began. Runs predating the lineage column are excluded and counted separately.',
} as const;

export interface SnapshotPopulation {
  historical_snapshot_count: number;
  pre_lineage_snapshot_count: number;
  post_lineage_snapshot_count: number;
  linked_snapshot_count: number;
  orphan_snapshot_count: number;
  successful_capture_run_count: number;
  historical_leg_count: number;
  pre_lineage_leg_count: number;
  post_lineage_leg_count: number;
}

export interface SymbolPopulation extends SnapshotPopulation {
  exchange: string;
  symbol: string;
  expiry: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface PopulationReconciliation {
  /** historical = pre + post */
  historical_splits_into_pre_and_post: boolean;
  /** post = linked + orphan */
  post_splits_into_linked_and_orphan: boolean;
  /** linked <= post */
  linked_within_post: boolean;
  /** Σ per-symbol post == global post */
  per_symbol_post_sums_to_global: boolean;
  /** Σ per-symbol linked == global linked */
  per_symbol_linked_sums_to_global: boolean;
  /** Σ per-symbol historical == global historical */
  per_symbol_historical_sums_to_global: boolean;
  /**
   * Σ per-symbol successful runs == global successful runs.
   *
   * Added after this identity's absence let a real bug through: runs were
   * grouped by symbol alone and attributed to every expiry row that symbol
   * had, so a two-expiry instrument double-counted. The identity that is not
   * asserted is the one that breaks.
   */
  per_symbol_runs_sum_to_global: boolean;
  holds: boolean;
  detail: string;
}

