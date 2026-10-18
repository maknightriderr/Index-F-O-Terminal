// ============================================================
// OI SNAPSHOT ARCHIVE (audit 2026-10-18, OPS-1)
// ============================================================
// oi_snapshots grows about 36 MB per session (683 MB for 21 Sep - 16 Oct) on a
// 4.4 GB volume that filled once already (17 Sep). The only pruning deleted
// raw rows after 400 days, so the volume would fill in about three months.
//
// Raw rows older than OI_RETENTION_DAYS (default 60; 0 = keep raw forever) are
// packed, one IST day of one symbol at a time, into oi_snapshots_archive as
// gzip'd JSON (lossless: every column of every row; unpackArchive restores
// them), and only once that row is stored are the raw rows deleted. Research
// keeps all of it; the table keeps 60 days. Nothing in the decision path reads
// rows that old (the intraday positioning window reads today's).
// ============================================================

import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from '../lib/db.js';
import { insertOnce } from '../lib/insert-once.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';

export const OI_STORAGE_MIGRATION = '043_oi_storage.sql';
const DEFAULT_RETENTION_DAYS = 60;
/** (day, symbol) groups packed per pass (every 6 h): steady state needs about 7 a day. */
const MAX_GROUPS_PER_PASS = 30;
const IST_OFFSET_MS = 5.5 * 3600_000;

/** OI_RETENTION_DAYS: a whole number of days >= 0 (0 = keep raw forever); anything else is the default 60. */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}
export const OI_RETENTION_DAYS = parseRetentionDays(process.env.OI_RETENTION_DAYS);

/** Pure: the start of the IST day `days` before now — rows before it are archived. Null = archiving off. */
export function archiveCutoff(now: number, days: number = OI_RETENTION_DAYS): Date | null {
  if (!(days > 0)) return null;
  const istMidnight = Math.floor((now + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
  return new Date(istMidnight - days * 86_400_000);
}

/** Pure: one group's rows -> the stored payload (base64 of gzip'd JSON). */
export function packArchive(rows: readonly Record<string, unknown>[]): string {
  return gzipSync(Buffer.from(JSON.stringify(rows))).toString('base64');
}

/** Pure: the payload -> the rows (JSON values: timestamps as ISO strings, numerics as stored). */
export function unpackArchive(payload: string): Record<string, unknown>[] {
  return JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString('utf8'));
}

/** One pass: the oldest groups past the cutoff are archived, then deleted. Returns the rows moved. */
export async function archiveOldOiSnapshots(now = Date.now(), limit = MAX_GROUPS_PER_PASS): Promise<number> {
  const cutoff = archiveCutoff(now);
  if (!cutoff || !schemaFileReady(OI_STORAGE_MIGRATION)) return 0;
  const groups = await sql<{ day: string; exchange: string; symbol: string }[]>`
    SELECT to_char((time AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, exchange, symbol
    FROM oi_snapshots WHERE time < ${cutoff}
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
    LIMIT ${limit}
  `;
  let moved = 0;
  for (const g of groups) {
    const from = new Date(`${g.day}T00:00:00+05:30`);
    const to = new Date(Math.min(from.getTime() + 86_400_000, cutoff.getTime()));
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM oi_snapshots WHERE symbol = ${g.symbol} AND exchange = ${g.exchange} AND time >= ${from} AND time < ${to} ORDER BY time
    `;
    if (rows.length === 0) continue;
    const payload = packArchive(rows);
    const times = rows.map((r) => new Date(r.time as string | Date).getTime());
    // Stored first; a row already archived by an interrupted pass (EXISTS) holds the same old, unchanging rows.
    await insertOnce(sql`
      INSERT INTO oi_snapshots_archive (day, exchange, symbol, rows, first_time, last_time, bytes, payload_gz)
      VALUES (${g.day}, ${g.exchange}, ${g.symbol}, ${rows.length}, ${new Date(Math.min(...times))}, ${new Date(Math.max(...times))}, ${payload.length}, ${payload})
    `);
    const del = await sql`DELETE FROM oi_snapshots WHERE symbol = ${g.symbol} AND exchange = ${g.exchange} AND time >= ${from} AND time < ${to}`;
    moved += del.count ?? 0;
  }
  if (moved > 0) logger.info({ moved, groups: groups.length, retentionDays: OI_RETENTION_DAYS }, 'OI snapshots: archived and removed raw rows past retention');
  return moved;
}
