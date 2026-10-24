import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrderFlowPanel, type OrderFlowReport } from './order-flow-panel';

let result: OrderFlowReport;
vi.mock('@/lib/api', () => ({ api: { getOrderFlowReport: async () => result } }));
const report = (): OrderFlowReport => ({
  note: '', settings: { orderBlockMode: 'PAPER', of1Enabled: true, of1Trading: true, orderFlowSymbols: ['NIFTY'] },
  feed: { status: 'CONNECTED', deltaMode: 'INFERRED', deltaModeReason: 'Tick-rule estimate', instruments: {}, packets: 1, trades: 1, lastPacketAt: null, lastError: null },
  flowBars: [],
  of1: { candidates: 0, bullish: 0, bearish: 0, exact: 0, inferred: 0, wouldTradeIfLive: 0, graded: 0, targets: 0, stops: 0, openAtClose: 0, avgR: null, avgMfeR: null, avgMaeR: null, existingTradedSameBar: 0, bySubtype: [], existingWinners: [] },
  orderBlocks: { byState: [], decisions: 0, legacySignals: 0, v2Signals: 0, wouldChangeIndicatorDirection: 0 },
});
describe('OF1 alignment and version disclosure', () => {
  it('shows unavailable alignment separately from a connected feed and labels the new cohort', async () => {
    result = report();
    result.of1.version = 'OF1-1.2';
    result.orderBlocks.reactionVersion = 'OB-2.1';
    result.alignment = { NIFTY: { barTime: Date.parse('2026-10-06T10:45:00+05:30'), alignment: { status: 'UNAVAILABLE', reason: 'CONTRACT_MISMATCH' } } };
    render(<OrderFlowPanel filter={{}} />);
    expect(await screen.findByText(/Showing OF1-1.2 only/)).toBeInTheDocument();
    expect(screen.getByText(/UNAVAILABLE: contract mismatch/)).toBeInTheDocument();
    expect(screen.getByText(/Reaction measurements: OB-2.1/)).toBeInTheDocument();
    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
  });
  it('still renders older backend responses without alignment/version fields', async () => {
    result = report();
    render(<OrderFlowPanel filter={{}} />);
    expect(await screen.findByText('OF1: order-flow confirmation candidates')).toBeInTheDocument();
    expect(screen.queryByText(/Showing OF1-1.2 only/)).not.toBeInTheDocument();
  });
});
