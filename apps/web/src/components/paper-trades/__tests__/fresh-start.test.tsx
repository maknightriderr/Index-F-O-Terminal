import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { getFreshStartStatus: mocks.get } }));
import { FreshStartPanel } from '../fresh-start';
const performance = { strategy: 'NEW_ORB_RETEST_V1', filled: 0, closed: 0, pending: 0, open: 0, wins: 0, losses: 0, flat: 0, netPnl: null, expectancyR: null, winRate: null, independentSessions: 0 };
describe('fresh-start validation display', () => {
    it('shows disabled entries, empty net results and pending verification without claiming success', async () => { mocks.get.mockResolvedValue({ version: 'NEW-INTRADAY-1.0', enabled: false, legacyNewEntries: false, capital: null, strategies: [{ id: performance.strategy, enabled: false }], performance: [performance], blockers: ['VERIFIED_EVENT_COVERAGE'], candidates: [] }); render(<FreshStartPanel />); expect(await screen.findByText('New paper entries disabled')).toBeInTheDocument(); expect(screen.getByText(/Legacy entries retired/)).toBeInTheDocument(); const row = screen.getByRole('rowheader', { name: 'Opening range retest' }).closest('tr')!; expect(within(row).getByText('Not validated')).toBeInTheDocument(); expect(within(row).getAllByText('—')).toHaveLength(3); expect(screen.getByText('VERIFIED EVENT COVERAGE')).toBeInTheDocument(); });
    it('does not assert an entry state when the status request fails', async () => { mocks.get.mockRejectedValue(Error('network')); render(<FreshStartPanel />); expect(await screen.findByRole('alert')).toHaveTextContent('Entry state cannot be verified'); expect(screen.queryByText('New paper entries disabled')).toBeNull(); });
});
