import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DeskWatchlist, SetupSpotlight, SpotlightRecord, StrategyResearch } from '../trading-desk';
import { PaperTradesPanel } from '../paper-trades-panel';
import { familyOfLifecycle } from '@/lib/setups';
import type { SetupRow } from '@/lib/setups';
import type { PaperTradeView } from '@fno/shared';

const mocks = vi.hoisted(() => ({ openTab: vi.fn(), setActiveTab: vi.fn(), rows: [] as SetupRow[], error: null as string | null, loading: false, trades: [] as PaperTradeView[] }));
vi.mock('@/stores', () => ({ useAssetTabsStore: (s: any) => s({ openTab: mocks.openTab }), useMarketStore: (s: any) => s({ setActiveTab: mocks.setActiveTab }) }));
vi.mock('@/lib/use-best-setups', () => ({ useBestSetups: () => ({ rows: mocks.rows, error: mocks.error, loading: mocks.loading }) }));
vi.mock('@/lib/use-health', () => ({ useNow: () => Date.parse('2026-10-25T10:00:00Z') }));
vi.mock('@/lib/use-feed-summary', () => ({ useFeedSummary: () => ({ now: Date.parse('2026-10-25T10:00:00Z'), apiReachable: true }) }));
vi.mock('@/lib/use-paper-trades', () => ({ usePaperTrades: () => ({ data: { trades: mocks.trades }, loading: false, error: null }) }));
vi.mock('@/components/assistant/assistant-launcher', () => ({ ExplainButton: () => null }));

const trade = (over: Partial<PaperTradeView>): PaperTradeView => ({ id: 't', symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', structureType: 'NAKED_LONG', side: 'CE', strike: 24500, expiry: '2026-10-29', direction: 'BULLISH', family: 'OB1', strategyLabel: 'OB1', logicVersion: 'OB-2.0', mintedAt: 1, state: 'OPEN', status: 'OPEN_UNTRACKED', includedInPerformance: false, excludedReason: 'OPEN', cohort: 'POST_B', measurementReliable: true, entry: 100, initialStop: 80, currentStop: null, target: 140, plannedRiskReward: 2, exitPrice: null, exitAt: null, closeReason: null, holdMinutes: null, grossR: null, netR: null, returnPercent: null, estimatedCost: { pct: 2, basis: 'ESTIMATED_MODEL', costR: 0.1, record: null }, live: null, disclosure: 'Simulated', ...over });

const row: SetupRow = { id: 'one', source: 'STRUCTURE', symbol: 'NIFTY', exchange: 'NSE', family: 'OB1', familyLabel: 'Order block', direction: 'BULLISH', regime: null, levels: { basis: 'UNDERLYING', entry: 24560, stop: 24520, target: 24640 }, rewardRisk: 2, estimatedCostPct: null, score: 80, stage: 'CONFIRMED', evidence: ['Recorded retest'], concern: null, decision: 'SHADOW_ONLY', decisionReason: 'Research only', observedAt: Date.parse('2026-10-23T09:30:00Z') };
beforeEach(() => { mocks.rows = []; mocks.error = null; mocks.loading = false; mocks.trades = []; vi.clearAllMocks(); });

it('search keeps original instrument indexes and selection routes to the correct chart', () => {
  const select = vi.fn();
  render(<DeskWatchlist instrumentIdx={4} onInstrument={select} quotes={[]} now={Date.now()} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'crude' } });
  const button = screen.getByRole('button', { name: 'Show CRUDEOIL chart' });
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(button).toHaveTextContent('Quote unavailable');
  fireEvent.click(button);
  expect(select).toHaveBeenCalledWith(4);
  expect(screen.queryByRole('button', { name: 'Show NIFTY chart' })).toBeNull();
});
it('spotlight follows the selected symbol and exchange, not an unrelated top-ranked setup', () => {
  mocks.rows = [{ ...row, id: 'wrong', symbol: 'BANKNIFTY' }, row];
  const { rerender } = render(<SetupSpotlight symbol="NIFTY" exchange="NSE" />);
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('NIFTY');
  rerender(<SetupSpotlight symbol="GOLD" exchange="MCX" />);
  expect(screen.getByText('No recorded setup for GOLD')).toBeInTheDocument();
  expect(screen.queryByText('24,560.00')).toBeNull();
});
it.each(['BULLISH', 'BEARISH'] as const)('keeps recorded %s levels, basis, gross R:R and missing costs without inventing an option side', (direction) => {
  render(<SpotlightRecord row={{ ...row, direction, levels: { basis: 'OPTION_PREMIUM', entry: 100, stop: 80, target: 140 } }} now={Date.parse('2026-10-25T10:00:00Z')} />);
  expect(screen.getByText('Planned option premium')).toBeInTheDocument();
  expect(screen.getByText('100.00')).toBeInTheDocument();
  expect(screen.getByText('80.00')).toBeInTheDocument();
  expect(screen.getByText('140.00')).toBeInTheDocument();
  expect(screen.getByText('Planned R:R · gross')).toBeInTheDocument();
  expect(screen.getByText('—')).toBeInTheDocument();
  expect(screen.getByText('SHADOW ONLY')).toBeInTheDocument();
  expect(screen.getByText('MARKET CLOSED')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Inspect workspace/ }));
  expect(mocks.openTab).toHaveBeenCalledWith('NIFTY', 'NSE');
});
it('NONE basis suppresses unusable levels and errors stay visible with cached records', () => {
  mocks.rows = [{ ...row, levels: { basis: 'NONE', entry: 100, stop: 80, target: 140 } }]; mocks.error = 'Timeout';
  render(<SetupSpotlight symbol="NIFTY" exchange="NSE" />);
  expect(screen.queryByText('100.00')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent('latest refresh failed');
});
it('research links open diagnostics without claiming results or activation', () => {
  render(<StrategyResearch />);
  fireEvent.click(screen.getByRole('button', { name: /OF1/ }));
  expect(mocks.setActiveTab).toHaveBeenCalledWith('signal-diagnostics');
  expect(screen.queryByText(/profitable|active|awaiting observations/i)).toBeNull();
});
it('compact ledger uses recorded net R, keeps a missing mark missing and filters open/closed', () => {
  mocks.trades = [trade({ id: 'a', symbol: 'NIFTY', exchange: 'NSE', state: 'OPEN', status: 'OPEN_UNTRACKED', strategyLabel: 'OB1', direction: 'BULLISH', entry: 100, mintedAt: Date.parse('2026-10-25T04:00:00Z'), live: null, netR: 9, side: 'CE' }), trade({ id: 'b', symbol: 'BANKNIFTY', exchange: 'NSE', state: 'LOSS', status: 'CLOSED', strategyLabel: 'OF1', direction: 'BEARISH', entry: 200, exitPrice: 180, netR: -1.1, grossR: -1, exitAt: Date.parse('2026-10-25T07:00:00Z'), mintedAt: Date.parse('2026-10-25T04:00:00Z'), side: 'PE' })];
  render(<PaperTradesPanel compact />);
  const table = screen.getByRole('table');
  expect(within(table).queryByText('+9.00R')).toBeNull();
  expect(within(table).getByText('UNAVAILABLE')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Closed today (1)' }));
  expect(within(table).getByText('-1.10R')).toBeInTheDocument();
  expect(within(table).queryByText('OB1')).toBeNull();
});

it('recognizes routed OB1 and OF1 records instead of labelling them S1', () => {
  for (const family of ['OB1', 'OF1', 'A3', 'F2']) expect(familyOfLifecycle(`NSE:NIFTY:MP:${family}:BULLISH:1`)).toBe(family);
  expect(familyOfLifecycle('NSE:NIFTY:STRUCTURE:1')).toBe('S1');
});
