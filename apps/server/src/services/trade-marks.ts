// ============================================================
// TRADE MARKS — the last price the price monitor saw for an open paper trade
// ============================================================
// The monitor reads each open trade's contract on every sweep (~90 s) and on
// every live tick, but only wrote the result back when an excursion extreme
// or the health state changed — so nothing recorded "the latest premium and
// when it was observed", and the Paper Trades view had nothing truthful to
// show for an open trade.
//
// This writes that one observation (premium + the instant it was observed) to
// a small Redis key per trade, for the display only. It is fire-and-forget,
// rate-limited per trade, never read by any decision, and expires on its own.
// ============================================================

import { redis } from '../lib/redis.js';

export const TRADE_MARK_TTL_SECONDS = 2 * 24 * 60 * 60;
/** At most one write per trade per this interval (ticks can arrive many times a second). */
export const TRADE_MARK_MIN_INTERVAL_MS = 3_000;

export interface TradeMark {
  premium: number;
  /** When the monitor observed this price (epoch ms). */
  at: number;
}

export const tradeMarkKey = (signalId: string): string => `trade_mark:${signalId}`;

const lastWrite = new Map<string, number>();

/** Pure: whether a mark should be written now (a usable price, and not too soon after the previous one). */
export function shouldWriteMark(prevAt: number | undefined, now: number, premium: number | null): boolean {
  if (premium == null || !(premium > 0)) return false;
  return prevAt == null || now - prevAt >= TRADE_MARK_MIN_INTERVAL_MS;
}

/** Records the monitor's latest observation of an open trade. Never throws, never waits. */
export function recordTradeMark(signalId: string | null | undefined, premium: number | null, now: number): void {
  if (!signalId || !shouldWriteMark(lastWrite.get(signalId), now, premium)) return;
  lastWrite.set(signalId, now);
  if (lastWrite.size > 500) {
    const oldest = [...lastWrite.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
    for (const [k] of oldest) lastWrite.delete(k);
  }
  const mark: TradeMark = { premium: Math.round((premium as number) * 100) / 100, at: now };
  void redis.set(tradeMarkKey(signalId), JSON.stringify(mark), 'EX', TRADE_MARK_TTL_SECONDS).catch(() => undefined);
}

/** Reads the latest marks of many trades (read-only). Missing / unparsable marks are simply absent. */
export async function readTradeMarks(signalIds: readonly string[]): Promise<Map<string, TradeMark>> {
  const out = new Map<string, TradeMark>();
  if (signalIds.length === 0) return out;
  try {
    const raw = await redis.mget(...signalIds.map(tradeMarkKey));
    raw.forEach((v, i) => {
      if (!v) return;
      try {
        const m = JSON.parse(v) as TradeMark;
        if (typeof m.premium === 'number' && typeof m.at === 'number') out.set(signalIds[i], m);
      } catch {
        /* unparsable: treated as absent */
      }
    });
  } catch {
    /* Redis unavailable: no marks */
  }
  return out;
}
