import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PERFORMANCE_PAGES, resolveTab } from '@/lib/nav';

// A plain function, not vi.fn(): vitest's spy re-throws a rejected promise on a derived
// chain, which surfaced as an unhandled error in the 404 test.
let getEvidence: (report: string) => Promise<unknown> = async () => null;
vi.mock('@/lib/api', () => ({ api: { getEvidence: (report: string) => getEvidence(report) } }));
vi.mock('@/components/performance/performance-nav', () => ({ PerformanceNav: () => null }));

const stat = (mean: number | null, lo: number | null = null, hi: number | null = null) => ({ n: 10, clusters: 5, mean, lo, hi });
const entry = (strategy: string, action: string, mean: number) => ({
  strategy, n: 40, days: 8, wins: 20, losses: 5, expired: 15, winRateClosedOnly: 80, winRateAllTrades: 50,
  netR: stat(mean, mean - 0.1, mean + 0.1), netRCorrected: { lo: mean - 0.2, hi: mean + 0.2, comparisons: 2 }, grossR: mean + 0.08,
  avgNetWin: 0.3, avgNetLoss: -1.1, firstHalfNetR: mean, secondHalfNetR: mean, action, reason: `${strategy} reason`,
});

const REPORTS: Record<string, unknown> = {
  scorecard: { note: 'n', rules: { VERSION: 'EVIDENCE-1.0', REGISTERED_AT: '2026-10-15', MIN_N_DEMOTE: 30, MIN_N_PROMOTE: 100, MIN_DAYS_PROMOTE: 20 }, paper: [entry('INDICATOR', 'PROTECTED_BENCHMARK', -0.03), { ...entry('A4', 'DEMOTE_CANDIDATE', -0.25), currentStage: { stage: 'SHADOW', since: '2026-10-08' } }], measurementReliable: [], candidates: [] },
  'signal-quality': {
    note: 'n', decisions: 1000, days: 20, symbols: 50,
    horizons: [30, 60, 120].map((minutes) => ({ minutes, ...stat(0.01, -0.05, 0.07), hitRate: 50.6 })),
    toDayEnd: { ...stat(0), hitRate: 50 }, baseline60: { ...stat(0.08), hitRate: 51.9 }, agreesWithMomentumPct: 69,
    byExchange: [], byConfidence: [], dimensions: [{ dimension: 'futuresOi', n: 900, rho: 0.1, lo: 0.03, hi: 0.17 }],
  },
  'gate-validation': { note: 'n', taken: stat(0.1, 0, 0.29), gates: [{ code: 'POST_LOSS_COOLDOWN', refused: stat(0.12, -0.01, 0.26), diffVsTaken: { diff: 0.02, lo: -0.16, hi: 0.17, days: 20 }, verdict: 'INCONCLUSIVE' }] },
  'portfolio-risk': { note: 'n', baseline: { trades: 460, totalNetR: -14.8, meanNetR: -0.032, winRateAllTrades: 52, worstDayR: -7.8, bestDayR: 5.8, maxDrawdownR: 21.3, maxOpen: 29, maxSameDirection: 22 }, variants: [] },
};

describe('Evidence page', () => {
  beforeEach(() => {
    getEvidence = async () => null;
  });

  it('is part of the Performance area and resolvable from the URL', () => {
    expect(PERFORMANCE_PAGES).toContain('evidence');
    expect(resolveTab('evidence')).toEqual({ tab: 'evidence' });
  });

  it('shows the Old Indicator as a protected benchmark, never a demotion candidate', async () => {
    getEvidence = async (r: string) => REPORTS[r];
    const { EvidencePage } = await import('../index');
    render(<EvidencePage />);
    await waitFor(() => expect(screen.getAllByText('Old Indicator').length).toBeGreaterThan(0));
    expect(screen.getAllByText('PROTECTED BENCHMARK').length).toBeGreaterThan(0);
    expect(screen.getAllByText('DEMOTION CANDIDATE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('already SHADOW since 2026-10-08').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CARRIES INFORMATION').length).toBeGreaterThan(0);
  });

  it('says plainly when the server has not deployed the reports', async () => {
    getEvidence = () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
    const { EvidencePage } = await import('../index');
    render(<EvidencePage />);
    await waitFor(() => expect(screen.getAllByText(/not deployed on the server yet/).length).toBe(4));
  });
});
