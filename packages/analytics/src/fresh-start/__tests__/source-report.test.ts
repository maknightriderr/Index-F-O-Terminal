import { freshEventClearance } from '../events.js';
import { describe, it, expect } from 'vitest';
import { reconcileFreshSources, type FreshSourceState } from '../source.js';
import { freshPerformance } from '../report.js';
import { FRESH_PACK_VERSION } from '../strategies.js';
const at = 1800000000000;
const quote = (source: string, mid: number) => ({ source, mid, contract: 'c', epoch: 'e', eventAt: at, receivedAt: at, tick: .05 });
describe('fresh source authority and cohort evidence', () => {
    it('blocks after three aligned conflicts, waits 60 stable seconds and never promotes the secondary', () => {
        let s: FreshSourceState = { primary: 'ANGEL', epoch: 'e', consecutiveConflicts: 0, blocked: false, healthySince: null };
        for (let i = 0; i < 3; i++)
            s = reconcileFreshSources(s, quote('ANGEL', 100), quote('DHAN', 101), at);
        expect(s.blocked).toBe(true);
        s = reconcileFreshSources(s, quote('ANGEL', 100), quote('DHAN', 100), at);
        expect(s.blocked).toBe(true);
        s = reconcileFreshSources(s, { ...quote('ANGEL', 100), eventAt: at + 60000, receivedAt: at + 60000 }, { ...quote('DHAN', 100), eventAt: at + 60000, receivedAt: at + 60000 }, at + 60000);
        expect(s.blocked).toBe(false);
        expect(s.primary).toBe('ANGEL');
        expect(reconcileFreshSources(s, null, quote('DHAN', 100), at).blocked).toBe(true);
    });
    it('blocks unmapped contracts and a changed source epoch', () => { const s = { primary: 'ANGEL', epoch: 'e', consecutiveConflicts: 0, blocked: false, healthySince: null }; expect(reconcileFreshSources(s, { ...quote('ANGEL', 100), epoch: 'new' }, quote('DHAN', 100), at).blocked).toBe(true); expect(reconcileFreshSources(s, quote('ANGEL', 100), { ...quote('DHAN', 100), contract: 'OTHER' }, at).blocked).toBe(true); });
    it('uses only completed net results in this version, includes flat/pending counts and makes no empty-data claims', () => { const base = { strategy: 'NEW_ORB_RETEST_V1' as const, version: FRESH_PACK_VERSION, session: '2026-10-30', initialRisk: 100 }; const r = freshPerformance([{ ...base, state: 'CLOSED', netPnl: 150 }, { ...base, state: 'CLOSED', netPnl: -110 }, { ...base, state: 'CLOSED', netPnl: 0 }, { ...base, state: 'EXIT_PENDING', netPnl: null }, { ...base, version: 'LEGACY', state: 'CLOSED', netPnl: 9000 }])[0]; expect(r).toMatchObject({ filled: 4, closed: 3, wins: 1, losses: 1, flat: 1, pending: 1, netPnl: 40, independentSessions: 1, validation: 'NOT_VALIDATED', minimumSampleMet: false }); expect(r.winRate).toBe(1 / 3); expect(r.winRate95![0]).toBeLessThan(r.winRate!); expect(freshPerformance([])[0]).toMatchObject({ netPnl: null, winRate: null, profitFactor: null }); });
});
it('requires verified event coverage and blocks macro windows / issuer result sessions', () => {
    const base = { now: at, session: '2026-10-30', market: 'INDEX' as const, issuer: null, coverage: { verified: true, from: at - 1000000, to: at + 1000000, source: 'VERIFIED_TEST' }, events: [] };
    expect(freshEventClearance(base)).toBeNull();
    expect(freshEventClearance({ ...base, coverage: null })).toBe('BLOCKED_EVENT_COVERAGE');
    expect(freshEventClearance({ ...base, events: [{ at: at + 900000, kind: 'INDEX_MACRO', issuer: null, impact: 'HIGH', session: base.session }] })).toBe('INDEX_EVENT_BLACKOUT');
    expect(freshEventClearance({ ...base, market: 'STOCK', issuer: 'TCS', events: [{ at: at + 900001, kind: 'ISSUER_RESULTS', issuer: 'TCS', impact: 'HIGH', session: base.session }] })).toBe('ISSUER_RESULTS_DAY');
});
