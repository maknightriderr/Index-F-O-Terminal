// Persistence for decision snapshots and records (migration 034), and
// replay(snapshotId). The pure parts live in decision-record.ts.

import type { DecisionRecord, SignalDecisionSnapshot } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { DECISION_RECORDS_MIGRATION } from './snapshot-context.js';
import {
  canonicalJson,
  currentConfigHashFor,
  freezeSnapshotRow,
  recordDiff,
  recordHash,
  replaySnapshot,
  thawSnapshotRow,
  type SnapshotRow,
} from './decision-record.js';

/** Writes are attempted only once migration 034 applied cleanly at boot. */
export const decisionRecordsReady = (): boolean => schemaFileReady(DECISION_RECORDS_MIGRATION);

/** Inserts the snapshot (immutable; a second insert of the same id is a no-op). True when it is stored. */
export async function persistSnapshot(snap: SignalDecisionSnapshot): Promise<boolean> {
  if (!decisionRecordsReady()) return false;
  const row = freezeSnapshotRow(snap);
  try {
    await sql`
      INSERT INTO signal_decision_snapshots (snapshot_id, symbol, exchange, mode, decision_bar_time, polled_at, capture_reason, snapshot_schema_version, versions, data_quality, inputs)
      VALUES (${row.snapshot_id}, ${row.symbol}, ${row.exchange}, ${row.mode}, ${row.decision_bar_time}, ${row.polled_at}, ${row.capture_reason}, ${row.snapshot_schema_version},
              ${sql.json(row.versions as never)}, ${sql.json(row.data_quality as never)}, ${sql.json(row.inputs as never)})
      ON CONFLICT (snapshot_id) DO NOTHING
    `;
    return true;
  } catch (err: any) {
    logger.error({ error: err.message, snapshotId: snap.snapshotId, symbol: snap.symbol }, 'Decision snapshot: insert failed — this decision is not replayable');
    return false;
  }
}

/** Inserts the record, then (separately, after event evaluation) the candidate → event associations. */
export async function persistDecisionRecord(record: DecisionRecord): Promise<boolean> {
  if (!decisionRecordsReady()) return false;
  try {
    await sql`
      INSERT INTO decision_records (snapshot_id, record_schema_version, record, record_hash, final_status, selected_candidate_id, generated_at)
      VALUES (${record.snapshotId}, ${record.schemaVersion}, ${sql.json(JSON.parse(canonicalJson(record)) as never)}, ${recordHash(record)}, ${record.finalStatus}, ${record.selectedCandidateId}, ${new Date(record.generatedAt).toISOString()})
      ON CONFLICT (snapshot_id) DO NOTHING
    `;
    for (const link of record.triggerEventIds) {
      for (let k = 0; k < link.eventIds.length; k++) {
        await sql`
          INSERT INTO decision_trigger_events (snapshot_id, candidate_id, event_id, ordinal)
          VALUES (${record.snapshotId}, ${link.candidateId}, ${link.eventIds[k]}, ${k})
          ON CONFLICT DO NOTHING
        `;
      }
    }
    return true;
  } catch (err: any) {
    logger.error({ error: err.message, snapshotId: record.snapshotId }, 'Decision record: insert failed');
    return false;
  }
}

export async function loadSnapshot(snapshotId: string): Promise<SignalDecisionSnapshot | null> {
  const rows = await sql<SnapshotRow[]>`
    SELECT snapshot_id, symbol, exchange, mode, decision_bar_time, polled_at, capture_reason, snapshot_schema_version, versions, data_quality, inputs
    FROM signal_decision_snapshots WHERE snapshot_id = ${snapshotId}
  `;
  return rows[0] ? thawSnapshotRow({ ...rows[0], decision_bar_time: new Date(rows[0].decision_bar_time).toISOString(), polled_at: new Date(rows[0].polled_at).toISOString() }) : null;
}

export async function loadDecisionRecord(snapshotId: string): Promise<{ record: DecisionRecord; hash: string; outcome: unknown; outcomeAt: Date | null } | null> {
  const rows = await sql<{ record: DecisionRecord; record_hash: string; outcome: unknown; outcome_at: Date | null }[]>`
    SELECT record, record_hash, outcome, outcome_at FROM decision_records WHERE snapshot_id = ${snapshotId}
  `;
  return rows[0] ? { record: rows[0].record, hash: rows[0].record_hash, outcome: rows[0].outcome, outcomeAt: rows[0].outcome_at } : null;
}

export type ReplayReport =
  | { status: 'NOT_FOUND'; snapshotId: string }
  | { status: 'CONFIG_MISMATCH'; snapshotId: string; recordedConfigHash: string; currentConfigHash: string }
  | { status: 'MATCH' | 'DIFFERENT' | 'NO_STORED_RECORD'; snapshotId: string; hash: string; storedHash: string | null; diff: string[]; record: DecisionRecord };

/**
 * replay(snapshotId): load the stored snapshot (the only read), then derive
 * the record offline and compare it with the stored one under
 * canonicalization (NONDETERMINISTIC_RECORD_FIELDS excluded).
 */
export async function replay(snapshotId: string): Promise<ReplayReport> {
  const snap = await loadSnapshot(snapshotId);
  if (!snap) return { status: 'NOT_FOUND', snapshotId };
  const stored = await loadDecisionRecord(snapshotId);
  const out = replaySnapshot(snap, currentConfigHashFor(snap));
  if (out.status === 'CONFIG_MISMATCH') return { snapshotId, ...out };
  if (out.status !== 'OK') return { status: 'NOT_FOUND', snapshotId };
  if (!stored) return { status: 'NO_STORED_RECORD', snapshotId, hash: out.hash, storedHash: null, diff: [], record: out.record };
  const diff = recordDiff(stored.record, out.record);
  return { status: diff.length === 0 && stored.hash === out.hash ? 'MATCH' : 'DIFFERENT', snapshotId, hash: out.hash, storedHash: stored.hash, diff, record: out.record };
}
