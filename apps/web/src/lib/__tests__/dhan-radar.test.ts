import { describe, expect, it } from 'vitest';
import { dhanCellText, dhanCheckLabel } from '../dhan-radar';

describe('Dhan radar cells', () => {
  it('labels checks and outcomes', () => {
    expect(dhanCheckLabel('A3_SELLING_AGGRESSION_UP')).toBe('A3 selling aggression up');
    expect(dhanCheckLabel('A4_A5_ABSORPTION_CONFIRMED')).toBe('A4_A5 absorption confirmed');
    expect(dhanCellText(undefined)).toEqual({ text: '—', tone: null });
    expect(dhanCellText({ status: 'SIGNAL', side: 'BEARISH', failed: null, passed: 9, score: 8 })).toEqual({ text: 'SIGNAL bear 8/10', tone: 'ok' });
    expect(dhanCellText({ status: 'NO_TRADE', side: 'BULLISH', failed: 'MIN_RR_2', passed: 9, score: 6 })).toEqual({ text: 'Rejected: min rr 2', tone: 'warn' });
    expect(dhanCellText({ status: 'NO_SETUP', side: null, failed: 'B1_HTF_BULLISH', passed: 0, score: null }).text).toBe('Stopped at B1 htf bullish');
  });
});
