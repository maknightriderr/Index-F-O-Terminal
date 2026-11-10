// Setup E (owner, 9 Nov): pure order flow + footprint — absorption at VAL / POC, delta turns, stacked imbalance,
// an entry bar that closes above the absorption bar; no VWAP / EMA / trend / RVOL / score.
import { describe, expect, it } from 'vitest';
import { evaluateDhanSetups, sessionWindow, type SetupContext } from '../setups.js';
import { contextOf, QUIET, even, type BarSpec } from './fixture.js';

const DAY: BarSpec[] = [
  // The session's volume sits at 104-106 first (POC there), then price falls: the target (POC) pays more than 1R.
  { o: 105, h: 106, l: 104, c: 105, rows: even(104, 106, 300, 300) },
  { o: 105, h: 106, l: 103, c: 104, rows: even(103, 106, 200, 200) },
  { o: 104, h: 104, l: 100, c: 101 },
  { o: 101, h: 102, l: 99, c: 99.5 },
  { o: 99.5, h: 101, l: 98.5, c: 99 },
  { o: 99, h: 100, l: 97, c: 98.5, rows: [[97, 20, 120], [98, 30, 40], [99, 30, 20], [100, 10, 10]] }, // sellers absorbed at 97
  { o: 98.6, h: 101, l: 98, c: 100.5, rows: [[98, 10, 40], [99, 130, 10], [100, 60, 10], [101, 40, 5]] }, // buyers: stacked 99-101
];
const e = (c: SetupContext, side = 'BULLISH') => evaluateDhanSetups(c).results.find((x) => x.setup === 'E' && x.side === side)!;
function reflect(c: SetupContext): SetupContext {
  const fps = c.fps.map((f) => ({ ...f, levels: f.levels.map((l) => ({ price: 250 - l.price, buy: l.sell, sell: l.buy, unclassified: l.unclassified })).sort((a, b) => a.price - b.price), buyVolume: f.sellVolume, sellVolume: f.buyVolume, delta: f.delta == null ? null : -f.delta, deltaPct: f.deltaPct == null ? null : -f.deltaPct, buyImbalances: f.sellImbalances, sellImbalances: f.buyImbalances, poc: f.poc == null ? null : 250 - f.poc, vah: f.val == null ? null : 250 - f.val, val: f.vah == null ? null : 250 - f.vah, high: f.low == null ? null : 250 - f.low, low: f.high == null ? null : 250 - f.high, close: f.close == null ? null : 250 - f.close }));
  const bar = (b: SetupContext['bars'][number]) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close });
  return { ...c, bars: c.bars.map(bar), fps, daily: c.daily.map(bar) };
}

describe('Setup E: pure order flow', () => {
  it('signals on absorption at the value-area low, delta turning, stacked buy imbalance and an entry bar above it', () => {
    const r = e(contextOf(QUIET, DAY));
    expect(r.strategy).toBe('DHAN_E_ORDER_FLOW');
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([['E1_ABSORPTION', true], ['E2_AT_VALUE_LOW_OR_POC', true], ['E3_DELTA_TURNS_UP', true], ['E4_STACKED_BUY_IMBALANCE', true], ['E5_ENTRY_BAR', true], ['E6_TARGET_POC_OR_VAH', true]]);
    expect(r.status).toBe('SIGNAL');
    expect(r.score).toBeNull();
    expect(r.plan!.entry).toBe(100.5);
    expect(r.plan!.sl).toBeLessThan(97);
    expect(r.plan!.target).toBeGreaterThan(100.5);
    expect(['POC', 'VAH']).toContain(r.plan!.targetKind);
    expect(r.gates.map((g) => g.id)).toEqual(['VALID_DATA', 'DEFINED_PLAN', 'SESSION_WINDOW']); // nothing else: no score, VWAP, trend
  });
  it('distribution: the reflected day signals the bearish mirror', () => {
    const r = e(reflect(contextOf(QUIET, DAY)), 'BEARISH');
    expect(r.status).toBe('SIGNAL');
    expect(r.plan!.entry).toBe(149.5);
    expect(r.plan!.sl).toBeGreaterThan(153);
  });
  it('no entry bar yet -> stops at E1 (the absorption bar is the newest bar)', () => {
    expect(e(contextOf(QUIET, DAY.slice(0, 6)))).toMatchObject({ status: 'NO_SETUP', failed: 'E1_ABSORPTION' });
  });
  it('an incomplete footprint after the absorption refuses (never a guess)', () => {
    const c = contextOf(QUIET, DAY);
    c.fps[c.fps.length - 1] = { ...c.fps[c.fps.length - 1], incomplete: true, delta: null };
    expect(e(c).status).not.toBe('SIGNAL');
  });
  it('refuses when the absorption and confirmation straddle a missing interval', () => {
    const c = contextOf(QUIET, DAY);
    c.bars.at(-1)!.time += 900_000;
    c.fps.at(-1)!.barTime += 900_000;
    expect(e(c)).toMatchObject({ status: 'NO_TRADE', gates: expect.arrayContaining([{ id: 'VALID_DATA', ok: false }]) });
  });
});

describe('Setup E: 2-row stacked imbalance (owner, 9 Nov)', () => {
  it('two consecutive buy-imbalance rows are enough; one is not', () => {
    // Entry bar: buy imbalances at 100 and 101 only (99's buy is not 3x the sell below it).
    const two: BarSpec[] = [...DAY.slice(0, 6), { o: 98.6, h: 101, l: 98, c: 100.5, rows: [[98, 10, 40], [99, 60, 30], [100, 130, 10], [101, 60, 5]] }];
    const r = e(contextOf(QUIET, two));
    expect(r.checks.find((c) => c.id === 'E4_STACKED_BUY_IMBALANCE')).toMatchObject({ ok: true, value: { rows: 2 } });
    const one: BarSpec[] = [...DAY.slice(0, 6), { o: 98.6, h: 101, l: 98, c: 100.5, rows: [[98, 10, 40], [99, 60, 30], [100, 130, 10], [101, 20, 5]] }];
    expect(e(contextOf(QUIET, one)).failed).toBe('E4_STACKED_BUY_IMBALANCE');
  });
});

describe('Setup E admission (owner, 10 Nov)', () => {
  it('a target closer than 1R is not a signal (10 Nov: CRUDEOILM R:R 0.04)', () => {
    const r = e(contextOf(QUIET, DAY));
    expect(r.status).toBe('SIGNAL');
    expect(r.plan!.rr).toBeGreaterThanOrEqual(1);
    // Same day, but the entry bar closes far above the absorption low: POC / VAH no longer pay 1R.
    const far: BarSpec[] = [...DAY.slice(0, 6), { o: 98.6, h: 101.9, l: 98, c: 101.8, rows: [[98, 10, 40], [99, 130, 10], [100, 60, 10], [101, 40, 5]] }];
    const x = e(contextOf(QUIET, far));
    if (x.status === 'SIGNAL') expect(x.plan!.rr).toBeGreaterThanOrEqual(1); else expect(x.failed).toBe('E6_TARGET_POC_OR_VAH');
  });
  it('MCX: a bar closing inside the last 45 minutes is NO_TRADE, never a signal; NSE is unchanged', () => {
    const c = contextOf(QUIET, DAY), close = c.bars.at(-1)!.time + 900_000;
    const late = e({ ...c, exchange: 'MCX', sessionClose: close + 30 * 60_000 });
    expect(late.status).toBe('NO_TRADE');
    expect(late.gates.find((g) => g.id === 'SESSION_WINDOW')).toMatchObject({ ok: false, value: 'AFTER_CUTOFF' });
    expect(e({ ...c, exchange: 'MCX', sessionClose: close + 3 * 3_600_000 }).status).toBe('SIGNAL');
    expect(sessionWindow('MCX', close)).toBe('MCX_SESSION'); // no close given: as before
  });
  it('the bearish target is labelled from the real profile (VAL, not the mirrored VAH)', () => {
    const r = e(reflect(contextOf(QUIET, DAY)), 'BEARISH');
    expect(['POC', 'VAL']).toContain(r.plan!.targetKind);
  });
});
