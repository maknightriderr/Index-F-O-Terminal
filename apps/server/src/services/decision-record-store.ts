// Persistence for decision snapshots and records (migration 034), and
// replay(snapshotId). The pure parts live in decision-record.ts.

import type { DecisionRecord, SignalDecisionSnapshot } from '@fno/shared';
import { sql } from '../lib/db.js';
import { insertOnce } from '../lib/insert-once.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { TAPE_VERSION, decode, encode, type TapeEntry } from '../lib/io-tape.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { DECISION_RECORDS_MIGRATION } from './snapshot-context.js';
import { liveLogicStamp } from '../config/trading-flags.js';
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

export const CONFIG_REGISTRY_MIGRATION = '042_config_registry.sql';
const registeredConfigs = new Set<string>();

/**
 * Audit 2026-10-18 (REPL-1): the configuration a snapshot was decided under, once per process: its hash, the
 * decision config, the full logic stamp and the git commit. A replay refused with CONFIG_MISMATCH can then name the
 * commit and settings it needs. Never throws; a failed write is retried by the next snapshot.
 */
export async function registerConfig(snap: SignalDecisionSnapshot): Promise<void> {
  const hash = snap.config?.configHash;
  if (!hash || registeredConfigs.has(hash) || !schemaFileReady(CONFIG_REGISTRY_MIGRATION)) return;
  registeredConfigs.add(hash);
  try {
    // insertOnce, not an upsert: this store never upserts (its rule-guarded tables refuse it; migration-036 test).
    const stored = await insertOnce(sql`
      INSERT INTO config_registry (config_hash, logic_flags_hash, config, logic_stamp, git_commit)
      VALUES (${hash}, ${snap.versions?.logicFlagsHash ?? null}, ${sql.json(snap.config as never)}, ${sql.json(liveLogicStamp() as never)}, ${snap.versions?.gitCommit ?? null})
    `);
    if (stored === 'EXISTS') await sql`UPDATE config_registry SET last_seen = NOW() WHERE config_hash = ${hash}`;
  } catch (err: any) {
    registeredConfigs.delete(hash);
    logger.warn({ error: err.message, configHash: hash }, 'Config registry: write failed (retried with the next snapshot)');
  }
}

export interface RegisteredConfig {
  configHash: string;
  gitCommit: string | null;
  firstSeen: string;
  lastSeen: string;
  logicStamp: unknown;
}

export async function loadRegisteredConfig(configHash: string): Promise<RegisteredConfig | null> {
  if (!schemaFileReady(CONFIG_REGISTRY_MIGRATION)) return null;
  const rows = await sql<{ config_hash: string; git_commit: string | null; first_seen: Date; last_seen: Date; logic_stamp: unknown }[]>`
    SELECT config_hash, git_commit, first_seen, last_seen, logic_stamp FROM config_registry WHERE config_hash = ${configHash}
  `;
  const r = rows[0];
  return r ? { configHash: r.config_hash, gitCommit: r.git_commit, firstSeen: new Date(r.first_seen).toISOString(), lastSeen: new Date(r.last_seen).toISOString(), logicStamp: r.logic_stamp } : null;
}

/** Inserts the snapshot (immutable; a second insert of the same id is a no-op). True when it is stored. */
export async function persistSnapshot(snap: SignalDecisionSnapshot): Promise<boolean> {
  if (!decisionRecordsReady()) return false;
  void registerConfig(snap);
  const row = freezeSnapshotRow(snap);
  try {
    await insertOnce(sql`
      INSERT INTO signal_decision_snapshots (snapshot_id, symbol, exchange, mode, decision_bar_time, polled_at, capture_reason, snapshot_schema_version, versions, data_quality, inputs)
      VALUES (${row.snapshot_id}, ${row.symbol}, ${row.exchange}, ${row.mode}, ${row.decision_bar_time}, ${row.polled_at}, ${row.capture_reason}, ${row.snapshot_schema_version},
              ${sql.json(row.versions as never)}, ${sql.json(row.data_quality as never)}, ${sql.json(row.inputs as never)})
    `);
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
    await insertOnce(sql`
      INSERT INTO decision_records (snapshot_id, record_schema_version, record, record_hash, final_status, selected_candidate_id, generated_at)
      VALUES (${record.snapshotId}, ${record.schemaVersion}, ${sql.json(JSON.parse(canonicalJson(record)) as never)}, ${recordHash(record)}, ${record.finalStatus}, ${record.selectedCandidateId}, ${new Date(record.generatedAt).toISOString()})
    `);
    for (const link of record.triggerEventIds) {
      for (let k = 0; k < link.eventIds.length; k++) {
        await insertOnce(sql`
          INSERT INTO decision_trigger_events (snapshot_id, candidate_id, event_id, ordinal)
          VALUES (${record.snapshotId}, ${link.candidateId}, ${link.eventIds[k]}, ${k})
        `);
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
  | { status: 'CONFIG_MISMATCH'; snapshotId: string; recordedConfigHash: string; currentConfigHash: string; recordedConfig: RegisteredConfig | null }
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
  // The registry names the commit and settings the snapshot needs (null for snapshots before 042, 2026-10-18).
  if (out.status === 'CONFIG_MISMATCH') return { snapshotId, ...out, recordedConfig: await loadRegisteredConfig(out.recordedConfigHash).catch(() => null) };
  if (out.status !== 'OK') return { status: 'NOT_FOUND', snapshotId };
  if (!stored) return { status: 'NO_STORED_RECORD', snapshotId, hash: out.hash, storedHash: null, diff: [], record: out.record };
  const diff = recordDiff(stored.record, out.record);
  return { status: diff.length === 0 && stored.hash === out.hash ? 'MATCH' : 'DIFFERENT', snapshotId, hash: out.hash, storedHash: stored.hash, diff, record: out.record };
}

// ---------------- full replay tapes (037) ----------------

/**
 * DECISION_TAPE: which polls keep their I/O tape for full replay (audit 2026-10-18, REPL-1).
 *   TAKE (default)  every live poll is recorded; the tape is STORED for each poll that minted a paper trade and
 *                   for 1 in DECISION_TAPE_SAMPLE (default 20) of the others, chosen by snapshot id, so the Old
 *                   Indicator's trades can be replayed exactly;
 *   ALL             every snapshotted poll (1 / true / on / yes: the old switch). A production tape is ~MBs (a day
 *                   of history, the full chain and every SQL result): left on for every snapshot it filled the
 *                   5 GB database volume in three days (2026-10-08);
 *   OFF             none (0 / false / off / no, or anything else).
 * Recording costs CPU and memory on EVERY poll in TAKE and ALL (each read is copied into the tape); set OFF if
 * GET /api/health/memory shows it matters.
 */
export type DecisionTapeMode = 'OFF' | 'TAKE' | 'ALL';
export function parseDecisionTapeMode(raw: string | undefined): DecisionTapeMode {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === '' || v === 'TAKE') return 'TAKE';
  if (/^(1|TRUE|ON|YES|ALL)$/.test(v)) return 'ALL';
  return 'OFF';
}
export const DECISION_TAPE_MODE: DecisionTapeMode = parseDecisionTapeMode(process.env.DECISION_TAPE);
export const DECISION_TAPE_ENABLED = DECISION_TAPE_MODE !== 'OFF';
/** In TAKE mode, 1 in this many non-minting polls keeps its tape (DECISION_TAPE_SAMPLE; 0 = none). */
export const DECISION_TAPE_SAMPLE = (() => {
  const n = Number(process.env.DECISION_TAPE_SAMPLE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20;
})();

/** Pure: keep this poll's tape? The sample is a hash of the snapshot id, so the choice is deterministic. */
export function shouldStoreTape(mode: DecisionTapeMode, minted: boolean, snapshotId: string, sample: number = DECISION_TAPE_SAMPLE): boolean {
  if (mode === 'OFF') return false;
  if (mode === 'ALL' || minted) return true;
  if (sample <= 0) return false;
  const h = Number.parseInt(snapshotId.replace(/[^0-9a-f]/gi, '').slice(0, 8), 16);
  return Number.isFinite(h) && h % sample === 0;
}
/** Tapes are kept this many days (DECISION_TAPE_RETENTION_DAYS, default 2), then removed by the forward-validation job. */
export const DECISION_TAPE_RETENTION_DAYS = (() => {
  const n = Number(process.env.DECISION_TAPE_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();
/** A tape larger than this (compressed) is not stored — the snapshot and its DecisionRecord still are. */
export const MAX_TAPE_BYTES = 512 * 1024;
export const TAPES_MIGRATION = '037_replay_tapes_forward_validation.sql';

const gz = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v))).toString('base64');
const gunz = (b64: string) => JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));

/** Stores the poll's tape and the result it returned. Never throws. */
export async function persistTape(snapshotId: string, tape: readonly TapeEntry[], liveResult: unknown): Promise<void> {
  if (!schemaFileReady(TAPES_MIGRATION)) return;
  try {
    const tapeGz = gz(tape);
    if (tapeGz.length > MAX_TAPE_BYTES) {
      logger.warn({ snapshotId, bytes: tapeGz.length, entries: tape.length }, 'Decision tape: too large — not stored (snapshot and record are)');
      return;
    }
    await insertOnce(sql`
      INSERT INTO decision_tapes (snapshot_id, tape_version, tape_gz, entries, bytes, live_result_gz)
      VALUES (${snapshotId}, ${TAPE_VERSION}, ${tapeGz}, ${tape.length}, ${tapeGz.length}, ${gz(encode(liveResult))})
    `);
  } catch (err: any) {
    logger.error({ error: err.message, snapshotId }, 'Decision tape: insert failed — this decision has no full replay');
  }
}

export async function loadTape(snapshotId: string): Promise<{ tape: TapeEntry[]; liveResult: unknown; entries: number; bytes: number } | null> {
  const rows = await sql<{ tape_gz: string; live_result_gz: string; entries: number; bytes: number }[]>`
    SELECT tape_gz, live_result_gz, entries, bytes FROM decision_tapes WHERE snapshot_id = ${snapshotId}
  `;
  if (!rows[0]) return null;
  return { tape: gunz(rows[0].tape_gz), liveResult: decode(gunz(rows[0].live_result_gz)), entries: rows[0].entries, bytes: rows[0].bytes };
}
