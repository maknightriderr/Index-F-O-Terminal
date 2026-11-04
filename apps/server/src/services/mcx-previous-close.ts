// ============================================================
// MCX PREVIOUS CLOSE — from our own candles, not the broker quote's close field
// ============================================================
// 5 Nov 2026: CRUDEOIL fell ~740 points on the day while the terminal showed it ~17 points UP. The day change of an
// MCX future was taken from the broker quote (Dhan: last price − net_change; Angel One: the quote's close), and on MCX
// that reference was not the previous session's close. The previous close is now the close of the last five-minute
// candle of the previous MCX session for the same contract, fetched once per contract per day (cached). The broker's
// own figure is logged when it disagrees, so the source of a mismatch stays visible. Null → callers keep the old path.
// ============================================================

import { getLatestSessionWindow, getSessionWindow } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

const istDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** "YYYY-MM-DD HH:mm" in IST: the candle API's request format. */
export function istMinute(ms: number): string {
  const d = new Date(ms + 19_800_000), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * The session before the one the current price belongs to. The price belongs to the latest MCX session that has
 * OPENED (still running, or the last to close — e.g. at 01:30 IST the 23:55 close of the previous evening), so the
 * reference is the session before that one. 5 Nov: keying on the calendar date compared a closed session's last price
 * with its own close after midnight (CRUDEOIL showed ~17 up instead of ~740 down).
 */
export function mcxPreviousSession(now: number): { date: string; open: number; close: number } | null {
  const current = getLatestSessionWindow('MCX', now);
  if (!current) return null;
  for (let i = 1; i <= 14; i++) {
    const date = istDay(current.open - i * 86_400_000), s = getSessionWindow('MCX', date);
    if (s && s.close <= current.open) return { date, open: s.open, close: s.close };
  }
  return null;
}

/** Pure: the close of the last candle that started inside the session, or null. */
export function lastSessionClose(rows: ReadonlyArray<{ timestamp: string; close: number }>, s: { open: number; close: number }): number | null {
  let best: { t: number; close: number } | null = null;
  for (const r of rows) {
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t) || t < s.open || t >= s.close || !(r.close > 0)) continue;
    if (!best || t > best.t) best = { t, close: r.close };
  }
  return best?.close ?? null;
}

/** The previous MCX session's closing price for this futures token (cached for the day), or null when unavailable. */
export async function mcxPreviousClose(provider: MarketDataProvider, token: string, now = Date.now()): Promise<number | null> {
  const s = mcxPreviousSession(now);
  if (!s) return null;
  try {
    return await cached(
      `mcx-prev-close:${token}:${s.date}`,
      6 * 3600,
      async () => {
        const rows = await provider.getHistoricalData({ exchange: 'MCX', segment: 'FO', token, interval: 'FIVE_MINUTE', fromDate: istMinute(s.close - 3 * 3600_000), toDate: istMinute(s.close) });
        return lastSessionClose(Array.isArray(rows) ? rows : [], s);
      },
      (v) => v != null
    );
  } catch (err: any) {
    logger.warn({ token, error: err?.message }, 'MCX previous close: candles unavailable — broker quote close used');
    return null;
  }
}

const warned = new Map<string, number>();
/** Logs (at most hourly per symbol) when the broker's previous close disagrees with the candle close by > 0.5%. */
export function noteMcxCloseMismatch(symbol: string, brokerClose: number, brokerNetChange: number | undefined, candleClose: number, ltp: number, now = Date.now()): void {
  if (!(brokerClose > 0) || Math.abs(brokerClose - candleClose) <= 0.005 * candleClose) return;
  if (now - (warned.get(symbol) ?? 0) < 3600_000) return;
  warned.set(symbol, now);
  logger.warn({ symbol, ltp, brokerClose, brokerNetChange: brokerNetChange ?? null, candleClose }, 'MCX previous close: broker quote disagrees with the previous session\'s last candle — candle close used');
}
