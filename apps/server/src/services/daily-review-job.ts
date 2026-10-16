// ============================================================
// DAILY REVIEW JOB — one note per session, to Telegram (2026-10-16)
// ============================================================
// Measurement only. About 20 minutes after the NSE close and after the MCX
// close, the session's paper trades are summarised (ai-daily-review.ts
// computes the numbers; the model only writes a short note around them),
// sent to Telegram once, and kept for the assistant panel
// (GET /api/ai-assistant/daily-review). A holiday has no session and gets
// no review. A failed run is retried on the next tick inside the window.
// ============================================================

import { getSessionWindow, type Exchange } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { listPaperTrades } from './paper-trades.js';
import { REVIEW_HISTORY_KEY, formatReviewMessage, reviewNumberLines, sessionReviewStats, writeReviewSummary, type DailyReview, type ReviewGroup } from './ai-daily-review.js';

const TICK_MS = 5 * 60_000;
/** Closes settle (session-end square-off, the price monitor's last sweep) before the review is written. */
export const REVIEW_DELAY_MS = 20 * 60_000;
/** A review that could not run within this long after the close is skipped rather than sent hours late. */
export const REVIEW_WINDOW_MS = 4 * 60 * 60_000;
const HISTORY_KEPT = 30;

const GROUP_EXCHANGE: Record<ReviewGroup, Exchange> = { NSE_BSE: 'NSE', MCX: 'MCX' };
const istDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Pure: the sessions due for a review at `now` (today's session closed 20 min to 4 h ago). */
export function reviewsDue(now: number, windowOf: (exchange: Exchange, date: string) => { close: number } | null = getSessionWindow): Array<{ group: ReviewGroup; date: string }> {
  const date = istDate(now);
  return (Object.keys(GROUP_EXCHANGE) as ReviewGroup[]).flatMap((group) => {
    const w = windowOf(GROUP_EXCHANGE[group], date);
    return w && now >= w.close + REVIEW_DELAY_MS && now <= w.close + REVIEW_WINDOW_MS ? [{ group, date }] : [];
  });
}

async function runReview(group: ReviewGroup, date: string): Promise<void> {
  const key = `daily-review:sent:${date}:${group}`;
  // Claimed before the work so two ticks never send twice; released on failure so the next tick retries.
  const claimed = await redis.set(key, 'pending', 'EX', 3 * 86_400, 'NX');
  if (!claimed) return;
  try {
    const { trades } = await listPaperTrades(1000);
    const stats = sessionReviewStats(trades, group, date);
    if (stats.minted === 0 && stats.closed === 0 && stats.stillOpen === 0) {
      logger.info({ group, date }, 'Daily review: no paper trades this session, nothing sent');
      return;
    }
    const summary = await writeReviewSummary(stats);
    const message = formatReviewMessage(stats, summary?.text ?? null, summary?.via ?? null);
    const review: DailyReview = { group, date, createdAt: Date.now(), stats, lines: reviewNumberLines(stats), summary: summary?.text ?? null, via: summary?.via ?? null, message };
    await redis.lpush(REVIEW_HISTORY_KEY, JSON.stringify(review));
    await redis.ltrim(REVIEW_HISTORY_KEY, 0, HISTORY_KEPT - 1);
    await sendTelegramMessage(message);
    await redis.set(key, 'sent', 'EX', 3 * 86_400);
    logger.info({ group, date, closed: stats.closed, netR: stats.netR, ai: summary?.via ?? null }, 'Daily review sent');
  } catch (err: any) {
    await redis.del(key).catch(() => undefined);
    throw err;
  }
}

export async function runDailyReviewTick(now = Date.now()): Promise<void> {
  for (const { group, date } of reviewsDue(now)) await runReview(group, date);
}

let started = false;
export function startDailyReview(): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runDailyReviewTick().catch((err: any) => logger.warn({ error: err.message }, 'Daily review: tick failed (retried next tick)'));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, 60_000);
  logger.info({ delayMinutes: REVIEW_DELAY_MS / 60_000 }, 'Daily review started (one note per session, after the close)');
}
