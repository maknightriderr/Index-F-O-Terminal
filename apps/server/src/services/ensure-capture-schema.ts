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
        INSERT INTO research_milestones (layer, recording_started_at, note)
        VALUES (${layer}, ${new Date()}, ${note})
        ON CONFLICT (layer) DO NOTHING
      `;
    } catch {
      // The milestone table may not exist on an older schema. Not worth
      // failing a boot over.
    }
  }
}

/** When each recorded layer began, for reports that must not say "yesterday". */
export async function researchMilestones(): Promise<{ layer: string; recording_started_at: string; note: string | null }[]> {
  try {
    const rows = await sql<{ layer: string; recording_started_at: Date; note: string | null }[]>`
      SELECT layer, recording_started_at, note FROM research_milestones ORDER BY recording_started_at ASC
    `;
    return rows.map((r) => ({
      layer: r.layer,
      recording_started_at: new Date(r.recording_started_at).toISOString(),
      note: r.note,
    }));
  } catch {
    return [];
  }
}
