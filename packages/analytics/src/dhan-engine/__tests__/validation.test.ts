// Dhan engine v2, phase 6: grading and the per-setup report, on hand-computed trades.
import { describe, expect, it } from 'vitest';
import { chronologicalSplit, cohortStats, gradeSignal, validationReport, walkForward, type GradedTrade } from '../validation.js';

const bar = (time: number, high: number, low: number, close: number) => ({ time, open: close, high, low, close });

describe('grading', () => {
  it('first touch decides; a bar touching both is the stop; unresolved is OPEN at the last close', () => {
    const long = { side: 'BULLISH' as const, entry: 100, stop: 98, target: 104 };
    expect(gradeSignal(long, [bar(1, 101, 99, 100.5), bar(2, 104.5, 100, 104)])).toMatchObject({ outcome: 'TARGET', r: 2, exitTime: 2, bars: 2 });
    expect(gradeSignal(long, [bar(1, 105, 97, 100)])).toMatchObject({ outcome: 'STOP', r: -1 });
    expect(gradeSignal(long, [bar(1, 101, 99, 101)])).toMatchObject({ outcome: 'OPEN', r: 0.5 });
    expect(gradeSignal({ ...long, costPoints: 0.5 }, [bar(1, 104, 99, 104)])).toMatchObject({ r: 2, netR: 1.75 });
    expect(gradeSignal({ side: 'BEARISH', entry: 100, stop: 102, target: 96 }, [bar(1, 100.5, 95.5, 96)])).toMatchObject({ outcome: 'TARGET', r: 2 });
    expect(gradeSignal({ ...long, stop: 101 }, []).outcome).toBe('INVALID');
  });
});

describe('report', () => {
  const tr = (time: number, r: number, strategy = 'DHAN_A_SWEEP_ABSORPTION', symbol = 'NIFTY'): GradedTrade => ({ key: String(time), strategy, symbol, side: 'BULLISH', time, r, netR: r - 0.1, outcome: r > 0 ? 'TARGET' : 'STOP' });
  it('win rate, expectancy, profit factor, drawdown on the time-ordered R sequence', () => {
    // R by time: 2, -1, -1, 2, -1 -> total 1, expectancy 0.2, PF 4/3, drawdown peak 2 -> trough 0 = 2.
    const s = cohortStats([tr(5, -1), tr(1, 2), tr(3, -1), tr(2, -1), tr(4, 2)]);
    expect(s).toMatchObject({ trades: 5, wins: 2, losses: 3, winRate: 0.4, expectancyR: 0.2, netExpectancyR: 0.1, profitFactor: 1.3333, maxDrawdownR: 2, totalR: 1, sample: 'SMALL_SAMPLE' });
    expect(cohortStats([]).winRate).toBeNull();
  });
  it('chronological split and walk-forward folds keep time order', () => {
    const ts = Array.from({ length: 10 }, (_, i) => tr(i, i < 7 ? 1 : -1));
    const s = chronologicalSplit(ts);
    expect(s.inSample).toMatchObject({ trades: 7, winRate: 1 });
    expect(s.outOfSample).toMatchObject({ trades: 3, winRate: 0 });
    expect(walkForward(ts, 2).map((f) => [f.from, f.to, f.stats.totalR])).toEqual([[0, 4, 5], [5, 9, -1]]);
  });
  it('groups by strategy / symbol / regime and states that candle backtests cannot validate A-D', () => {
    const r = validationReport([tr(1, 2), tr(2, -1, 'DHAN_B_IMBALANCE_BREAKOUT', 'RELIANCE')], 'RECORDED_SIGNALS');
    expect(r.byStrategy.map((x) => [x.strategy, x.stats.trades])).toEqual([['DHAN_A_SWEEP_ABSORPTION', 1], ['DHAN_B_IMBALANCE_BREAKOUT', 1]]);
    expect(r.bySymbol.map((x) => x.symbol)).toEqual(['NIFTY', 'RELIANCE']);
    expect(r.byRegime).toMatchObject([{ regime: 'UNKNOWN', stats: { trades: 2 } }]);
    expect(r.candleBacktest).toMatch(/^NOT_POSSIBLE/);
  });
});
