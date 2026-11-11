// Setup E1 (owner, 11 Nov): previous-day value re-entry. Absorption (the engine's own) at the previous day's value-area
// low, a close back inside the value area, stacked imbalance, a confirmation bar; target the previous POC capped at 1.5R.
import { describe, expect, it } from 'vitest';
import { dailyTrend, evaluateDhanSetups, type SetupContext } from '../setups.js';
import { DHAN_PAPER_STRATEGIES } from '../paper.js';
import { contextOf, even, type BarSpec } from './fixture.js';

// Yesterday: twelve bars trading 100-116 with the most volume at 108 (the POC); the value area is roughly 102-114.
const YESTERDAY: BarSpec[] = Array.from({ length: 12 }, () => ({ o: 108, h: 116, l: 100, c: 108, rows: [...even(100, 107, 30, 30), [108, 40, 40] as [number, number, number], ...even(109, 116, 30, 30)] }));
const TODAY: BarSpec[] = [
  { o: 109, h: 109.5, l: 107.5, c: 108 },
  { o: 108, h: 108.5, l: 106.5, c: 107 },
  { o: 107, h: 107.5, l: 105.5, c: 106 },
  { o: 106, h: 106.5, l: 105, c: 105.4 },
  { o: 105.4, h: 106, l: 104.6, c: 105.2 },
  { o: 105.2, h: 105.6, l: 104, c: 104.8, rows: [[104, 20, 120], [105, 30, 40]] }, // sellers absorbed under the previous VAL (105)
  { o: 104.9, h: 107, l: 104.8, c: 106.6, rows: [[104, 10, 40], [105, 130, 10], [106, 60, 10], [107, 40, 5]] }, // back inside, buyers stacked
];
const f = (c: SetupContext, side = 'BULLISH') => evaluateDhanSetups(c).results.find((x) => x.setup === 'F' && x.side === side)!;

describe('Setup E1: previous-day value re-entry', () => {
  it('is paper-traded under its own id', () => {
    expect(DHAN_PAPER_STRATEGIES).toContain('DHAN_E1_VALUE_REENTRY');
  });
  it('signals on absorption at the previous VAL, a close back inside, stacked buying and a confirmation bar', () => {
    const r = f(contextOf(YESTERDAY, TODAY));
    expect(r.strategy).toBe('DHAN_E1_VALUE_REENTRY');
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([['F1_PREVIOUS_VALUE_AREA', true], ['F2_ABSORPTION_AT_PREVIOUS_VAL', true], ['F3_BACK_INSIDE_VALUE', true], ['F4_STACKED_BUY_IMBALANCE', true], ['F5_CONFIRMATION_BAR', true], ['F6_DAILY_TREND_NOT_AGAINST', true], ['F7_TARGET_PREVIOUS_POC_OR_1_5R', true]]);
    expect(r.checks[0].value).toMatchObject({ level: 105, poc: 108 }); // yesterday's VAL and POC, not today's
    expect(r.status).toBe('SIGNAL');
    expect(r.score).toBeNull();
    expect(r.plan).toMatchObject({ entry: 106.6, targetKind: 'R1_5', rr: 1.5 }); // the POC is under 1R away -> the VAH, capped at 1.5R
    expect(r.plan!.sl).toBeLessThan(104); // under the absorption low, not a full ATR away
    expect(r.gates.map((g) => g.id)).toEqual(['VALID_DATA', 'DEFINED_PLAN', 'SESSION_WINDOW']);
  });
  it('F4 needs a stacked imbalance of at least 3 rows (owner, 11 Nov)', () => {
    const two = TODAY.map((b, k) => (k === TODAY.length - 1 ? { ...b, rows: [[104, 10, 40], [105, 130, 10], [106, 60, 10], [107, 5, 5]] as Array<[number, number, number]> } : b));
    expect(f(contextOf(YESTERDAY, two))).toMatchObject({ status: 'NO_SETUP', failed: 'F4_STACKED_BUY_IMBALANCE' });
  });
  it('F6 follows the daily trend; without daily candles it falls back to the 30-minute trend (recorded)', () => {
    expect(f(contextOf(YESTERDAY, TODAY, { dailyTrend: 'BEARISH' }))).toMatchObject({ status: 'NO_SETUP', failed: 'F6_DAILY_TREND_NOT_AGAINST' });
    expect(f(contextOf(YESTERDAY, TODAY, { dailyTrend: 'BULLISH' })).checks[5].value).toEqual({ source: 'DAILY', daily: 'BULLISH' });
    expect(f(contextOf(YESTERDAY, TODAY, { dailyTrend: 'RANGE' })).status).toBe('SIGNAL');
    expect(f(contextOf(YESTERDAY, TODAY)).checks[5].value).toMatchObject({ source: 'M30_FALLBACK' });
    expect(f(contextOf(YESTERDAY, TODAY, { dailyTrend: 'UNKNOWN' })).checks[5].value).toMatchObject({ source: 'M30_FALLBACK' });
  });
  it('dailyTrend: 20-day EMA, rising and price above -> BULLISH; the mirror BEARISH; flat RANGE; short history UNKNOWN', () => {
    const series = (f: (k: number) => number, n = 40) => Array.from({ length: n }, (_, k) => ({ close: f(k) }));
    expect(dailyTrend(series((k) => 100 + k))).toBe('BULLISH');
    expect(dailyTrend(series((k) => 200 - k))).toBe('BEARISH');
    expect(dailyTrend(series(() => 100))).toBe('RANGE');
    expect(dailyTrend([...series((k) => 100 + k), { close: 120 }])).toBe('RANGE'); // EMA still rising, close fell below it
    expect(dailyTrend(series((k) => 100 + k, 24))).toBe('UNKNOWN');
  });
  it('needs the previous day: none in memory, or an incomplete one, stops at F1', () => {
    expect(f(contextOf([], TODAY))).toMatchObject({ status: 'NO_SETUP', failed: 'F1_PREVIOUS_VALUE_AREA' });
    expect(f(contextOf(YESTERDAY, TODAY, { referenceComplete: { previousDay: false, previousWeek: false } }))).toMatchObject({ status: 'NO_SETUP', failed: 'F1_PREVIOUS_VALUE_AREA' });
  });
  it('an absorption well above the previous VAL is not this setup', () => {
    const high = TODAY.map((b) => ({ ...b, o: b.o + 6, h: b.h + 6, l: b.l + 6, c: b.c + 6, rows: b.rows?.map(([p, x, y]) => [p + 6, x, y] as [number, number, number]) }));
    expect(f(contextOf(YESTERDAY, high))).toMatchObject({ status: 'NO_SETUP', failed: 'F2_ABSORPTION_AT_PREVIOUS_VAL' });
  });
  it('the close must be back inside the value area', () => {
    const under = TODAY.map((b) => ({ ...b, o: b.o - 3, h: b.h - 3, l: b.l - 3, c: b.c - 3, rows: b.rows?.map(([p, x, y]) => [p - 3, x, y] as [number, number, number]) }));
    expect(f(contextOf(YESTERDAY, under))).toMatchObject({ status: 'NO_SETUP', failed: 'F3_BACK_INSIDE_VALUE' });
  });
});
