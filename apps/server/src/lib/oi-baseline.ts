// ============================================================
// DAILY OI BASELINE
// ============================================================
// Angel One's quote data exposes absolute OI only — no previous-session OI
// and no delta — so change-in-OI has to be derived against a baseline we
// keep ourselves.
//
// It used to be "the first OI value seen for this token today" (keyed by
// UTC date). That isn't a fixed reference: a strike first fetched at noon
// (spot moved, so it entered the ±20-strike window) reads ~0 change while
// its neighbours carry the full day's, and a server nobody polled until
// 11:00 measured everything from 11:00. Chain-wide OI flow then weighted
// strikes by whenever they happened to be seen.
//
// The baseline is now the previous session's SETTLED OI: any OI read taken
// while the exchange is closed (after a session's close) is saved, and the
// next session measures from it. oi-close-snapshot.ts refetches tracked
// chains shortly after each close so the snapshot exists for the contracts
// that matter. A contract with no snapshot falls back to its first reading
// this session, and says so (`baseline`), so callers can leave it out.
// ============================================================

import { getLatestSessionWindow } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { redis } from './redis.js';
import { logger } from './logger.js';

export type OiBaselineSource = 'PREV_CLOSE' | 'SESSION_FIRST_SEEN';

export interface ChangeOiResult {
  changeOi: number;
  /** Null when there's no baseline at all yet (e.g. OI not populated). */
  baseline: OiBaselineSource | null;
}

interface StoredBaseline {
  oi: number;
  source: OiBaselineSource;
}

interface ClosedSnapshot {
  oi: number;
  at: number;
}

const BASELINE_TTL_SECONDS = 60 * 60 * 24 * 4; // outlives a long weekend's gap between sessions
const CLOSED_SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 7;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Change in OI for the current (or most recently closed) session, and what
 * it was measured from. Falls back to 0 with no baseline (rather than
 * throwing) if Redis is unreachable — a cache outage shouldn't take down
 * option-chain/futures responses.
 */
export async function computeChangeOiDetailed(token: string, currentOi: number, exchange: Exchange): Promise<ChangeOiResult> {
  const now = Date.now();
  const session = getLatestSessionWindow(exchange, now);
  if (!session) return { changeOi: 0, baseline: null };

  const baseKey = `oi_base:${token}:${session.date}`;
  const closedKey = `oi_closed:${token}`;

  try {
    let base = parseJson<StoredBaseline>(await redis.get(baseKey));

    if (!base) {
      // A closed-market reading counts as this session's previous close only
      // if it was taken after the session before this one closed and before
      // this one opened — otherwise a whole session happened in between.
      const snapshot = parseJson<ClosedSnapshot>(await redis.get(closedKey));
      const previous = getLatestSessionWindow(exchange, session.open - 1);
      const snapshotIsPreviousClose =
        snapshot != null && snapshot.oi > 0 && snapshot.at < session.open && (previous == null || snapshot.at >= previous.close);

      // Continuity across this change's deploy: today's old first-seen
      // baseline (UTC-date key) still beats a brand-new reading.
      const legacy = snapshotIsPreviousClose ? null : Number(await redis.get(`oi_baseline:${token}:${new Date(now).toISOString().slice(0, 10)}`));

      const candidate: StoredBaseline | null = snapshotIsPreviousClose
        ? { oi: snapshot!.oi, source: 'PREV_CLOSE' }
        : legacy != null && legacy > 0
        ? { oi: legacy, source: 'SESSION_FIRST_SEEN' }
        : currentOi > 0
        ? { oi: currentOi, source: 'SESSION_FIRST_SEEN' }
        : null;

      if (candidate) {
        // NX, then re-read: concurrent requests converge on one baseline.
        await redis.set(baseKey, JSON.stringify(candidate), 'EX', BASELINE_TTL_SECONDS, 'NX');
        base = parseJson<StoredBaseline>(await redis.get(baseKey));
      }
    }

    // The session is over: this reading is settled OI — the next session's
    // previous close. Written after the baseline is resolved, so a
    // post-close read can never become its own session's baseline.
    if (now >= session.close && currentOi > 0) {
      await redis.set(closedKey, JSON.stringify({ oi: currentOi, at: now } satisfies ClosedSnapshot), 'EX', CLOSED_SNAPSHOT_TTL_SECONDS);
    }

    if (!base) return { changeOi: 0, baseline: null };
    return { changeOi: currentOi - base.oi, baseline: base.source };
  } catch (err: any) {
    logger.warn({ error: err.message, token }, 'OI baseline unavailable (Redis down?) — changeOi defaulted to 0');
    return { changeOi: 0, baseline: null };
  }
}

export async function computeChangeOi(token: string, currentOi: number, exchange: Exchange): Promise<number> {
  return (await computeChangeOiDetailed(token, currentOi, exchange)).changeOi;
}
