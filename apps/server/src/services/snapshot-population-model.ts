// ============================================================
// SNAPSHOT POPULATION MODEL
// ============================================================
// The vocabulary: what each population means, and the identities that must
// hold between them.
//
// Two conceptual groups, kept apart on purpose:
//
//   SNAPSHOT POPULATIONS count snapshots — a snapshot being one (time,
//   symbol, expiry) group of option legs.
//
//   CAPTURE-RUN POPULATIONS count runs — a run being one recorded attempt
//   to capture a chain.
//
// They were previously listed together, which invited reading
// `successful_capture_run_count` as though it were another slice of the
// snapshot population. It is not. The two happen to be equal today only
// because each successful run currently writes exactly one snapshot; that
// is a property of the capture service, not an identity of the model, and
// it is tested separately rather than assumed.
//
// Pure, and in its own module so a test can ask what
// `pre_lineage_snapshot_count` means, and whether the identities are
// checked, without standing up a database pool.
//
// Nothing here is read by the trading engine.
// ============================================================

/**
 * Definitions for the five SNAPSHOT populations.
 *
 * Every count in this group is a number of snapshots.
 */
export const SNAPSHOT_POPULATION_DEFINITIONS = {
  historical_snapshot_count:
    'SNAPSHOTS. Every option-chain snapshot in scope — one per (time, symbol, expiry) with time <= as_of. The union of pre-lineage and post-lineage.',
  pre_lineage_snapshot_count:
    'SNAPSHOTS. Snapshots written BEFORE the lineage era began, which therefore legitimately carry no capture_run_id. Historically unlinked and never back-filled.',
  post_lineage_snapshot_count:
    'SNAPSHOTS. Snapshots written at or after the lineage era began. Every one of these MUST carry a capture_run_id; one that does not is a data-integrity failure, not pre-lineage history.',
  linked_snapshot_count:
    'SNAPSHOTS. Post-lineage snapshots whose capture_run_id matches an actual capture_runs row. Persisted evidence on both sides.',
  orphan_snapshot_count:
    'SNAPSHOTS. Post-lineage snapshots carrying a capture_run_id that no capture_runs row matches. Must be 0.',
} as const;

/**
 * Definitions for the CAPTURE-RUN populations.
 *
 * Every count in this group is a number of runs, NOT a slice of the
 * snapshot population.
 */
export const CAPTURE_RUN_POPULATION_DEFINITIONS = {
  successful_capture_run_count:
    'CAPTURE RUNS. capture_runs rows with status SUCCESS or PARTIAL whose start is at or after the lineage era began. A count of runs, not of snapshots.',
  runs_before_lineage:
    'CAPTURE RUNS. Successful runs that started before the lineage era. They cannot have a snapshot carrying their id and are excluded from the snapshot invariants.',
} as const;

/** Both groups, for callers that want the whole dictionary. */
export const POPULATION_DEFINITIONS = {
  ...SNAPSHOT_POPULATION_DEFINITIONS,
  ...CAPTURE_RUN_POPULATION_DEFINITIONS,
} as const;

/** The five snapshot populations. */
export interface SnapshotPopulation {
  historical_snapshot_count: number;
  pre_lineage_snapshot_count: number;
  post_lineage_snapshot_count: number;
  linked_snapshot_count: number;
  orphan_snapshot_count: number;
  /** Legs, carried alongside for convenience. Not a population in its own right. */
  historical_leg_count: number;
  pre_lineage_leg_count: number;
  post_lineage_leg_count: number;
}

/** The capture-run populations, kept structurally separate from the snapshot ones. */
export interface CaptureRunPopulation {
  successful_capture_run_count: number;
  runs_before_lineage: number;
}

export interface SymbolPopulation extends SnapshotPopulation, CaptureRunPopulation {
  exchange: string;
  symbol: string;
  expiry: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

/**
 * Snapshots that belong to the lineage era but carry no capture_run_id.
 *
 * This is the failure mode the era-based definition exists to catch. Under
 * the run-id-presence definition alone such a row would be silently filed as
 * pre-lineage history — indistinguishable from a legitimately old snapshot —
 * and the capture service could stop stamping rows without anything noticing.
 */
export interface LineageEraViolation {
  timestamp: string;
  exchange: string;
  symbol: string;
  expiry: string | null;
  legs: number;
  issue: string;
}

/**
 * Rows that could not be attributed to a symbol, an expiry or a run.
 *
 * Counted rather than dropped: a malformed row vanishing from the per-symbol
 * reconciliation while the global count still looks right is exactly the
 * class of error these populations exist to prevent.
 */
export interface UnattributedCounts {
  unattributed_snapshot_count: number;
  unattributed_run_count: number;
  unattributed_symbol_count: number;
  unattributed_expiry_count: number;
}

export interface PopulationReconciliation {
  // ---- snapshot identities ----
  /** historical = pre + post */
  historical_splits_into_pre_and_post: boolean;
  /** post = linked + orphan */
  post_splits_into_linked_and_orphan: boolean;
  /** linked <= post */
  linked_within_post: boolean;
  /** Σ per-symbol historical + unattributed = global historical */
  per_symbol_historical_sums_to_global: boolean;
  /** Σ per-symbol post + unattributed = global post */
  per_symbol_post_sums_to_global: boolean;
  /** Σ per-symbol linked = global linked */
  per_symbol_linked_sums_to_global: boolean;

  // ---- run identities, kept separate from the snapshot ones ----
  /** Σ per-symbol successful runs + unattributed = global successful runs */
  per_symbol_runs_sum_to_global: boolean;

  // ---- integrity invariants ----
  /**
   * No snapshot in the lineage era lacks a capture_run_id. A violation is a
   * data-integrity failure, NOT legitimate pre-lineage history.
   */
  no_post_lineage_null_run_id: boolean;
  /** Nothing failed to attribute to a symbol, expiry or run. */
  no_unattributed_rows: boolean;

  holds: boolean;
  failures: string[];
  detail: string;
}

/**
 * Evaluates every identity and names each failure.
 *
 * Pure so the identity logic can be tested directly against constructed
 * inputs rather than only against whatever the database happens to hold.
 */
export function reconcile(input: {
  global: SnapshotPopulation;
  globalRuns: CaptureRunPopulation;
  perSymbolHistorical: number;
  perSymbolPost: number;
  perSymbolLinked: number;
  perSymbolRuns: number;
  unattributed: UnattributedCounts;
  postLineageNullRunIdCount: number;
}): PopulationReconciliation {
  const { global, globalRuns, unattributed } = input;

  const checks: Record<string, { ok: boolean; message: string }> = {
    historical_splits_into_pre_and_post: {
      ok: global.historical_snapshot_count === global.pre_lineage_snapshot_count + global.post_lineage_snapshot_count,
      message: `historical (${global.historical_snapshot_count}) != pre (${global.pre_lineage_snapshot_count}) + post (${global.post_lineage_snapshot_count})`,
    },
    post_splits_into_linked_and_orphan: {
      ok: global.post_lineage_snapshot_count === global.linked_snapshot_count + global.orphan_snapshot_count,
      message: `post (${global.post_lineage_snapshot_count}) != linked (${global.linked_snapshot_count}) + orphan (${global.orphan_snapshot_count})`,
    },
    linked_within_post: {
      ok: global.linked_snapshot_count <= global.post_lineage_snapshot_count,
      message: `linked (${global.linked_snapshot_count}) exceeds post (${global.post_lineage_snapshot_count})`,
    },
    // Σ attributed + unattributed = global, so a malformed row cannot vanish
    // from the per-symbol view while the global count still looks correct.
    per_symbol_historical_sums_to_global: {
      ok: input.perSymbolHistorical + unattributed.unattributed_snapshot_count === global.historical_snapshot_count,
      message: `Σ per-symbol historical (${input.perSymbolHistorical}) + unattributed (${unattributed.unattributed_snapshot_count}) != global (${global.historical_snapshot_count})`,
    },
    per_symbol_post_sums_to_global: {
      ok: input.perSymbolPost === global.post_lineage_snapshot_count,
      message: `Σ per-symbol post (${input.perSymbolPost}) != global (${global.post_lineage_snapshot_count})`,
    },
    per_symbol_linked_sums_to_global: {
      ok: input.perSymbolLinked === global.linked_snapshot_count,
      message: `Σ per-symbol linked (${input.perSymbolLinked}) != global (${global.linked_snapshot_count})`,
    },
    per_symbol_runs_sum_to_global: {
      ok: input.perSymbolRuns + unattributed.unattributed_run_count === globalRuns.successful_capture_run_count,
      message: `Σ per-symbol runs (${input.perSymbolRuns}) + unattributed (${unattributed.unattributed_run_count}) != global (${globalRuns.successful_capture_run_count})`,
    },
    no_post_lineage_null_run_id: {
      ok: input.postLineageNullRunIdCount === 0,
      message: `DATA-INTEGRITY FAILURE: ${input.postLineageNullRunIdCount} snapshot(s) in the lineage era carry no capture_run_id. These are NOT pre-lineage history — the capture path wrote a row without stamping it.`,
    },
    no_unattributed_rows: {
      ok:
        unattributed.unattributed_snapshot_count === 0 &&
        unattributed.unattributed_run_count === 0 &&
        unattributed.unattributed_symbol_count === 0 &&
        unattributed.unattributed_expiry_count === 0,
      message: `unattributed rows present: ${unattributed.unattributed_snapshot_count} snapshot(s), ${unattributed.unattributed_run_count} run(s), ${unattributed.unattributed_symbol_count} missing symbol, ${unattributed.unattributed_expiry_count} missing expiry`,
    },
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v.ok)
    .map(([k, v]) => `${k}: ${v.message}`);

  return {
    historical_splits_into_pre_and_post: checks.historical_splits_into_pre_and_post.ok,
    post_splits_into_linked_and_orphan: checks.post_splits_into_linked_and_orphan.ok,
    linked_within_post: checks.linked_within_post.ok,
    per_symbol_historical_sums_to_global: checks.per_symbol_historical_sums_to_global.ok,
    per_symbol_post_sums_to_global: checks.per_symbol_post_sums_to_global.ok,
    per_symbol_linked_sums_to_global: checks.per_symbol_linked_sums_to_global.ok,
    per_symbol_runs_sum_to_global: checks.per_symbol_runs_sum_to_global.ok,
    no_post_lineage_null_run_id: checks.no_post_lineage_null_run_id.ok,
    no_unattributed_rows: checks.no_unattributed_rows.ok,
    holds: failures.length === 0,
    failures,
    detail:
      failures.length === 0
        ? 'every identity holds, no lineage-era snapshot lacks a run id, and nothing is unattributed'
        : failures.join(' | '),
  };
}

/**
 * The expiry component of a snapshot or run key, normalised to a date string.
 *
 * A Date from one query and a string from another would otherwise produce two
 * keys for the same chain, which is how a symbol's runs came to be attributed
 * to every one of its expiries.
 */
export function expiryKey(v: string | Date | null | undefined): string {
  if (v == null) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** The key a snapshot and its run must agree on. */
export function attributionKey(exchange: string, symbol: string, expiry: string | Date | null): string {
  return `${exchange}|${symbol}|${expiryKey(expiry)}`;
}
