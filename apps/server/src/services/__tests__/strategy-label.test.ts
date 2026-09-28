import { describe, it, expect } from 'vitest';
import { classifyStrategyLabels, type StrategyLabel, type StrategyLabelInput } from '../strategy-label.js';

const NEUTRAL_VOTES = { futuresOi: 0, pcr: 0, optionOiFlow: 0 };

function input(overrides: Partial<StrategyLabelInput>): StrategyLabelInput {
  return { direction: 'BULLISH', setupTriggers: [], premiumDiscountZone: 'PREMIUM', candlePattern: null, positioning: NEUTRAL_VOTES, ...overrides };
}

// One fixture per taxonomy value: the readings the engine already computes,
// and the single label they should produce.
const CASES: { label: StrategyLabel; fixture: StrategyLabelInput }[] = [
  { label: 'LIQUIDITY_SWEEP', fixture: input({ setupTriggers: ['LIQUIDITY_SWEEP'] }) },
  { label: 'EQ_REJECTION', fixture: input({ premiumDiscountZone: 'EQUILIBRIUM', candlePattern: { pattern: 'HAMMER', direction: 'BULLISH' } }) },
  { label: 'BOS', fixture: input({ setupTriggers: ['BOS'] }) },
  { label: 'CHOCH', fixture: input({ setupTriggers: ['CHOCH'] }) },
  { label: 'TREND_CONTINUATION', fixture: input({ setupTriggers: ['EMA_TREND_ALIGNED'] }) },
  { label: 'VWAP_RECLAIM', fixture: input({ setupTriggers: ['VWAP_RECLAIM'] }) },
  { label: 'BREAKOUT', fixture: input({ setupTriggers: ['VCP_BREAKOUT_CONFIRMED'] }) },
  { label: 'MEAN_REVERSION', fixture: input({ setupTriggers: ['FVG_ACTIVE'] }) },
  { label: 'OPTION_FLOW', fixture: input({ positioning: { futuresOi: 1, pcr: 1, optionOiFlow: 1 } }) },
];

describe('strategy label — a labelling pass over already-computed readings', () => {
  for (const { label, fixture } of CASES) {
    it(`assigns ${label}`, () => {
      const r = classifyStrategyLabels(fixture);
      expect(r.labels).toEqual([label]);
      expect(r.primary).toBe(label);
    });
  }

  it('falls back to OTHER when nothing specific qualified — never a guess', () => {
    const r = classifyStrategyLabels(input({}));
    expect(r).toEqual({ labels: ['OTHER'], primary: 'OTHER' });
  });

  it('persists every qualifying label, in priority order, with the most specific as primary', () => {
    const r = classifyStrategyLabels(
      input({ setupTriggers: ['EMA_TREND_ALIGNED', 'BOS', 'LIQUIDITY_SWEEP'], positioning: { futuresOi: 1, pcr: 1, optionOiFlow: 1 } })
    );
    expect(r.labels).toEqual(['LIQUIDITY_SWEEP', 'BOS', 'TREND_CONTINUATION', 'OPTION_FLOW']);
    expect(r.primary).toBe('LIQUIDITY_SWEEP');
  });

  it('maps chart-pattern triggers by family', () => {
    expect(classifyStrategyLabels(input({ setupTriggers: ['PATTERN_SHORT_ASCENDING_TRIANGLE'] })).primary).toBe('BREAKOUT');
    expect(classifyStrategyLabels(input({ setupTriggers: ['PATTERN_LONG_BULLISH_FLAG'] })).primary).toBe('TREND_CONTINUATION');
    expect(classifyStrategyLabels(input({ setupTriggers: ['PATTERN_SHORT_DOUBLE_BOTTOM'] })).primary).toBe('MEAN_REVERSION');
  });

  it('positioning against the direction is not option flow; nor is a candle against it an EQ rejection', () => {
    const bearish = input({
      direction: 'BEARISH',
      positioning: { futuresOi: 1, pcr: 1, optionOiFlow: 1 },
      premiumDiscountZone: 'EQUILIBRIUM',
      candlePattern: { pattern: 'HAMMER', direction: 'BULLISH' },
    });
    expect(classifyStrategyLabels(bearish).primary).toBe('OTHER');
  });
});
