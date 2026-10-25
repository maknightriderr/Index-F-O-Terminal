import { detectFairValueGaps, detectOrderBlocks } from '@fno/analytics';

export interface ZoneCandle { time: number; open: number; high: number; low: number; close: number }
export interface ChartZone {
  id: string;
  kind: 'OB' | 'FVG';
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  /** Starts at confirmation, never at the earlier origin candle. */
  start: number;
  end: number;
  active: boolean;
  state: 'FRESH' | 'FIRST_TOUCH' | 'MITIGATED' | 'OPEN' | 'TOUCHED';
}

/** Chart analysis only: the existing detectors on this chart's own closed candles.
 * No quote, option premium, other timeframe or spot/futures series is mixed in.
 * Reject malformed history as a whole rather than joining across missing bars.
 */
export function buildChartZones(bars: readonly ZoneCandle[], intervalSeconds: number, nowSeconds: number): { zones: ChartZone[]; reason: string | null } {
  if (!(intervalSeconds > 0) || !Number.isFinite(intervalSeconds) || !Number.isFinite(nowSeconds)) return { zones: [], reason: 'Invalid chart interval or clock.' };
  if (bars.some((b, i) => ![b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) || b.time <= 0 || Math.min(b.open, b.high, b.low, b.close) <= 0 || b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close) || (i > 0 && b.time <= bars[i - 1].time))) return { zones: [], reason: 'Invalid or unordered candle history; zones withheld.' };
  const closed = bars.filter((b) => b.time + intervalSeconds <= nowSeconds);
  if (closed.length < 3) return { zones: [], reason: 'At least three closed candles are needed.' };
  const lastTime = closed[closed.length - 1].time;
  const zones: ChartZone[] = detectOrderBlocks(closed).map((b) => ({
    id: `OB:${closed[b.blockIndex].time}:${b.type}`, kind: 'OB', direction: b.type,
    top: b.top, bottom: b.bottom, start: closed[b.displacementIndex].time,
    end: b.mitigatedIndex == null ? lastTime : closed[b.mitigatedIndex].time,
    active: b.mitigatedIndex == null, state: b.state,
  }));
  for (const g of detectFairValueGaps(closed.map((b) => b.high), closed.map((b) => b.low))) {
    const confirmation = g.atIndex + 1;
    // Same touch-based definition used by the shared detector, including exact boundary touches.
    const touch = closed.findIndex((b, index) => index > confirmation && b.high >= g.bottom && b.low <= g.top);
    zones.push({ id: `FVG:${closed[confirmation].time}:${g.type}`, kind: 'FVG', direction: g.type,
      top: g.top, bottom: g.bottom, start: closed[confirmation].time,
      end: touch < 0 ? lastTime : closed[touch].time, active: !g.filled, state: g.filled ? 'TOUCHED' : 'OPEN' });
  }
  return { zones: zones.filter((z) => z.top > z.bottom).sort((a, b) => b.start - a.start), reason: null };
}

export function selectChartZones(zones: readonly ChartZone[], ob: boolean, fvg: boolean, history: boolean): ChartZone[] {
  // Keep each family visible; one family's dense history must not crowd out the other.
  return (['OB', 'FVG'] as const).flatMap((kind) => zones.filter((z) => z.kind === kind && (kind === 'OB' ? ob : fvg) && (history || z.active)).slice(0, 6));
}
