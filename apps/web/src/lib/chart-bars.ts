// ============================================================
// CHART INTERVALS AND RANGES — candle size and visible window are separate
// ============================================================
// The chart used to offer one row of buttons that mixed both ideas: "15m", "1D" and "5D" all loaded 15-minute
// candles (1D/5D only meant "how many days"), and "1H"/"1M" both loaded hourly candles. With fitContent() showing
// everything, three buttons drew the same picture. Now an INTERVAL picks the candle size (one per broker interval,
// plus weekly built from daily) and a RANGE picks how much of the loaded history is in view.
// ============================================================

import type { CandleInterval } from '@fno/shared';

export type ChartInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '1D' | '1W';
export type ChartRange = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | 'ALL';

export const CHART_INTERVALS: ChartInterval[] = ['1m', '3m', '5m', '15m', '30m', '1H', '1D', '1W'];
export const CHART_RANGES: ChartRange[] = ['1D', '5D', '1M', '3M', '6M', '1Y', 'ALL'];

/**
 * Broker interval and how many calendar days to load. Every window stays inside Angel One's per-request limit for
 * that interval (1m 30 d, 3m 60 d, 5m 100 d, 15m/30m 200 d, 1H 400 d, 1D 2000 d), so one request per load.
 */
export const INTERVAL_CONFIG: Record<ChartInterval, { broker: CandleInterval; days: number; seconds: number; refreshMs: number; defaultRange: ChartRange }> = {
  '1m': { broker: 'ONE_MINUTE', days: 7, seconds: 60, refreshMs: 60_000, defaultRange: '1D' },
  '3m': { broker: 'THREE_MINUTE', days: 14, seconds: 180, refreshMs: 60_000, defaultRange: '1D' },
  '5m': { broker: 'FIVE_MINUTE', days: 30, seconds: 300, refreshMs: 60_000, defaultRange: '5D' },
  '15m': { broker: 'FIFTEEN_MINUTE', days: 60, seconds: 900, refreshMs: 120_000, defaultRange: '5D' },
  '30m': { broker: 'THIRTY_MINUTE', days: 120, seconds: 1800, refreshMs: 180_000, defaultRange: '1M' },
  '1H': { broker: 'ONE_HOUR', days: 240, seconds: 3600, refreshMs: 300_000, defaultRange: '1M' },
  '1D': { broker: 'ONE_DAY', days: 730, seconds: 86400, refreshMs: 900_000, defaultRange: '6M' },
  '1W': { broker: 'ONE_DAY', days: 1825, seconds: 604800, refreshMs: 900_000, defaultRange: 'ALL' },
};

const RANGE_DAYS: Record<Exclude<ChartRange, 'ALL'>, number> = { '1D': 1, '5D': 5, '1M': 31, '3M': 92, '6M': 183, '1Y': 366 };

/** Ranges that make sense for an interval: at least ~10 candles and no wider than the loaded history. */
export function rangesFor(interval: ChartInterval): ChartRange[] {
  const { days, seconds } = INTERVAL_CONFIG[interval];
  return CHART_RANGES.filter((r) => r === 'ALL' || (RANGE_DAYS[r] <= days && (RANGE_DAYS[r] * 86400) / seconds >= 10));
}

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }

/**
 * The first bar time to show for a range, counted in TRADING sessions rather than calendar days, so "1D" after a
 * weekend still shows Friday's session and "5D" shows five sessions. null = show everything.
 */
export function rangeStart(bars: readonly Bar[], range: ChartRange): number | null {
  if (range === 'ALL' || bars.length === 0) return null;
  const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  if (range === '1D' || range === '5D') {
    const want = range === '1D' ? 1 : 5;
    const days: string[] = [];
    for (let i = bars.length - 1; i >= 0; i--) {
      const d = istDay(bars[i].time);
      if (days[days.length - 1] !== d) {
        if (days.length === want) return bars[i + 1].time;
        days.push(d);
      }
    }
    return null;
  }
  const from = bars[bars.length - 1].time - RANGE_DAYS[range] * 86400;
  return from <= bars[0].time ? null : from;
}

/** Weekly candles (Monday-start, IST) from daily candles. */
export function aggregateWeekly(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const d = new Date((b.time + 19800) * 1000);
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) / 1000) - 19800;
    const last = out[out.length - 1];
    if (last && last.time === monday) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      if (b.volume != null) last.volume = (last.volume ?? 0) + b.volume;
    } else out.push({ time: monday, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  }
  return out;
}

/** Candles from the API: sorted, de-duplicated by time, invalid rows dropped. */
export function cleanBars(rows: ReadonlyArray<{ timestamp: string | number; open: number; high: number; low: number; close: number; volume?: number }>): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const r of rows) {
    const time = Math.floor(new Date(r.timestamp).getTime() / 1000);
    if (!Number.isFinite(time) || ![r.open, r.high, r.low, r.close].every((x) => Number.isFinite(x) && x > 0)) continue;
    byTime.set(time, { time, open: r.open, high: r.high, low: r.low, close: r.close, volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? r.volume : undefined });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
