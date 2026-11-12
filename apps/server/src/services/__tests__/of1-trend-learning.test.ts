// OF1 learning (owner, 12 Nov): counter-trend OF1 entries are refused once 10 counter-trend trades have closed with a
// negative average net R; with-trend and no-trend entries are never affected.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../paper-trades.js', () => ({ listPaperTrades: async () => ({ trades: [] }) }));
vi.mock('../backtesting.js', () => ({ getTradeSetupHistory: async () => [] }));
const { learnOf1, learnByFamily, learnedRefusal, trendAlignment, regimeTrendSide, of1Learning, resetOf1Learning, OF1_COUNTER_TREND_MIN_TRADES } = await import('../of1-trend-learning.js');

const V = '2026-09-29.structure.1+demote-s1.1+reinstate-all.1+of1-paper.2';
const t = (direction: string, regime: string, netR: number, logicVersion = V, family = 'OF1') => ({ family, direction, regime, netR, logicVersion });

describe('OF1 trend learning', () => {
  it('classes a trade against the regime trend', () => {
    expect(trendAlignment('BEARISH', 'WEAK_BULL_TREND')).toBe('COUNTER_TREND'); // the 12 Nov CRUDEOIL put
    expect(trendAlignment('BULLISH', 'WEAK_BULL_TREND')).toBe('WITH_TREND');
    expect(trendAlignment('BULLISH', 'STRONG_BEAR_TREND')).toBe('COUNTER_TREND');
    expect(trendAlignment('BEARISH', 'RANGE_BOUND')).toBe('NO_TREND');
    expect(trendAlignment('BULLISH', null)).toBe('NO_TREND');
    expect(regimeTrendSide('BREAKOUT')).toBeNull();
  });
  it('one loss changes nothing; ten counter-trend trades with a negative average refuse counter-trend entries', () => {
    expect(learnOf1([t('BEARISH', 'WEAK_BULL_TREND', -1.12), t('BULLISH', 'WEAK_BULL_TREND', 2.36)])).toMatchObject({ counterTrend: { trades: 1, avgNetR: -1.12 }, withTrend: { trades: 1, avgNetR: 2.36 }, blockCounterTrend: false });
    const ten = Array.from({ length: OF1_COUNTER_TREND_MIN_TRADES }, (_, k) => t('BEARISH', 'WEAK_BULL_TREND', k < 4 ? 1.5 : -1));
    expect(learnOf1(ten)).toMatchObject({ counterTrend: { trades: 10, avgNetR: 0 }, blockCounterTrend: false }); // 6 - 6 = 0: not negative
    const worse = [...ten.slice(0, 9), t('BULLISH', 'STRONG_BEAR_TREND', -1)];
    expect(learnOf1([...worse, t('BEARISH', 'WEAK_BULL_TREND', -1)]).blockCounterTrend).toBe(true);
  });
  it('the rule lifts itself when later counter-trend outcomes turn the average positive', () => {
    const losing = Array.from({ length: 10 }, () => t('BEARISH', 'WEAK_BULL_TREND', -1));
    expect(learnOf1(losing).blockCounterTrend).toBe(true);
    expect(learnOf1([...losing, ...Array.from({ length: 6 }, () => t('BEARISH', 'WEAK_BULL_TREND', 2))]).blockCounterTrend).toBe(false);
  });
  it('counts only OF1 trades of the reinstated engine', () => {
    const old = Array.from({ length: 12 }, () => t('BEARISH', 'WEAK_BULL_TREND', -1, '2026-09-29.coverage-lag.1+of1-paper.2'));
    const ob1 = Array.from({ length: 12 }, () => t('BEARISH', 'WEAK_BULL_TREND', -1, V, 'OB1'));
    expect(learnOf1([...old, ...ob1])).toMatchObject({ counterTrend: { trades: 0 }, blockCounterTrend: false });
  });
  it('reads in the background and keeps the last state on a failure', async () => {
    resetOf1Learning();
    const load = vi.fn(async () => Array.from({ length: 10 }, () => t('BEARISH', 'WEAK_BULL_TREND', -1)));
    expect(of1Learning(load, 1_000)).toBeNull(); // first call starts the read
    await vi.waitFor(() => expect(of1Learning(load, 2_000)?.blockCounterTrend).toBe(true));
    expect(load).toHaveBeenCalledTimes(1); // fresh: not re-read
    const failing = vi.fn(async () => { throw new Error('db down'); });
    of1Learning(failing, 1_000 + 16 * 60_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(of1Learning(failing, 1_000 + 16 * 60_000)?.blockCounterTrend).toBe(true);
    resetOf1Learning();
  });
  it('13 Nov: every legacy strategy learns from its own trades only, applied at the final check', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => t('BULLISH', 'WEAK_BEAR_TREND', -1, V, 'INDICATOR')),
      ...Array.from({ length: 10 }, () => t('BULLISH', 'WEAK_BEAR_TREND', 1, V, 'OB1')),
      t('BEARISH', 'WEAK_BULL_TREND', -1.12),
    ];
    const by = learnByFamily(rows);
    expect(Object.keys(by).sort()).toEqual(['INDICATOR', 'OB1', 'OF1']);
    expect(by.INDICATOR.blockCounterTrend).toBe(true);
    expect(by.OB1.blockCounterTrend).toBe(false); // its counter-trend trades pay
    expect(by.OF1.blockCounterTrend).toBe(false); // one trade
    expect(learnedRefusal('INDICATOR', 'BULLISH', 'STRONG_BEAR_TREND', by)).toMatchObject({ code: 'LEARNED_COUNTER_TREND' });
    expect(learnedRefusal('INDICATOR', 'BEARISH', 'STRONG_BEAR_TREND', by)).toBeNull(); // with the trend
    expect(learnedRefusal('INDICATOR', 'BULLISH', 'RANGE_BOUND', by)).toBeNull(); // no trend
    expect(learnedRefusal('OB1', 'BULLISH', 'STRONG_BEAR_TREND', by)).toBeNull();
    expect(learnedRefusal('A3', 'BULLISH', 'STRONG_BEAR_TREND', by)).toBeNull(); // no trades yet
    expect(learnedRefusal('INDICATOR', 'BULLISH', 'STRONG_BEAR_TREND', null)).toBeNull(); // not read yet
  });
});
