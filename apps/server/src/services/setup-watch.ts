// ============================================================
// CONFIRMED-SETUP WATCH — store and lifecycle records (I/O)
// ============================================================
// The pure rules live in setup-watch-core.ts (re-exported here). This file
// keeps today's rows per symbol in Redis and writes each lifecycle event as a
// setup_events row (decision LIFECYCLE).
// ============================================================

import type { Exchange, SetupWatchRow } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { recordSetupEvent } from './setup-events.js';
import { liveLogicStamp } from '../config/trading-flags.js';
import { applyWatchUpdate, endUpdateFor, type WatchUpdate } from './setup-watch-core.js';

export * from './setup-watch-core.js';

// ---------------- store and records ----------------

const WATCH_TTL_SECONDS = 36 * 60 * 60;

export function setupWatchKey(exchange: Exchange, underlying: string, mode: string, day: string): string {
  return `setup_watch:${exchange}:${underlying}:${mode}:${day}`;
}

export async function readSetupWatch(key: string): Promise<Record<string, SetupWatchRow>> {
  try {
    return JSON.parse((await redis.get(key)) ?? '{}') as Record<string, SetupWatchRow>;
  } catch (err: any) {
    logger.warn({ error: err.message, key }, 'Setup watch: read failed');
    return {};
  }
}

/**
 * Applies the updates (same id → same row), records each lifecycle event as a
 * setup_events row (decision LIFECYCLE) and writes the store. An
 * `onlyIfExists` update never creates a row (an end for a setup never watched).
 */
export async function writeSetupWatch(
  key: string,
  meta: { exchange: Exchange; underlying: string },
  updates: ReadonlyArray<WatchUpdate & { onlyIfExists?: boolean }>
): Promise<Record<string, SetupWatchRow>> {
  const rows = await readSetupWatch(key);
  if (updates.length === 0) return rows;
  const v = liveLogicStamp().versions;
  for (const u of updates) {
    const prev = rows[u.id] ?? null;
    if (!prev && u.onlyIfExists) continue;
    const { row, events } = applyWatchUpdate(prev, u);
    rows[u.id] = row;
    for (const ev of events) {
      recordSetupEvent({
        time: new Date(u.at),
        instrument: meta.underlying,
        exchange: meta.exchange,
        timeframe: '15m',
        lifecycleId: u.id,
        direction: u.direction,
        fromStage: prev?.status ?? null,
        toStage: ev,
        reason: row.statusText,
        poolType: null,
        poolPrice: null,
        triggerType: u.source,
        entry: u.underlying.entry,
        stop: u.underlying.sl,
        t1: u.underlying.t1,
        t2: u.underlying.t2,
        scoreTotal: null,
        context: {
          watch: {
            event: ev,
            status: row.status,
            statusRR: row.statusRR,
            grossRR: u.grossRR,
            netRR: u.netRR,
            block: u.block,
            plan: row.plan,
            initial: row.initial,
            current: row.current,
            startedBelowMin: row.startedBelowMin,
            rrRecovered: row.rrRecovered,
            firstEligibleAt: row.firstEligibleAt,
            strikeChanges: row.strikeChanges,
            optionBuildFailures: row.optionBuildFailures,
            ended: row.ended,
          },
        },
        versions: {
          strategyVersion: v?.strategyVersion ?? 'unknown',
          triggerVersion: u.source,
          riskVersion: v?.riskVersion ?? 'unknown',
          optionVersion: v?.optionVersion ?? 'unknown',
          costVersion: v?.costVersion ?? 'unknown',
        },
      });
    }
  }
  try {
    await redis.set(key, JSON.stringify(rows), 'EX', WATCH_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, key }, 'Setup watch: write failed');
  }
  return rows;
}

/** Ends one row (no-op when it was never watched or already ended). */
export async function endWatchRow(key: string, meta: { exchange: Exchange; underlying: string }, id: string, reason: string, at: number): Promise<void> {
  const rows = await readSetupWatch(key);
  const row = rows[id];
  if (!row || row.ended) return;
  await writeSetupWatch(key, meta, [endUpdateFor(row, reason, at)]);
}

/** Today's rows for display: live ones first (most recently updated), then the latest ended ones. */
export function watchRowsForDisplay(rows: Record<string, SetupWatchRow>, maxEnded = 10): SetupWatchRow[] {
  const all = Object.values(rows);
  const live = all.filter((r) => !r.ended).sort((a, b) => b.updatedAt - a.updatedAt);
  const ended = all.filter((r) => r.ended).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxEnded);
  return [...live, ...ended];
}
