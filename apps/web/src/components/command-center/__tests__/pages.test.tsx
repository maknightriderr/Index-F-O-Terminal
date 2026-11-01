// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ getFreshStartStatus: vi.fn(), getHealth: vi.fn(), getIndexQuotes: vi.fn(), getOptionChain: vi.fn() }));
vi.mock('@/lib/api', () => ({ api }));

import { CommandCenter } from '../index';
import { StrategyLabPage } from '../../strategy-lab';
import { OptionChainPage } from '../../option-chain';

const NOW = Date.now();
const position = (id: string, state: 'OPEN' | 'CLOSED', netPnl: number | null) => ({
  strategy: 'NEW_ORB_RETEST_V1', version: 'NEW-INTRADAY-1.4', session: 'today', status: state,
  state: {
    id, entry: 50, quantity: 75, openedAt: NOW - 3_600_000, lastEventAt: NOW - 600_000, state, originalRiskCurrency: 1250, emergencyStop: 37.5, currentStop: 40, highBid: 58,
    exitPrice: state === 'CLOSED' ? 70 : null, exitReason: state === 'CLOSED' ? 'TARGET' : null, netPnl, maxUnderlyingFavorable: 40,
    contract: { id: 'k', multiplier: 1, delta: 0.5, market: 'NSE_INDEX_OPTIONS', evidence: { underlying: 'NIFTY', strike: 24850, expiry: '2026-11-04' } },
    candidate: { strategy: 'NEW_ORB_RETEST_V1', direction: 'BULLISH', instrument: 'NIFTY', referenceEntry: 24800, stop: 24760, target: 24900, at: NOW - 3_700_000 },
  },
});
const status = {
  version: 'NEW-INTRADAY-1.4', enabled: true, legacyNewEntries: false, capital: 500000, eventPolicy: { id: 'PAPER_EVENT_UNVERIFIED_V1', allowMissingMacroCoverage: true },
  feedQualification: { status: 'QUALIFIED', observedExecutableBooks: 12, monitorRunning: true, recovered: true, entriesArmed: true },
  strategies: [{ id: 'NEW_ORB_RETEST_V1', enabled: true }], performance: [{ strategy: 'NEW_ORB_RETEST_V1', closed: 1, winRate: 1, expectancyR: 1.2, netPnl: 1500, minimumSampleMet: false }],
  positions: [position('open-1', 'OPEN', null), position('closed-1', 'CLOSED', 1500)], candidates: [], evaluations: [], reviews: [], blockers: [],
};

beforeEach(() => {
  api.getFreshStartStatus.mockResolvedValue(status);
  api.getHealth.mockResolvedValue({ status: 'HEALTHY', services: { redis: { status: 'HEALTHY', latencyMs: 3 }, database: { status: 'HEALTHY', latencyMs: 4 } }, ops: { incidents: [] }, calendarHorizons: [{ id: 'FEE_SCHEDULE', until: '2027-01-01' }] });
  api.getIndexQuotes.mockResolvedValue([]);
  api.getOptionChain.mockRejectedValue(new Error('offline'));
});
afterEach(cleanup);

it('renders the Command Center from the fresh-start status without inventing a live mark', async () => {
  render(<CommandCenter />);
  await act(async () => {});
  const positions = screen.getByRole('region', { name: /live positions/i });
  expect(within(positions).getByText('NIFTY 24850 CE')).toBeTruthy();
  expect(within(positions).getByText(/1 open/)).toBeTruthy();
  expect(screen.getByText('₹5,00,000')).toBeTruthy();
  expect(screen.getByRole('region', { name: /trade journal/i })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: /calendars that expire/i })).getByText('Fee schedule')).toBeTruthy();
});

it('renders the Strategy Lab with its sample size', async () => {
  render(<StrategyLabPage />);
  await act(async () => {});
  expect(screen.getByText('Need 30 per strategy')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'ORB retest' })).toBeTruthy();
});

it('says so when the option chain cannot be loaded', async () => {
  render(<OptionChainPage />);
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toMatch(/NIFTY chain could not be loaded/);
});
