import { describe, expect, it } from 'vitest';
import { quoteObservedAt } from '../quote-time';
import { reliabilityLines } from '../measurement-view';

describe('quote observation time (audit UI-1)', () => {
  it("is the exchange's own time when the quote carries it, else the fetch time", () => {
    expect(quoteObservedAt({ timestamp: 2_000, exchangeTimestamp: 1_000 })).toBe(1_000);
    expect(quoteObservedAt({ timestamp: 2_000 })).toBe(2_000);
    expect(quoteObservedAt({ timestamp: 2_000, exchangeTimestamp: 0 })).toBe(2_000);
    expect(quoteObservedAt(null)).toBe(0);
  });
});

describe('cost-record coverage line (audit UI-1)', () => {
  it('states its own denominator — the eligible trades — so 313 of 314 never sits beside an unexplained 100%', () => {
    const lines = Object.fromEntries(reliabilityLines({ tradesSinceReliable: 314, eligibleSinceReliable: 313, withCostRecord: 313, costRecordCoveragePct: 100 }));
    expect(lines['Cost record coverage']).toBe('100.0% of eligible trades (313 of 313); 1 not eligible');
    const partial = Object.fromEntries(reliabilityLines({ tradesSinceReliable: 314, eligibleSinceReliable: 314, withCostRecord: 313, costRecordCoveragePct: 99.6 }));
    expect(partial['Cost record coverage']).toBe('99.6% of eligible trades (313 of 314)');
  });
});
