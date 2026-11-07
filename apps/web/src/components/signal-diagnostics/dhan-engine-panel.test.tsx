import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DhanEnginePanel, type DhanEngineSnapshot, type DhanSignalsReport } from './dhan-engine-panel';

const signals: DhanSignalsReport = {
  mode: 'SHADOW_ONLY', day: '2026-11-09',
  status: { recorded: { SIGNAL: 1, NO_TRADE: 1 }, paper: { FILLED: 1 }, contracts: 2, firstFailures: [{ k: 'DHAN_B_IMBALANCE_BREAKOUT:B4_RVOL_EXPANSION', c: 9 }], gamma: [] },
  signals: [
    { strategy: 'DHAN_A_SWEEP_ABSORPTION', side: 'BULLISH', symbol: 'NIFTY', instrument: 'NIFTY-Nov2026-FUT', exchange: 'NSE', bar_time: '2026-11-09T05:00:00Z', status: 'SIGNAL', score: 8, eligibility: 'PREFERRED', entry: '24100', stop_loss: '24040', target: '24250', rr: '2.5', session_window: 'PRIMARY', no_trade: { reasons: [], notEvaluated: ['OPTION_SPREAD'] }, gates: [{ id: 'VALID_DATA', ok: true }], paper_decision: 'FILLED' },
    { strategy: 'DHAN_D_VWAP_PROFILE_REJECTION', side: 'BEARISH', symbol: 'RELIANCE', instrument: null, exchange: 'NSE', bar_time: '2026-11-09T05:15:00Z', status: 'NO_TRADE', score: 6, eligibility: 'REJECT', entry: null, stop_loss: null, target: null, rr: null, session_window: 'PRIMARY', no_trade: { reasons: ['RR_BELOW_2'], notEvaluated: [] }, gates: [{ id: 'MIN_RR_2', ok: false }] },
  ],
};
const snap: DhanEngineSnapshot = {
  symbol: 'NIFTY', version: 'DHAN-ENG-2.0', session: '2026-11-09', exchange: 'NSE', instrument: 'NIFTY-Nov2026-FUT', kind: 'INDEX', tickSize: 0.1, bars: 3, tradedBars: 3, incompleteBars: 1,
  lastBar: { barTime: Date.parse('2026-11-09T05:00:00Z'), deltaMode: 'INFERRED', delta: 120, deltaPct: 0.2, incomplete: false, unreconciledVolume: 0 },
  footprint: { status: 'ESTIMATED', reason: null, barTime: Date.parse('2026-11-09T05:00:00Z'), priceStep: 13, minLevelVolume: 40, buyImbalances: 1, sellImbalances: 0, stacks: [], rows: [{ price: 24100, ask: 300, bid: 50, unknown: 0, buyRatio: 6, sellRatio: null, buyImbalance: true, sellImbalance: false }, { price: 24087, ask: 80, bid: 50, unknown: 5, buyRatio: null, sellRatio: 0.2, buyImbalance: false, sellImbalance: false }] },
  cvd: { last: { cvd: 400, status: 'INCOMPLETE' }, series: [{ time: 1, delta: 100, cvd: 100, status: 'ESTIMATED' }, { time: 2, delta: null, cvd: 100, status: 'INCOMPLETE' }, { time: 3, delta: 300, cvd: 400, status: 'INCOMPLETE' }], divergences: [] },
  profile: { status: 'VERIFIED', reason: null, poc: 24087, vah: 24100, val: 24074, valueAreaShare: 0.8, hvn: [], lvn: [], total: 500 },
  vwap: { status: 'ESTIMATED', source: 'TRADES', vwap: 24090.5, sd: 8, distanceSd: 1.2, bands: null },
  atr: { value: 30, source: 'MEAN_15M_RANGE' }, structure: { source: 'FLOW_15M_BARS', trend: 'BULLISH', lastSwingHigh: 24110, lastSwingLow: 24050, lastBreak: null },
  absorption: [], exhaustion: [],
};
vi.mock('@/lib/api', () => ({ api: {
  getDhanEngineSummary: async () => ({ note: '', contracts: [{ symbol: 'NIFTY', kind: 'INDEX', bars: 3, incompleteBars: 1, cvd: 400, cvdStatus: 'INCOMPLETE', vwap: 24090.5, vwapStatus: 'ESTIMATED', poc: 24087, footprint: 'ESTIMATED', trend: 'BULLISH' }] }),
  getDhanEngineSignals: async () => signals,
  getDhanEngineSnapshot: async () => snap,
} }));

describe('Dhan engine dashboard', () => {
  it('shows the setup board with status, score, rejection reasons and the paper decision', async () => {
    render(<DhanEnginePanel />);
    expect(await screen.findByText('Dhan engine v2: setup board')).toBeInTheDocument();
    expect(screen.getByText('8/10')).toBeInTheDocument();
    expect(screen.getByText('MIN_RR_2, RR_BELOW_2')).toBeInTheDocument();
    expect(screen.getAllByText('FILLED').length).toBeGreaterThan(0);
    expect(screen.getByText(/b imbalance breakout:b4 rvol expansion: 9/)).toBeInTheDocument();
  });
  it('labels estimated and incomplete values and opens a contract\'s footprint ladder', async () => {
    render(<DhanEnginePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'NIFTY' }));
    expect(await screen.findByLabelText('Footprint ladder')).toBeInTheDocument();
    expect(screen.getAllByText('INCOMPLETE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ESTIMATED').length).toBeGreaterThan(0);
    const row = screen.getByText('24100', { selector: 'td' }).closest('tr')!;
    expect(row).toHaveAttribute('data-buy-imbalance', 'true');
    expect(screen.getByRole('img', { name: 'Session CVD' })).toBeInTheDocument();
  });
});
