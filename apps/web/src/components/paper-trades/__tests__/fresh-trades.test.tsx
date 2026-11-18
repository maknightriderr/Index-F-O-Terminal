import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FreshTrades, freshTradeRows } from '../fresh-trades';

const pos = [
  { strategy: 'HTA_HUMAN_TA_V1', status: 'CLOSED', state: { candidate: { direction: 'BULLISH' }, contract: { id: 'NSE_FO:1' }, entry: 262.2, exitPrice: 205.35, exitReason: 'STRUCTURAL_INVALIDATION', netPnl: -3489, originalRiskCurrency: 4000, openedAt: Date.parse('2026-11-17T06:30:00Z') } },
  { strategy: 'HTA_HUMAN_TA_V1', status: 'CLOSED', state: { contract: { id: 'BSE_FO:2' }, entry: 471.65, exitPrice: 660.75, exitReason: 'MAX_HOLD', netPnl: 7459, originalRiskCurrency: 4800, openedAt: Date.parse('2026-11-17T05:31:00Z') } },
  { strategy: 'NEW_X', status: 'OPEN', state: { contract: { id: 'MCX_FO:3' }, entry: 10, openedAt: Date.parse('2026-11-18T05:00:00Z') } },
];

describe('new-engine trade list', () => {
  it('newest first, with date, result and reason', () => {
    const rows = freshTradeRows(pos, { HTA_HUMAN_TA_V1: 'Human TA' });
    expect(rows.map((r) => r.result)).toEqual(['OPEN', 'LOSS', 'PROFIT']);
    expect(rows[1].reason).toMatch(/structure broke/);
    expect(rows[2].reason).toMatch(/Maximum holding time/);
    expect(rows[1].netR).toBe(-0.87);
    render(<FreshTrades positions={pos} names={{ HTA_HUMAN_TA_V1: 'Human TA' }} />);
    expect(screen.getAllByText('17 Nov 2026')).toHaveLength(2);
    expect(screen.getByText('18 Nov 2026')).toBeTruthy();
    expect(screen.getByText('LOSS')).toBeTruthy();
  });
});
