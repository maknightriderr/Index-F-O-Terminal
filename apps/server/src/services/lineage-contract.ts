// ============================================================
// THE LINEAGE CONTRACT
// ============================================================
// When did stamping a snapshot with its capture_run_id become MANDATORY?
//
// The era used to be derived from the earliest snapshot that actually
// carried a run id. That answers a different question — when did stamping
// first SUCCEED — and the two differ by however long the first failure
// lasted:
//
//   16:48:18  the lineage contract is deployed; stamping is now mandatory
//   16:5x:xx  a snapshot is written with a NULL capture_run_id
//   17:00:55  the first correctly stamped snapshot
//
// Under the derived boundary the middle row looks OLDER than the contract,
// so it was classified as legitimate pre-lineage history and no invariant
// could see it. A boundary that moves to wherever the data happens to start
// cannot detect a gap at its own beginning.
//
// So the boundary is now authoritative: it comes from the deployment that
// activated the contract, is persisted once, and is never recomputed from
// the rows it governs.
//
// THERE IS NO FALLBACK. If the marker is missing, the diagnostics report
// says so and refuses to classify, rather than quietly reverting to the
// inferred value — a boundary that silently degrades to the thing it
// replaced is the same defect wearing the new name.
//
// Nothing here is read by the trading engine.
// ============================================================

import { sql } from '../lib/db.js';

/**
 * The instant the lineage contract became mandatory in production.
 *
 * Source: Railway deployment `809e0f2e-1e27-479b-8329-9d89e3f064e0` of
 * commit `44f12f5` ("Hard capture lineage, explicit validity, model
 * provenance, one report boundary"), created 2026-09-21T16:48:18.960Z. That
 * commit contains BOTH migration 010, which adds `capture_run_id`, and the
 * capture writer that stamps it — so its deployment is the single instant at
 * which an unstamped snapshot stopped being acceptable.
 *
 * This is a compiled constant for the same reason DATA_QUALITY_CUTOVER_AT
 * is: a boundary that moves is not a boundary. It is read from the
 * deployment record, never from the captured rows.
 *
 * It is deliberately the deployment's creation instant rather than an
 * estimate of when the new container began serving. The build window is
 * therefore INSIDE the era, which is the conservative direction: the
 * boundary can surface a row the old code legitimately wrote, and a reader
 * will see it listed, but it cannot hide a row the new code failed to stamp.
 * An over-strict boundary announces itself; an over-lax one does not.
 */
export const LINEAGE_CONTRACT_ACTIVATED_AT = Date.parse('2026-09-21T16:48:18.960Z');

/** The milestone row that carries the boundary. */
export const LINEAGE_CONTRACT_LAYER = 'capture_lineage_cutover_at';

/** Marker authority. Only the first of these may carry an invariant. */
export const MARKER_SOURCES = {
  AUTHORITATIVE: 'authoritative_contract_marker',
  INFERRED: 'inferred_from_rows',
  BOOT_UNVERIFIED: 'boot_time_unverified',
} as const;

export const LINEAGE_CONTRACT_SOURCE_REFERENCE =
  'railway deployment 809e0f2e-1e27-479b-8329-9d89e3f064e0, commit 44f12f5, created 2026-09-21T16:48:18.960Z';

/**
 * What the authoritative marker can and cannot tell us.
  *
 * Railway records when a deployment was CREATED — when its build started —
 * and exposes no go-live instant. The contract is only genuinely in force
 * once the new container serves, which is one build later. Taking the
 * earlier instant is the conservative choice: the boundary can surface a
  * row the OLD code legitimately wrote, but it cannot hide a row the NEW
 * code failed to stamp. An over-strict boundary announces itself; an
 * over-lax one does not.
  *
 * A violation timestamped inside this window is therefore ambiguous — it
 * may be a pre-contract row from the outgoing container. It is still
 * reported as a violation, because exempting it would reintroduce exactly
 * the blind spot this marker exists to close. The window is published so
 * the ambiguity is visible rather than implicit.
  */
export const LINEAGE_ACTIVATION_WINDOW_NOTE =
  'lineage_era_started_at is the deployment CREATION instant — when the build that carried the stamping writer began. Railway exposes no go-live timestamp, so the true activation is one build duration later. An unstamped snapshot timestamped within a few minutes of this instant may have been written by the outgoing container rather than by a stamping failure. It is still counted as a violation: an authoritative-but-early boundary announces its errors, whereas a boundary tuned to make the report green would hide them. Resolve such a case by checking the deployment logs for the container start, not by moving the boundary.';

export const LINEAGE_CONTRACT_DERIVATION =
  'compiled constant LINEAGE_CONTRACT_ACTIVATED_AT — the deployment that made capture_run_id stamping mandatory. NOT derived from the captured rows.';

/**
 * Raised when the boundary cannot be established from an authoritative
 * marker. Deliberately not caught and replaced with a derived value.
 */
export class LineageContractError extends Error {
  readonly contract_error = true;
  constructor(message: string) {
    super(message);
    this.name = 'LineageContractError';
  }
}

export interface LineageEra {
  /** The authoritative activation instant. */
  activatedAt: Date;
  /** Always the authoritative source; anything else raises instead. */
  source: string;
  sourceReference: string;
  derivation: string;
}

/**
 * Reads the boundary from the persisted marker.
 *
 * Reading it back rather than trusting the constant is the point: it proves
 * the activation path actually recorded the marker, instead of every reader
 * assuming the same value at read time. A missing or non-authoritative row
 * raises.
 */
export async function lineageEra(
  tx: { unsafe: typeof sql.unsafe } | null = null
): Promise<LineageEra> {
  const run = tx ?? sql;
  let rows: { recording_started_at: Date; source: string | null; source_reference: string | null; derivation: string | null }[];
  try {
    rows = await run.unsafe(
      `SELECT recording_started_at, source, source_reference, derivation
       FROM research_milestones WHERE layer = $1`,
      [LINEAGE_CONTRACT_LAYER]
    );
  } catch (err: any) {
    throw new LineageContractError(
      `the lineage contract marker could not be read (${err.message}). Snapshot lineage cannot be classified without an authoritative boundary, and this report will NOT fall back to deriving one from the first stamped row.`
    );
  }

  const row = rows[0];
  if (!row) {
    throw new LineageContractError(
      `no lineage contract marker is recorded (research_milestones.layer = '${LINEAGE_CONTRACT_LAYER}'). The boundary is unknown, so every snapshot's pre/post classification is unknown. Refusing to infer one from the earliest stamped row.`
    );
  }
  if (row.source !== MARKER_SOURCES.AUTHORITATIVE) {
    throw new LineageContractError(
      `the lineage contract marker is present but NOT authoritative (source = ${row.source ?? 'null'}, derivation = ${row.derivation ?? 'null'}). A boundary derived from the rows it governs cannot detect a stamping failure at its own beginning, so it may not carry the post-lineage invariant.`
    );
  }

  return {
    activatedAt: new Date(row.recording_started_at),
    source: row.source,
    sourceReference: row.source_reference ?? LINEAGE_CONTRACT_SOURCE_REFERENCE,
    derivation: row.derivation ?? LINEAGE_CONTRACT_DERIVATION,
  };
}
