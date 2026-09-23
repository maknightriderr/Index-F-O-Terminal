// ============================================================
// CAPTURE SCHEMA, ENSURED AT BOOT
// ============================================================
// The production start command is `node dist/index.js`. Nothing runs
// database/init/*.sql on deploy — those files are applied automatically
// only by the local Docker image's entrypoint, and otherwise by the
// db:migrate script that somebody has to remember to run.
//
// That was survivable while the schema was stable. It is not survivable
// now: the capture writers insert into tables and columns that 006 creates,
// and every one of those inserts is deliberately fire-and-forget. Without
// this, a deploy would come up healthy, log nothing alarming, and quietly
// write no history at all — the exact failure the capture work exists to
// end, reproduced in a new way.
//
// So the capture schema is ensured at boot, from the same file the
// migration runner uses, so the two can never drift apart. Every statement
// in 006 is idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
// EXISTS, CREATE INDEX IF NOT EXISTS), which is what makes running it on
// every boot safe rather than merely tolerable.
//
// It is best-effort by design. A server that cannot add a capture column
// should still trade — capture is instrumentation, and instrumentation must
// never be able to keep the engine down. What it must not do is fail
// silently, so a failure here is logged loudly and reported by the capture
// coverage endpoint.
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from '../lib/db.js';
import { DATA_QUALITY_CUTOVER_AT } from './capture-quality.js';
import {
  LINEAGE_CONTRACT_ACTIVATED_AT,
  LINEAGE_CONTRACT_LAYER,
  LINEAGE_CONTRACT_DERIVATION,
  LINEAGE_CONTRACT_SOURCE_REFERENCE,
  MARKER_SOURCES,
} from './lineage-contract.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Both layouts the server runs from: dist/services/… in production after a
 * build, and src/services/… under tsx in development.
 */
const CANDIDATE_DIRS = [
  path.resolve(__dirname, '../../../../database/init'),
  path.resolve(__dirname, '../../../../../database/init'),
];

const FILES = [
  '006_market_state_capture.sql',
  '007_capture_timescale.sql',
  '008_capture_instrumentation.sql',
  '009_lineage_and_taxonomy.sql',
  '010_capture_quality_lineage.sql',
  '011_contract_generations.sql',
  '012_milestone_derivation.sql',
  '013_contract_marker_authority.sql',
  '014_system_learning.sql',
  '015_system_learning_fixes.sql',
];

/** 007 is retention and compression policies, which need the timescaledb extension. */
const BEST_EFFORT = new Set(['007_capture_timescale.sql']);

export interface SchemaEnsureResult {
  applied: number;
  skipped: number;
  failed: number;
  errors: string[];
}

let lastResult: SchemaEnsureResult | null = null;

/** What the last boot-time schema check did. Surfaced on the coverage endpoint. */
export function captureSchemaStatus(): SchemaEnsureResult | null {
  return lastResult;
}

function splitStatements(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function initDir(): string | null {
  return CANDIDATE_DIRS.find((dir) => existsSync(path.join(dir, FILES[0]))) ?? null;
}

export async function ensureCaptureSchema(): Promise<SchemaEnsureResult> {
  const result: SchemaEnsureResult = { applied: 0, skipped: 0, failed: 0, errors: [] };
  const dir = initDir();

  if (!dir) {
    result.failed++;
    result.errors.push(
      `Could not find database/init next to the server bundle (looked in ${CANDIDATE_DIRS.join(', ')}). ` +
        'Market-state capture will write nothing until the migration is applied by hand.'
    );
    logger.error({ candidates: CANDIDATE_DIRS }, 'Capture schema: migration files not found');
    lastResult = result;
    return result;
  }

  for (const file of FILES) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    const bestEffort = BEST_EFFORT.has(file);

    for (const statement of splitStatements(readFileSync(full, 'utf-8'))) {
      try {
        await sql.unsafe(statement);
        result.applied++;
      } catch (err: any) {
        if (bestEffort) {
          result.skipped++;
        } else {
          result.failed++;
          const message = `${file}: ${err.message} (${statement.slice(0, 80)})`;
          result.errors.push(message);
          logger.error({ file, error: err.message, statement: statement.slice(0, 120) }, 'Capture schema statement failed');
        }
      }
    }
  }

  // Record when each recorded layer first wrote a row, once, so no report
  // ever has to say "recording began yesterday" — relative wording that is
  // wrong the moment somebody reads it on a different day.
  await recordMilestones();

  lastResult = result;
  if (result.failed > 0) {
    logger.error(result, 'Capture schema: incomplete — some history will not be recorded');
  } else {
    logger.info(
      { applied: result.applied, skippedPolicies: result.skipped },
      'Capture schema ready'
    );
  }
  return result;
}

/**
 * The instant each recorded layer began, written once and never updated.
 *
 * ON CONFLICT DO NOTHING is the whole mechanism: the first boot after a
 * layer ships records its start, and every boot after that leaves the
 * original instant alone. A milestone that moved on every restart would be
 * worse than none, because it would look authoritative while meaning
 * "whenever the server last came up".
 */
/**
 * The evidence each cutover is seeded from.
 *
 * A cutover is the instant a WRITE CONTRACT changed, which is knowable from
 * the earliest row actually carrying the field that transition introduced —
 * not from when a process happened to start. The first recorder wrote "now"
 * for all four and produced timestamps four milliseconds apart for
 * transitions that were hours apart.
 *
 * Each entry either names a compiled constant or a single query over the
 * captured rows. The result is written ONCE and frozen; a milestone already
 * carrying a derivation is never recomputed, so this cannot become a value
 * that drifts on every restart.
 */
const CUTOVER_EVIDENCE: {
  layer: string;
  note: string;
  derivation: string;
  /** Whether this instant may carry an invariant. See MARKER_SOURCES. */
  source: string;
  sourceReference: string;
  resolve: () => Promise<Date | null>;
}[] = [
  {
    layer: 'data_quality_cutover_at',
    note: 'absence stopped being stored as zero (NULL_PRESERVING)',
    derivation: 'compiled constant DATA_QUALITY_CUTOVER_AT — the deploy that changed the write contract',
    source: MARKER_SOURCES.AUTHORITATIVE,
    sourceReference: 'deploy of commit 88164aa, when nullIfZero reached production',
    resolve: async () => new Date(DATA_QUALITY_CUTOVER_AT),
  },
  {
    // AUTHORITATIVE, and the reason this file changed.
    //
    // This was `earliest oi_snapshots row carrying a capture_run_id`, which
    // answers when stamping first SUCCEEDED. A boundary derived from the
    // first surviving row cannot, by construction, detect a failure that
    // happened before it — the failure simply moves the boundary. It now
    // comes from the deployment that made stamping mandatory.
    layer: LINEAGE_CONTRACT_LAYER,
    note: 'capture_run_id stamping became MANDATORY (lineage-aware writer started)',
    derivation: LINEAGE_CONTRACT_DERIVATION,
    source: MARKER_SOURCES.RUNTIME_ACTIVATION,
    sourceReference: LINEAGE_CONTRACT_SOURCE_REFERENCE,
    resolve: async () => new Date(LINEAGE_CONTRACT_ACTIVATED_AT),
  },
  {
    // Still inferred, and now labelled as such. These two carry no
    // invariant, so describing when the field first appeared is honest and
    // sufficient. If either ever needs to gate a hard check, it needs an
    // authoritative marker first.
    layer: 'validity_contract_cutover_at',
    note: 'greeks_valid and the availability flags began being written',
    derivation: 'earliest oi_snapshots row carrying greeks_valid',
    source: MARKER_SOURCES.INFERRED,
    sourceReference: 'oi_snapshots.greeks_valid',
    resolve: () => earliestRowWith('greeks_valid IS NOT NULL'),
  },
  {
    layer: 'greek_provenance_cutover_at',
    note: 'model name, version and calculation inputs began being written',
    derivation: 'earliest oi_snapshots row carrying greeks_model_name',
    source: MARKER_SOURCES.INFERRED,
    sourceReference: 'oi_snapshots.greeks_model_name',
    resolve: () => earliestRowWith('greeks_model_name IS NOT NULL'),
  },
];

async function earliestRowWith(predicate: string): Promise<Date | null> {
  try {
    const [row] = await sql.unsafe<{ t: Date | null }[]>(
      `SELECT MIN(time) AS t FROM oi_snapshots WHERE ${predicate}`
    );
    return row?.t ? new Date(row.t) : null;
  } catch {
    return null;
  }
}

/**
 * Records when each layer began, and seeds the four cutovers from evidence.
 *
 * Two write paths, both write-once:
 *
 *   A layer with no row yet is inserted. For a cutover that means the
 *   evidence-derived instant; for an ordinary layer it means now, which is
 *   correct because "when did this layer start recording" is exactly the
 *   boot that first ran it.
 *
 *   A cutover row written by the earlier naive recorder — recognisable by
 *   its NULL derivation — is corrected once. After that it carries a
 *   derivation and is never touched again. This is a bounded repair of a
 *   known-wrong value, not a mechanism that keeps moving it.
 */
async function recordMilestones(): Promise<void> {
  const layers: { layer: string; note: string }[] = [
    { layer: 'market_state_capture', note: 'Option chain, futures, positioning and underlying capture' },
    { layer: 'decision_snapshots', note: 'Every evaluation recorded, TAKE and REFUSE alike' },
    { layer: 'trade_health_shadow', note: 'Trade health computed and logged, never acting' },
    { layer: 'location_quality_shadow', note: 'Location scored, never gating' },
    { layer: 'room_to_run_shadow', note: 'Room to run measured, never gating' },
    { layer: 'option_quality', note: 'Option quality scored; only mechanical tradeability gates' },
    { layer: 'setup_tagging', note: 'Setup named from what the engine already detected' },
    { layer: 'stop_events', note: 'Full state captured and classified at stop-fire time' },
    { layer: 'capture_runs', note: 'Capture attempts recorded before their outcome is known' },
  ];

  for (const { layer, note } of layers) {
    try {
      await sql`
        INSERT INTO research_milestones (layer, recording_started_at, note, source, source_reference)
        VALUES (${layer}, ${new Date()}, ${note}, ${MARKER_SOURCES.BOOT_UNVERIFIED}, 'process start')
        ON CONFLICT (layer) DO UPDATE
          -- Label only. The instant is never touched; these rows record when
          -- a process started and are honest about it rather than corrected
          -- into looking evidence-derived.
          SET source = EXCLUDED.source, source_reference = EXCLUDED.source_reference
          WHERE research_milestones.source IS NULL
      `;
    } catch {
      // The milestone table may not exist on an older schema. Not worth
      // failing a boot over.
    }
  }

  for (const cutover of CUTOVER_EVIDENCE) {
    try {
      const at = await cutover.resolve();
      if (at == null) continue; // No evidence yet — record nothing rather than guess.

      await sql`
        INSERT INTO research_milestones
          (layer, recording_started_at, note, derivation, derived_at, source, source_reference)
        VALUES (${cutover.layer}, ${at}, ${cutover.note}, ${cutover.derivation}, ${new Date()},
                ${cutover.source}, ${cutover.sourceReference})
        ON CONFLICT (layer) DO UPDATE
          SET recording_started_at = EXCLUDED.recording_started_at,
              note = EXCLUDED.note,
              derivation = EXCLUDED.derivation,
              derived_at = EXCLUDED.derived_at,
              source = EXCLUDED.source,
              source_reference = EXCLUDED.source_reference
          -- Write-once with respect to reaching ITS OWN intended authority.
          --
          -- 012 froze on "derivation IS NULL", which was right for the defect
          -- it fixed but left the lineage row stuck at its inferred value: it
          -- already carried a derivation, so nothing could replace it. The
          -- guard then became "not yet authoritative", which had the same
          -- shape of problem one level up — once the row read
          -- authoritative_contract_marker it froze, and could not be raised
          -- to the stronger railway_runtime_activation once the deployment
          -- log was actually read.
          --
          -- So the guard is now each cutover's own target source. A marker
          -- climbs to its intended authority exactly once and is frozen
          -- there; it can never drift, and never downgrade.
          WHERE research_milestones.source IS DISTINCT FROM ${cutover.source}
      `;
    } catch {
      // Older schema without the derivation column. Leave it alone.
    }
  }
}

/** When each recorded layer began, for reports that must not say "yesterday". */
export async function researchMilestones(): Promise<
  {
    layer: string;
    recording_started_at: string;
    note: string | null;
    derivation: string | null;
    source: string | null;
    source_reference: string | null;
  }[]
> {
  try {
    const rows = await sql<
      {
        layer: string;
        recording_started_at: Date;
        note: string | null;
        derivation: string | null;
        source: string | null;
        source_reference: string | null;
      }[]
    >`
      SELECT layer, recording_started_at, note, derivation, source, source_reference
      FROM research_milestones ORDER BY recording_started_at ASC
    `;
    return rows.map((r) => ({
      layer: r.layer,
      recording_started_at: new Date(r.recording_started_at).toISOString(),
      note: r.note,
      // How the instant was established. A cutover with no derivation is a
      // boot-time value that has not been corrected, and should be read as
      // "when the process started", not "when the contract changed".
      derivation: r.derivation,
      // Whether that derivation may carry an invariant. Only
      // 'authoritative_contract_marker' may: a boundary inferred from the
      // rows it governs cannot detect a failure at its own beginning.
      source: r.source,
      source_reference: r.source_reference,
    }));
  } catch {
    return [];
  }
}
