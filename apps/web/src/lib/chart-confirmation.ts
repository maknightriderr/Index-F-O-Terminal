/** Chart annotations use closed bars only; OHLC timestamps identify the bar's start. */
export function closedChartBars<T extends { time: number }>(bars: readonly T[], intervalSeconds: number, nowSeconds: number): T[] {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0 || !Number.isFinite(nowSeconds)) return [];
  return bars.filter((b) => Number.isFinite(b.time) && b.time + intervalSeconds <= nowSeconds);
}

/** A three-right-bar swing becomes knowable on i+3, not on its origin candle.
 * Return its confirmation index so callers cannot paint a historical entry arrow at i. */
export function swingConfirmationIndex(bars: readonly { high: number; low: number }[], i: number, direction: 'BULLISH' | 'BEARISH'): number | null {
  const window = 3;
  if (!Number.isInteger(i) || i < window || i + window >= bars.length) return null;
  const neighbourhood = bars.slice(i - window, i + window + 1);
  if (neighbourhood.some(b => !Number.isFinite(b.high) || !Number.isFinite(b.low) || b.high < b.low)) return null;
  const extreme = direction === 'BULLISH' ? Math.min(...neighbourhood.map(b => b.low)) : Math.max(...neighbourhood.map(b => b.high));
  const valid = direction === 'BULLISH' ? bars[i].low <= extreme * 1.001 : bars[i].high >= extreme * .999;
  return valid ? i + window : null;
}
