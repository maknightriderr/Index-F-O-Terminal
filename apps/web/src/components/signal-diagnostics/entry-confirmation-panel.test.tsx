import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntryConfirmationPanel, type EntryConfirmationReport } from './entry-confirmation-panel';

const emptyLedger = { closed: 0, open: 0, unavailable: 0, avgNetR: null, totalNetR: null, winRate: null, realisedDrawdownR: null };
const base: EntryConfirmationReport = { version: 'ENTRY-CONFIRM-1.0', enabled: true, status: 'AVAILABLE', note: 'No automatic promotion.', activations: [], arms: [{ arm: 'OB1C', version: 'OB1C-ENTRY-1.0', observed: 0, passed: 0, filtered: 0, evidenceUnavailable: 0, positions: 0, official: emptyLedger, simulated: emptyLedger, avgEntryDelaySeconds: null, entryDelaySamples: 0, avgEstimatedCostR: null }], pairs: [], combinations: [] };
describe('entry confirmation comparison disclosure', () => {
  it('shows no-result gaps and current-rule isolation without claiming an improvement', () => {
    render(<EntryConfirmationPanel data={base} />);
    expect(screen.getByText(/Not activated yet/)).toBeInTheDocument();
    expect(screen.getByText(/current paper-entry rules stay unchanged/)).toBeInTheDocument();
    expect(screen.getByText(/Neither variant waits for a later candle/)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(5);
    expect(screen.getByText(/No automatic promotion/)).toBeInTheDocument();
  });
  it('distinguishes missing comparison data from zero outcomes and exposes paused entries', () => {
    render(<EntryConfirmationPanel data={{ ...base, enabled: false, status: 'UNAVAILABLE', reason: 'EXPERIMENT_QUERY_FAILED' }} />);
    expect(screen.getByText(/New entries disabled/)).toBeInTheDocument();
    expect(screen.getByText(/Comparison unavailable: EXPERIMENT_QUERY_FAILED/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('renders matched rejected winners and missing coverage separately for both ledgers', () => {
    render(<EntryConfirmationPanel data={{ ...base, pairs: [{ control: 'OB1C', variant: 'OB1J', filteredCandidates: 4, controlPositions: 3, noControlPosition: 1, closedControl: 2, pendingControl: 1, missedWinners: 1, avoidedLosers: 1, flat: 0, rejectedControlAvgNetR: .4, simulatedClosedControl: 1, simulatedMissedWinners: 1, simulatedAvoidedLosers: 0, simulatedRejectedAvgNetR: 1.9 }] }} />);
    expect(screen.getByText(/filtered 4; matched closed controls 2; missed winners 1; avoided losers 1/)).toBeInTheDocument();
    expect(screen.getByText(/no control position 1/)).toBeInTheDocument();
    expect(screen.getByText(/Missing outcomes do not count as losses/)).toBeInTheDocument();
  });
});
