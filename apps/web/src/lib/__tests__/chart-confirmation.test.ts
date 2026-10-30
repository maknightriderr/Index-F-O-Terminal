import { expect, it } from 'vitest';
import { closedChartBars, swingConfirmationIndex } from '../chart-confirmation';
it('excludes the forming bar until its exact close', () => {
  const bars = [{ time: 900 }, { time: 1800 }];
  expect(closedChartBars(bars, 900, 2699)).toEqual([bars[0]]);
  expect(closedChartBars(bars, 900, 2700)).toEqual(bars);
  expect(closedChartBars(bars, NaN, 2700)).toEqual([]);
});
it('confirms a swing only after three closed right-hand bars and timestamps confirmation', () => {
  const bars = [9, 8, 7, 3, 6, 7, 8].map(low => ({ low, high: low + 2 }));
  expect(swingConfirmationIndex(bars.slice(0, 6), 3, 'BULLISH')).toBeNull();
  expect(swingConfirmationIndex(bars, 3, 'BULLISH')).toBe(6);
  expect(swingConfirmationIndex([...bars, { low: 1, high: 2 }], 3, 'BULLISH')).toBe(6);
  expect(swingConfirmationIndex(bars, 0, 'BULLISH')).toBeNull();
});
it('rejects a candidate invalidated within its confirmation window', () => {
  const bars = [9, 8, 7, 3, 6, 7, 1].map(low => ({ low, high: low + 2 }));
  expect(swingConfirmationIndex(bars, 3, 'BULLISH')).toBeNull();
});
