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
 * RUNTIME ACTIVATION, from the deployment's own startup log.
 *
 * Railway deployment `809e0f2e-1e27-479b-8329-9d89e3f064e0` carries commit
 * `44f12f5`, which contains BOTH migration 010, adding `capture_run_id`,
 * and the capture writer that stamps it. Its runtime log records:
 *
 *   Starting Container
 *   > node dist/index.js
 *   [INFO] F&O Terminal Server started   time=1790009429706
 *   [INFO] Capture schema ready          time=1790009429830  applied=96
 *   [INFO] Market state capture started  time=1790009429831
 *
 * The `time=` values are the application's own clock, not Railway's log
 * ingestion timestamps (which arrive batched and identical). The third line
 * is the moment the lineage-aware capture writer began running, one
 * millisecond after the schema check confirmed migration 010 applied. That
 * is the instant an unstamped snapshot stopped being acceptable.
 *
 * This REPLACES the deployment CREATION instant (2026-09-21T16:48:18.960Z),
 * which was the conservative stand-in used while no runtime evidence had
 * been read. Creation is when the build started; it preceded activation by
 * 130.871s, and every row written in that window belonged to the outgoing
 * container. Labelling build-start as activation would have been wrong in
 * the safe direction, but still wrong.
 *
 * It remains a compiled constant, and is still never derived from the rows
 * it governs: a boundary that moves is not a boundary.
 */
export const LINEAGE_CONTRACT_ACTIVATED_AT = Date.parse('2026-09-21T16:50:29.831Z');

/** The milestone row that carries the boundary. */
export const LINEAGE_CONTRACT_LAYER = 'capture_lineage_cutover_at';

/**
 * Marker authority, strongest first. Only a source in AUTHORITATIVE_SOURCES
 * may carry an invariant.
 */
export const MARKER_SOURCES = {
  /** The deployment's own runtime log proving the new writer was running. */
  RUNTIME_ACTIVATION: 'railway_runtime_activation',
  /** A compiled constant tied to the deploy that changed a write contract. */
  AUTHORITATIVE: 'authoritative_contract_marker',
  /**
   * Deployment CREATION — when the build started, not when the code ran.
   * Earlier than true activation by one build. Retained as an honest label
   * for a boundary that has no runtime evidence behind it; it must never be
   * described as runtime activation.
   */
  DEPLOYMENT_CREATION: 'deployment_creation_conservative',
  /** The earliest row carrying the field. Describes success, not activation. */
  INFERRED: 'inferred_from_rows',
  /** Written when a process started, by the recorder that predates 012. */
  BOOT_UNVERIFIED: 'boot_time_unverified',
} as const;

/**
 * The sources permitted to carry the post-lineage invariant.
 *
 * DEPLOYMENT_CREATION is deliberately absent even though it is conservative:
 * it is not activation, and a boundary allowed to claim authority it does
 * not have is how the derived boundary went unquestioned for so long.
 */
export const AUTHORITATIVE_SOURCES: readonly string[] = [
  MARKER_SOURCES.RUNTIME_ACTIVATION,
  MARKER_SOURCES.AUTHORITATIVE,
];

export const LINEAGE_CONTRACT_SOURCE_REFERENCE =
  'railway deployment 809e0f2e-1e27-479b-8329-9d89e3f064e0 (commit 44f12f5) runtime log: "Market state capture started" time=1790009429831, one millisecond after "Capture schema ready" applied=96 confirmed migration 010. Application clock, not log-ingestion time.';

/**
 * Whether the boundary rests on runtime evidence or on a stand-in.
 *
 * It now rests on runtime evidence, so there is no activation window left
 * to caveat: the boundary IS the instant the writer started. The field
 * stays in the response because a reader should be able to see that the
 * question was asked and answered, rather than inferring it from silence.
 */
export const LINEAGE_ACTIVATION_EVIDENCE_NOTE =
  'lineage_era_started_at is the RUNTIME ACTIVATION instant, read from the deployment log line "Market state capture started" — the moment the lineage-aware writer began running, one millisecond after the schema check confirmed migration 010. It is not the deployment creation instant, which preceded it by 130.871s while the build ran and the outgoing container was still serving. Rows written in that build window belong to the previous code and are pre-lineage history, not stamping failures.';

/** True only while the boundary has no runtime evidence behind it. */
export const RUNTIME_ACTIVATION_TIMESTAMP_UNVERIFIED = false;

export const LINEAGE_CONTRACT_DERIVATION =
  'compiled constant LINEAGE_CONTRACT_ACTIVATED_AT — the runtime instant the lineage-aware capture writer began running, from the deployment startup log. NOT derived from the captured rows, and NOT the deployment creation time.';

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
  if (!AUTHORITATIVE_SOURCES.includes(row.source ?? '')) {
    throw new LineageContractError(
      `the lineage contract marker is present but NOT authoritative (source = ${row.source ?? 'null'}, derivation = ${row.derivation ?? 'null'}). Only ${AUTHORITATIVE_SOURCES.join(' or ')} may carry the post-lineage invariant: a boundary derived from the rows it governs cannot detect a stamping failure at its own beginning, and a deployment-creation stand-in is not activation.`
    );
  }

  return {
    activatedAt: new Date(row.recording_started_at),
    // Narrowed by the AUTHORITATIVE_SOURCES check above, which rejects null.
    source: row.source as string,
    sourceReference: row.source_reference ?? LINEAGE_CONTRACT_SOURCE_REFERENCE,
    derivation: row.derivation ?? LINEAGE_CONTRACT_DERIVATION,
  };
}
