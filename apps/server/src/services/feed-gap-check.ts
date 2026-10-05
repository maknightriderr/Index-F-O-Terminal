// ============================================================
// FEED GAP CHECK for open paper trades (Phase 5)
// ============================================================
// When the tick feed comes back after a gap (reconnect, auth refresh, a
// silent spell), an open trade's option may have reached its SL or target
// while nobody was listening. The gap is backfilled with the contract's
// 1-minute bars (REST) and resolved WITHOUT assuming anything:
//   LEVEL_TOUCHED          the first level reached is known → closed at that
//                          level through the normal price check
//   NO_TOUCH               nothing happened → nothing to do
//   FILL_UNCERTAIN         SL and target in the same minute → recorded,
//                          the trade is NOT closed and NOT cancelled
//   MISSED_TOUCH_POSSIBLE  the bars do not cover the gap (or could not be
//                          fetched) → recorded, nothing assumed
// The window is clamped to the exchange session (getLatestSessionWindow):
// minutes after the close are not a gap.
// ============================================================

import { getLatestSessionWindow, type Exchange, type OHLCV } from '@fno/shared';
import { resolveGapTouch, type GapBar, type GapOutcome } from '../lib/feed-freshness.js';

export interface GapCheckWatch {
  underlying: string;
  exchange: Exchange;
  mode: string;
  token: string;
  stopLoss: number;
  target: number;
}

export interface GapCheckResult {
  outcome: GapOutcome | 'NO_GAP_IN_SESSION';
  detail: string;
  /** The level the trade was closed at (LEVEL_TOUCHED only). */
  resolvedAt: number | null;
  from: number;
  to: number;
}

/** IST wall-clock "YYYY-MM-DD HH:mm" (the broker's historical-data format), via the exchange time zone — never the server's. */
export function istMinute(t: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * One gap of one open trade. Dependencies are injected (fetch the 1-minute
 * bars, close at a price through the normal check, record the outcome) so the
 * decision is tested without a broker.
 */
export async function runGapCheck(args: {
  gap: { from: number; to: number };
  watch: GapCheckWatch;
  fetchMinuteBars: (from: number, to: number) => Promise<OHLCV[]>;
  closeAt: (price: number) => Promise<unknown>;
  record: (r: GapCheckResult) => Promise<void> | void;
}): Promise<GapCheckResult> {
  const { watch } = args;
  const w = getLatestSessionWindow(watch.exchange, args.gap.to);
  const from = Math.max(args.gap.from, w?.open ?? args.gap.from);
  const to = Math.min(args.gap.to, w?.close ?? args.gap.to);
  if (!w || to <= from) {
    const r: GapCheckResult = { outcome: 'NO_GAP_IN_SESSION', detail: 'The gap lies outside the exchange session.', resolvedAt: null, from: args.gap.from, to: args.gap.to };
    await args.record(r);
    return r;
  }
  let bars: GapBar[] = [];
  let fetchError: string | null = null;
  try {
    bars = (await args.fetchMinuteBars(from, to)).map((b) => ({ time: Date.parse(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close })).filter((b) => Number.isFinite(b.time));
  } catch (err: any) {
    fetchError = err?.message ?? String(err);
  }
  let result: GapCheckResult;
  if (fetchError != null) {
    result = { outcome: 'MISSED_TOUCH_POSSIBLE', detail: `The gap could not be backfilled (${fetchError}) — SL ${watch.stopLoss} / target ${watch.target} may have been reached; nothing assumed.`, resolvedAt: null, from, to };
  } else {
    const g = resolveGapTouch({
      bars,
      from,
      to,
      levels: [
        { name: 'SL', price: watch.stopLoss, side: 'BELOW' },
        { name: 'TARGET', price: watch.target, side: 'ABOVE' },
      ],
    });
    result = { outcome: g.outcome, detail: g.detail, resolvedAt: g.outcome === 'LEVEL_TOUCHED' ? g.level!.price : null, from, to };
    // Sequence established: resolve normally, at the level that was reached first.
    if (g.outcome === 'LEVEL_TOUCHED') await args.closeAt(g.level!.price);
  }
  await args.record(result);
  return result;
}
