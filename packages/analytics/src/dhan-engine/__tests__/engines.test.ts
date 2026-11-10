// Dhan engine v2, phase 2: every formula against a hand-computed fixture (values worked out in the comments),
// plus property checks (CVD additivity, value area >= 70%).
import { describe, expect, it } from 'vitest';
import type { FootprintBar } from '../../order-flow/index.js';
import {
  analyzeStructure, candleSums, classifyTimeframe, combineRegime, confirmedPivots, cvdDivergences, cvdSeries, detectAbsorption, detectExhaustion,
  detectFailedBreakouts, detectSweeps, diagonalImbalances, fairValueGaps, profileFromFootprints, profileFromRows, quantile, referenceLevels,
  relativeVolume, vwapFromSums, vwapSeries, type EngineBar, type TimeframeInputs,
} from '../index.js';

const fp = (barTime: number, levels: Array<[number, number, number, number?]>, extra: Partial<FootprintBar> = {}): FootprintBar => {
  const lv = levels.map(([price, buy, sell, unclassified = 0]) => ({ price, buy, sell, unclassified }));
  const buy = lv.reduce((a, l) => a + l.buy, 0), sell = lv.reduce((a, l) => a + l.sell, 0), unc = lv.reduce((a, l) => a + l.unclassified, 0);
  return {
    barTime, barMs: 900000, deltaMode: 'INFERRED', trades: lv.length, volume: buy + sell + unc, buyVolume: buy, sellVolume: sell, unclassifiedVolume: unc,
    delta: buy - sell, deltaPct: (buy - sell) / Math.max(1, buy + sell), levels: lv, poc: null, vah: null, val: null, buyImbalances: 0, sellImbalances: 0,
    high: Math.max(...lv.map((l) => l.price)), low: Math.min(...lv.map((l) => l.price)), close: lv[lv.length - 1].price, priceStep: 1, ...extra,
  };
};
const bar = (time: number, high: number, low: number, close: number, open = close): EngineBar => ({ time, open, high, low, close });

describe('footprint v2: diagonal + stacked imbalance (5.1 / 5.2)', () => {
  // rows (price: ask/buy, bid/sell): 100: 10/40, 101: 150/20, 102: 160/10, 103: 120/30, 104: 5/200. Volume 745, 5 rows
  // -> default min row volume ceil(0.25 * 745 / 5) = 38.
  // buy ratios ask(P)/bid(P-1): 101: 150/40 = 3.75, 102: 160/20 = 8, 103: 120/10 = 12, 104: 5/30 -> no; 100: no row below.
  // sell ratios bid(P)/ask(P+1): 103: 30/5 = 6 but 30 < 38 (min-volume filter) -> no; 104: no row above.
  const f = fp(0, [[100, 10, 40], [101, 150, 20], [102, 160, 10], [103, 120, 30], [104, 5, 200]]);
  it('compares diagonally, filters thin rows, finds the 3-row buy stack', () => {
    const r = diagonalImbalances(f);
    expect(r.status).toBe('ESTIMATED');
    expect(r.minLevelVolume).toBe(38);
    expect(r.rows.map((x) => x.buyRatio)).toEqual([null, 3.75, 8, 12, 0.1667]);
    expect(r.rows.map((x) => x.sellRatio)).toEqual([0.2667, 0.125, 0.0833, 6, null]);
    expect(r.rows.filter((x) => x.buyImbalance).map((x) => x.price)).toEqual([101, 102, 103]);
    expect(r.sellImbalances).toBe(0);
    expect(r.stacks).toEqual([{ side: 'BUY', low: 101, high: 103, rows: 3 }]);
  });
  it('never divides by an empty row, and two rows are not a stack', () => {
    const r = diagonalImbalances(fp(0, [[100, 10, 0], [101, 150, 20], [102, 160, 10], [103, 120, 30], [104, 5, 200]]));
    expect(r.rows[1].buyRatio).toBeNull();
    expect(r.buyImbalances).toBe(2);
    expect(r.stacks).toEqual([]);
  });
  it('withholds everything on an incomplete, low-classified or empty bar', () => {
    expect(diagonalImbalances({ ...f, incomplete: true })).toMatchObject({ status: 'INCOMPLETE', rows: [], stacks: [] });
    expect(diagonalImbalances({ ...f, delta: null })).toMatchObject({ status: 'INCOMPLETE', reason: 'LOW_CLASSIFIED_SHARE' });
    expect(diagonalImbalances({ ...f, deltaMode: 'UNAVAILABLE', levels: [] }).status).toBe('UNAVAILABLE');
  });
  it('honours an instrument min-volume filter', () => {
    expect(diagonalImbalances(f, { minLevelVolume: 155 }).rows.filter((x) => x.buyImbalance).map((x) => x.price)).toEqual([102]);
  });
});

describe('market structure (Part 6)', () => {
  // pivot high at 2 (13), pivot low at 4 (7), pivot high at 7 (14, HH). Tick 0.1, buffer 2 ticks = 0.2.
  const bars = [bar(0, 10, 8, 9), bar(1, 11, 9, 10), bar(2, 13, 10, 12), bar(3, 12, 9.5, 10), bar(4, 11, 7, 8), bar(5, 12, 8, 11), bar(6, 12.5, 8.5, 12), bar(7, 14, 11, 13.5), bar(8, 13.8, 12, 12.5), bar(9, 13, 11.5, 12), bar(10, 12, 6, 6.7)];
  it('confirms 2/2 pivots only once the right-hand bars have closed', () => {
    expect(confirmedPivots(bars).map((p) => [p.kind, p.index, p.price, p.confirmedAt, p.label])).toEqual([['HIGH', 2, 13, 4, null], ['LOW', 4, 7, 6, null], ['HIGH', 7, 14, 9, 'HH']]);
  });
  it('breaks on a close beyond the swing by the tick buffer: first break is a CHoCH, then BOS / CHoCH by trend', () => {
    const s = analyzeStructure(bars, 0.1);
    expect(s.breaks.map((b) => [b.type, b.side, b.index, b.level])).toEqual([['CHOCH', 'BULLISH', 7, 13], ['CHOCH', 'BEARISH', 10, 7]]);
    expect(s.trend).toBe('BEARISH');
    // 13.1 clears 13 by one tick only: a close that does not clear the buffer is no break.
    const weak = bars.map((b, i) => (i === 7 ? { ...b, close: 13.1 } : b));
    expect(analyzeStructure(weak, 0.1).breaks.filter((b) => b.side === 'BULLISH')).toEqual([]);
  });
  it('sweeps: beyond a level, back inside, flow attached; acceptance and small wicks are not sweeps', () => {
    const lv = [{ price: 100, side: 'LOW' as const, kind: 'PDL' as const, knownFrom: 0 }];
    const b = [bar(0, 101, 100.5, 100.8), bar(1, 100.9, 99.7, 100.3)];
    expect(detectSweeps(b, lv, 0.05, { delta: [-50, 80] })).toMatchObject([{ side: 'BULLISH', index: 1, reclaimIndex: 1, extreme: 99.7, flow: 'SUPPORTING', confirmed: true }]);
    expect(detectSweeps(b, lv, 0.05, { delta: [-50, -80] })[0]).toMatchObject({ flow: 'NOT_SUPPORTING', confirmed: false });
    expect(detectSweeps(b, lv, 0.05)[0]).toMatchObject({ flow: 'UNAVAILABLE', confirmed: false });
    expect(detectSweeps([b[0], { ...b[1], close: 99.85 }], lv, 0.05)).toEqual([]); // closed beyond by the buffer: accepted
    expect(detectSweeps([b[0], { ...b[1], low: 99.95 }], lv, 0.05)).toEqual([]); // under the buffer: just a wick
  });
  it('failed breakout and FVG', () => {
    const lv = [{ price: 100, side: 'HIGH' as const, kind: 'SWING' as const, knownFrom: 0 }];
    expect(detectFailedBreakouts([bar(0, 99.8, 99, 99.5), bar(1, 100.4, 99.6, 100.2), bar(2, 100.3, 99.9, 100.05), bar(3, 100.1, 99.5, 99.9)], lv, 0.05)).toMatchObject([{ side: 'BEARISH', breakIndex: 1, failIndex: 3 }]);
    expect(fairValueGaps([bar(0, 10, 9, 9.5), bar(1, 12, 10, 11.8), bar(2, 13, 11, 12.5), bar(3, 13, 11.5, 12), bar(4, 12, 10.8, 11)])).toEqual([{ side: 'BULLISH', bottom: 10, top: 11, index: 1, filledAt: 4 }]);
  });
  it('reference levels: previous day / week and the opening range', () => {
    const day = 86_400_000, mon = Date.parse('2026-11-09T03:45:00Z'); // Monday 09:15 IST
    const daily = [bar(mon - 7 * day, 110, 100, 105), bar(mon - 5 * day, 120, 102, 118), bar(mon - 3 * day, 119, 95, 99)]; // Mon, Wed, Fri of last week
    const session = [bar(mon, 101, 99, 100), bar(mon + 300000, 102, 98.5, 101), bar(mon + 900000, 105, 100, 104)];
    expect(referenceLevels(daily, session, mon, 15)).toEqual({ pdh: 119, pdl: 95, pwh: 120, pwl: 95, orHigh: 102, orLow: 98.5 });
  });
});

describe('CVD (4.3)', () => {
  const T = Date.parse('2026-11-09T04:00:00Z'), D = 86_400_000;
  const mk = (t: number, delta: number | null) => ({ ...bar(t, 1, 0, 0.5), delta });
  it('adds valid deltas, marks the rest of the session INCOMPLETE after a gap, resets per session', () => {
    const p = cvdSeries([mk(T, 100), mk(T + 1, -30), mk(T + 2, null), mk(T + 3, 50), mk(T + D, 20)], (t) => String(Math.floor((t - T) / D)), { rollingBars: 2, momentumBars: 1 });
    expect(p.map((x) => [x.cvd, x.status, x.rolling, x.momentum])).toEqual([[100, 'ESTIMATED', null, null], [70, 'ESTIMATED', 70, -30], [70, 'INCOMPLETE', null, null], [120, 'INCOMPLETE', null, null], [20, 'ESTIMATED', null, null]]);
  });
  it('is additive: the session CVD equals the sum of its deltas', () => {
    const ds = Array.from({ length: 200 }, (_, i) => ((i * 7919) % 201) - 100);
    const p = cvdSeries(ds.map((d, i) => mk(T + i, d)), () => 's');
    expect(p.at(-1)!.cvd).toBe(ds.reduce((a, b) => a + b, 0));
  });
  it('bullish divergence: lower low in price, higher CVD, read only at confirmed pivots', () => {
    const hl: Array<[number, number]> = [[101, 99], [100, 97], [98, 95], [99, 96], [100, 97], [99, 96.5], [97, 94], [98, 95], [99, 96]];
    const deltas = [0, -100, -100, 50, 50, 0, -20, 30, 10]; // CVD: 0 -100 -200 -150 -100 -100 -120 -90 -80
    const bars = hl.map(([h, l], i) => ({ ...bar(T + i, h, l, (h + l) / 2), delta: deltas[i] }));
    const pts = cvdSeries(bars, () => 's');
    expect(cvdDivergences(bars, pts)).toEqual([{ side: 'BULLISH', first: 2, second: 6, knownAt: 8, price: [95, 94], cvd: [-200, -120] }]);
    // A gap before the second pivot makes the CVD incomplete: no divergence is claimed.
    const gapped = bars.map((b, i) => (i === 4 ? { ...b, delta: null } : b));
    expect(cvdDivergences(gapped, cvdSeries(gapped, () => 's'))).toEqual([]);
  });
});

describe('volume profile (Part 7)', () => {
  it('POC, 70% value area grown to the larger neighbour', () => {
    // 100:10 101:30 102:50 103:20 104:5 (115). From 102 (50): 101 (30) > 103 (20) -> 80 < 80.5; then 103 (20) > 100 (10) -> 100.
    expect(profileFromRows([[100, 10], [101, 30], [102, 50], [103, 20], [104, 5]].map(([price, volume]) => ({ price, volume })))).toMatchObject({ total: 115, poc: 102, val: 101, vah: 103, valueAreaShare: 0.8696 });
  });
  it('HVN / LVN on 3-row smoothed volume', () => {
    const v = [10, 20, 100, 30, 10, 2, 2, 2, 10, 60, 5]; // smoothed peak 50 at 102 (>= 1.5 x mean 22.8); trough 2 at 106 (<= 0.5 x mean)
    expect(profileFromRows(v.map((volume, i) => ({ price: 100 + i, volume })))).toMatchObject({ hvn: [102], lvn: [106] });
  });
  it('value area always holds >= 70% (property)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 300; k++) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, i) => ({ price: i, volume: Math.floor(rnd() * 1000) }));
      const p = profileFromRows(rows);
      if (p.total > 0) expect(p.valueAreaShare!).toBeGreaterThanOrEqual(0.7);
    }
  });
  it('merges one contract\'s bars, labels incomplete / partial coverage, refuses mixed steps or contracts', () => {
    const a = fp(0, [[100, 10, 10], [101, 30, 0]], { sourceInstrument: 'X' }), b = fp(1, [[101, 10, 10], [102, 5, 0]], { sourceInstrument: 'X' });
    expect(profileFromFootprints([a, b])).toMatchObject({ status: 'VERIFIED', rows: [{ price: 100, volume: 20 }, { price: 101, volume: 50 }, { price: 102, volume: 5 }], poc: 101, bars: 2 });
    expect(profileFromFootprints([a, { ...b, unreconciledVolume: 5 }]).status).toBe('ESTIMATED');
    expect(profileFromFootprints([a, { ...b, incomplete: true }]).status).toBe('INCOMPLETE');
    expect(profileFromFootprints([a, { ...b, priceStep: 2 }]).reason).toBe('MIXED_PRICE_STEP');
    expect(profileFromFootprints([a, { ...b, sourceInstrument: 'Y' }]).reason).toBe('MIXED_CONTRACTS');
  });
});

describe('VWAP and RVOL (Part 8)', () => {
  it('trade VWAP with volume-weighted SD bands', () => {
    // (100 x 10) + (102 x 30): VWAP 4060/40 = 101.5; variance 412120/40 - 101.5^2 = 0.75 -> SD 0.866.
    const s = { pv: 4060, v: 40, p2v: 412120 };
    expect(vwapFromSums(s, 'TRADES')).toMatchObject({ status: 'ESTIMATED', vwap: 101.5, sd: 0.866, bands: { upper1: 102.366, lower1: 100.634 } });
    // Sampled (9 Nov): 40 observed of 60 (67%) stands as a sample; 40 of 300 (13%) is below the 15% floor.
    expect(vwapFromSums(s, 'TRADES', 20).status).toBe('ESTIMATED');
    expect(vwapFromSums(s, 'TRADES', 260).status).toBe('INCOMPLETE');
    expect(vwapFromSums(s, 'CANDLES').status).toBe('APPROXIMATION');
    expect(vwapFromSums({ pv: 0, v: 0, p2v: 0 }, 'TRADES').status).toBe('UNAVAILABLE');
  });
  it('reclaim, slope and distance, reset per session', () => {
    const tr = (p: number, q: number) => ({ pv: p * q, v: q, p2v: p * p * q });
    const pts = vwapSeries([{ time: 0, high: 100.2, low: 99.4, close: 99.5, sums: tr(100, 10) }, { time: 1, high: 101.2, low: 99.6, close: 101, sums: tr(101, 10) }], () => 's', 'TRADES', 2, 1);
    expect(pts.map((p) => p.vwap)).toEqual([100, 100.5]);
    expect(pts[1]).toMatchObject({ event: { type: 'RECLAIM', side: 'BULLISH' }, slopeAtr: 0.25, distanceAtr: 0.25 });
    expect(candleSums({ high: 12, low: 9, close: 9, volume: 2 })).toEqual({ pv: 20, v: 2, p2v: 200 });
  });
  it('RVOL against the same interval of 20 sessions; fewer is UNAVAILABLE', () => {
    expect(relativeVolume(160, Array(20).fill(100))).toEqual({ status: 'VERIFIED', rvol: 1.6, sessions: 20, breakout: true });
    expect(relativeVolume(160, Array(19).fill(100)).status).toBe('UNAVAILABLE');
    expect(quantile([1, 2, 3, 4, 5], 0.8)).toBeCloseTo(4.2);
  });
});

describe('absorption (5.3) and exhaustion (5.4)', () => {
  // 10 baseline bars x 5 rows of sell 10 / buy 10 -> 50 observations, 80th percentile 10.
  const baseline = Array.from({ length: 10 }, (_, i) => fp(i, [[98, 10, 10], [99, 10, 10], [100, 10, 10], [101, 10, 10], [102, 10, 10]]));
  const bars0 = baseline.map((_, i) => bar(i, 102, 98, 100));
  // Bar 10: sells 120 vs buys 70; the 99 row took 80 sold (>= 10), the low is 99 (progress 0), close 100.5 within 0.5 ATR (ATR 4).
  const abs = fp(10, [[99, 20, 80], [100, 30, 30], [101, 20, 10]]);
  const after = fp(11, [[100, 8, 2], [101, 8, 2]]);
  it('confirms bullish absorption when a later bar closes above the absorption bar', () => {
    const ev = detectAbsorption([...baseline, abs, after], 4, [...bars0, bar(10, 101, 99, 100.5), bar(11, 101.5, 99.5, 101.2)]);
    expect(ev).toEqual([{ side: 'BULLISH', index: 10, zone: 99, zoneVolume: 80, threshold: 10, progressAtr: 0, state: 'CONFIRMED', resolvedAt: 11 }]);
  });
  it('fails it when price trades below the bar first; stays a candidate while unresolved; needs a 50-observation baseline', () => {
    const fail = detectAbsorption([...baseline, abs, after], 4, [...bars0, bar(10, 101, 99, 100.5), bar(11, 101.5, 98.9, 101.2)]);
    expect(fail[0]).toMatchObject({ state: 'FAILED', resolvedAt: 11 });
    expect(detectAbsorption([...baseline, abs], 4, [...bars0, bar(10, 101, 99, 100.5)])[0]).toMatchObject({ state: 'CANDIDATE', resolvedAt: null });
    expect(detectAbsorption([...baseline.slice(0, 5), abs], 4, [...bars0.slice(0, 5), bar(5, 101, 99, 100.5)])).toEqual([]);
  });
  it('high volume alone is not absorption: big progress through the zone disqualifies', () => {
    // Low 97 is 2 points (0.5 ATR) below the zone: sellers made progress.
    expect(detectAbsorption([...baseline, abs], 4, [...bars0, bar(10, 101, 97, 100.5)])).toEqual([]);
  });
  it.each([
    { side: 'BULLISH', footprint: fp(10, [[99, 20, 80], [101, 20, 120]]), candle: bar(10, 101, 99, 100.5), confirmation: bar(11, 101.5, 99.5, 101.2), zone: 99 },
    { side: 'BEARISH', footprint: fp(10, [[99, 120, 20], [101, 80, 20]]), candle: bar(10, 101, 99, 99.5), confirmation: bar(11, 100.5, 98.5, 98.8), zone: 101 },
  ])('finds $side absorption when the highest volume row fails the location rules', ({ side, footprint, candle, confirmation, zone }) => {
    const events = detectAbsorption([...baseline, footprint, after], 4, [...bars0, candle, confirmation]);
    expect(events).toMatchObject([{ side, index: 10, zone, zoneVolume: 80, progressAtr: 0, state: 'CONFIRMED' }]);
  });
  it('buying exhaustion at a new high, confirmed by a close below the bar', () => {
    // bar 2: top row 102 traded 3 of an average 57.7 per row (0.05 <= 0.3); buys 102 < 200; delta 31 < 120; then a close below 100.
    const f = [fp(0, [[98, 50, 25], [99, 50, 25]]), fp(1, [[100, 100, 40], [101, 100, 40]]), fp(2, [[100, 40, 40], [101, 60, 30], [102, 2, 1]]), fp(3, [[99, 30, 30], [100, 30, 30]])];
    const b = [bar(0, 100, 98, 99.5), bar(1, 101, 99, 100.8), bar(2, 102, 100, 100.4), bar(3, 101.8, 99, 99.6)];
    expect(detectExhaustion(f, b, { lookback: 3 })).toEqual([{ side: 'BEARISH', index: 2, extreme: 102, extremeRowShare: 0.052, state: 'CONFIRMED', resolvedAt: 3 }]);
    expect(detectExhaustion(f, b.map((x, i) => (i === 3 ? { ...x, high: 102.5 } : x)), { lookback: 3 })[0].state).toBe('FAILED');
  });
});

describe('multi-timeframe regime (Part 11)', () => {
  const bull: TimeframeInputs = { structure: 'BULLISH', vwapSlopeAtr: 0.3, atrPercentile: 0.5, rvol: 1.2, cvdDirection: 'UP', priceVsValue: 'ABOVE_VAH' };
  const bear: TimeframeInputs = { structure: 'BEARISH', vwapSlopeAtr: -0.3, atrPercentile: 0.5, rvol: 1.2, cvdDirection: 'DOWN', priceVsValue: 'BELOW_VAL' };
  it('classifies one timeframe', () => {
    expect(classifyTimeframe(bull).regime).toBe('STRONG_BULLISH');
    expect(classifyTimeframe(bear).regime).toBe('STRONG_BEARISH');
    expect(classifyTimeframe({ ...bull, cvdDirection: 'DOWN' }).regime).toBe('SIDEWAYS'); // a contradiction removes "strong"
    expect(classifyTimeframe({ ...bull, atrPercentile: 0.9 }).regime).toBe('HIGH_VOLATILITY');
    expect(classifyTimeframe({ ...bull, structure: 'RANGE', atrPercentile: 0.1 }).regime).toBe('LOW_VOLATILITY');
    expect(classifyTimeframe({ ...bull, structure: 'UNKNOWN' }).regime).toBe('UNCERTAIN');
    expect(classifyTimeframe({ structure: 'BULLISH', vwapSlopeAtr: 0.3, atrPercentile: null, rvol: null, cvdDirection: null, priceVsValue: null }).regime).toBe('UNCERTAIN');
  });
  it('a lower timeframe never overrides a conflicting higher one', () => {
    expect(combineRegime({ m30: bull, m15: bull })).toMatchObject({ regime: 'STRONG_BULLISH', allowed: ['BULLISH'] });
    expect(combineRegime({ m30: bull, m15: bear })).toMatchObject({ regime: 'UNCERTAIN', allowed: [], notes: ['LOWER_TF_CONFLICT'] });
    expect(combineRegime({ daily: bear, m30: bull })).toMatchObject({ regime: 'SIDEWAYS', notes: ['COUNTER_DAILY'] });
    expect(combineRegime({ m15: bull })).toMatchObject({ regime: 'UNCERTAIN', notes: ['NO_30M'] });
    expect(combineRegime({ m30: { ...bull, structure: 'RANGE' }, m15: bear })).toMatchObject({ regime: 'SIDEWAYS', allowed: ['BEARISH'] });
  });
});
