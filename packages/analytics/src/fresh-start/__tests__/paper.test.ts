import { describe, it, expect } from 'vitest';
import { selectFreshContract, admitFreshPaper, advanceFreshPosition, type FreshPaperPosition, type FreshQuote } from '../paper.js';
import { FRESH_PACK_VERSION, type FreshCandidate } from '../strategies.js';
const at = 1800000000000;
export const candidate: FreshCandidate = { id: 'c1', parentId: 'p1', version: FRESH_PACK_VERSION, strategy: 'NEW_ORB_RETEST_V1', direction: 'BULLISH', instrument: 'NIFTY-FUT', sourceEpoch: 'e1', session: '2026-10-30', at, referenceEntry: 100, stop: 95, target: 115, atr: 4, expiresAt: at + 2000, origin: at - 100000, evidence: {} };
export function request() {
    return { candidate, contract: { id: 'option1', sourceEpoch: 'e1', source: 'ANGEL', lotQuantity: 25, multiplier: 1, expiryTradableSessions: 3, market: 'NSE_INDEX_OPTIONS' as const, delta: .55, metadataVerified: true, modelVerified: true, feesVerified: true, targetPremiumScenarios: [175, 170], invalidationPremiumScenarios: [90, 85], explicitRoundTripCostPerUnit: 1 },
        quote: { contract: 'option1', source: 'ANGEL', epoch: 'e1', eventAt: at + 300, receivedAt: at + 300, bid: 100, ask: 100.5, bidUnits: 5000, askUnits: 5000, tick: .5 }, account: { capital: 1000000, equity: 1000000, reservedRisk: 0, reservedPremium: 0, dailyNet: 0, openPositions: 0, consecutiveNetLosses: 0, marksComplete: true }, now: at + 300, arrivalAt: at + 250, currentUnderlying: 100, cutoff: at + 14400000, calendarVerified: true, eventClear: true, legacyPositionOpen: false, parentAlreadyTraded: false, correlatedPositionOpen: false, entriesToday: 0, barsSinceLastClose: null };
}
export function position(): FreshPaperPosition {
    const r = request(), a = admitFreshPaper(r);
    if (!a.ok)
        throw Error(a.code);
    return { id: 'c1', contract: r.contract, candidate, quantity: a.quantity, entry: a.entry, originalRiskCurrency: a.initialRiskCurrency, emergencyStop: a.emergencyStop, currentStop: a.emergencyStop, highBid: 100, openedAt: r.now, lastEventAt: r.now, state: 'OPEN', exitTriggeredAt: null, exitReason: null, exitPrice: null, netPnl: null, maxUnderlyingFavorable: 0 };
}
const q = (at: number, bid = 100): FreshQuote => ({ ...request().quote, eventAt: at, receivedAt: at, bid, ask: bid + .5 });
describe('fresh-start executable paper admission', () => {
    it('uses ask plus one tick, freezes risk and sizes whole lots', () => {
        const a = admitFreshPaper(request());
        expect(a.ok).toBe(true);
        if (!a.ok)
            return;
        expect(a.entry).toBe(101);
        expect(a.emergencyStop).toBe(76);
        expect(a.initialRiskPerUnit).toBe(26);
        expect(a.quantity).toBe(75);
        expect(a.initialRiskCurrency).toBe(1950);
        expect(a.riskRewardNet).toBeGreaterThan(1.5);
    });
    it.each(['eventClear', 'calendarVerified'] as const)('blocks missing %s', key => { const r = request(); r[key] = false; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'BLOCKED_REQUIRED_CAPABILITY' }); });
    it.each(['metadataVerified', 'modelVerified', 'feesVerified'] as const)('blocks unknown %s', key => { const r = request(); r.contract[key] = false; expect(admitFreshPaper(r).ok).toBe(false); });
    it.each([0, 11])('rejects index expiry sessions %s', days => { const r = request(); r.contract.expiryTradableSessions = days; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'EXPIRY_INELIGIBLE' }); });
    it('does not treat a newly received old quote as a post-latency fill', () => { const r = request(); r.quote.eventAt = at + 100; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' }); });
    it('rejects a changed source epoch and wrong contract', () => { const r = request(); r.quote.epoch = 'e2'; expect(admitFreshPaper(r).ok).toBe(false); r.quote.epoch = 'e1'; r.quote.contract = 'OTHER'; expect(admitFreshPaper(r).ok).toBe(false); });
    it('never forces one lot when risk, depth or capital cannot afford it', () => {
        for (const change of [(r: ReturnType<typeof request>) => r.account.capital = 100, (r: ReturnType<typeof request>) => r.quote.askUnits = 24, (r: ReturnType<typeof request>) => r.account.reservedRisk = 5000]) {
            const r = request();
            change(r);
            expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'ZERO_PERMITTED_LOTS' });
        }
    });
    it('permits a second unrelated position within aggregate and per-trade limits', () => { const r = request(); r.account.openPositions = 1; r.account.reservedRisk = 1950; r.account.reservedPremium = 7575; expect(admitFreshPaper(r).ok).toBe(true); });
    it('uses multiplier once in cash sizing and P&L', () => {
        const r = request();
        r.contract.multiplier = 2;
        const a = admitFreshPaper(r);
        expect(a.ok).toBe(true);
        if (a.ok)
            expect(a.initialRiskCurrency).toBe(a.quantity * 2 * a.initialRiskPerUnit);
    });
    it('blocks missing marks, daily loss, loss streak, parent reuse and legacy exposure', () => {
        for (const change of [(r: ReturnType<typeof request>) => r.account.marksComplete = false, (r: ReturnType<typeof request>) => r.account.dailyNet = -10000, (r: ReturnType<typeof request>) => r.account.consecutiveNetLosses = 3, (r: ReturnType<typeof request>) => r.parentAlreadyTraded = true, (r: ReturnType<typeof request>) => r.legacyPositionOpen = true]) {
            const r = request();
            change(r);
            expect(admitFreshPaper(r).ok).toBe(false);
        }
    });
    it('does not choose a farther target or bypass the worst IV scenario', () => { const r = request(); r.contract.targetPremiumScenarios = [200, 110]; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'NET_PAYOFF_TOO_LOW' }); });
    it('has the same positive premium geometry for bought puts', () => { const r = request(); r.candidate = { ...candidate, direction: 'BEARISH', stop: 105, target: 85 }; r.contract.delta = -.55; expect(admitFreshPaper(r).ok).toBe(true); });
});
describe('fresh-start exit event reduction', () => {
    const event = (at: number, underlying: number | null, quote: FreshQuote | null) => ({ at, underlying, underlyingAt: underlying == null ? null : at, quote, cutoff: candidate.at + 14400000, barsSinceFill: 1, trail: false });
    it('records an unresolved target with no executable quote, then fills a later bid at actual gap price', () => { const p = position(), t = at + 1000; const pending = advanceFreshPosition(p, event(t, 116, null)); expect(pending.state).toBe('EXIT_PENDING'); expect(pending.netPnl).toBeNull(); expect(advanceFreshPosition(pending, event(t + 200, 116, q(t + 200, 150))).state).toBe('EXIT_PENDING'); const closed = advanceFreshPosition(pending, event(t + 300, 116, q(t + 300, 70))); expect(closed.exitPrice).toBe(69.5); expect(closed.netPnl).toBe((69.5 - 101 - 1) * p.quantity); expect(advanceFreshPosition(closed, event(t + 400, 120, q(t + 400, 200)))).toBe(closed); });
    it('forces a cutoff even without underlying or option quotes', () => { const p = position(), e = event(at + 1000, null, null); e.cutoff = e.at + 600000; expect(advanceFreshPosition(p, e).exitReason).toBe('SESSION_CUTOFF'); });
    it('does not invent size-aware stops/fills from inadequate depth', () => { const p = position(), quote = { ...q(at + 1000, 60), bidUnits: 1 }; expect(advanceFreshPosition(p, event(at + 1000, 100, quote)).state).toBe('OPEN'); });
    it('trails upward after net 1R/2R, never reduces initial R or loosens a stop', () => { const p = position(), t = at + 1000; const n = advanceFreshPosition(p, { ...event(t, 102, q(t, 155)), trail: true }); expect(n.currentStop).toBe(128); expect(n.originalRiskCurrency).toBe(p.originalRiskCurrency); const next = advanceFreshPosition(n, { ...event(t + 300, 102, q(t + 300, 140)), trail: true }); expect(next.currentStop).toBe(128); const pe = { ...p, candidate: { ...p.candidate, direction: 'BEARISH' as const, stop: 105, target: 85 } }; expect(advanceFreshPosition(pe, { ...event(t, 98, q(t, 155)), trail: true }).currentStop).toBe(n.currentStop); });
    it('rejects out-of-order events and uses protective stop on a simultaneous target', () => { const p = position(); expect(advanceFreshPosition(p, event(p.lastEventAt, 90, q(p.lastEventAt)))).toBe(p); expect(advanceFreshPosition(p, event(at + 1000, 116, q(at + 1000, 60))).exitReason).toBe('PREMIUM_STOP'); });
    it('observes max hold and the adverse no-progress rule', () => { const p = position(); expect(advanceFreshPosition(p, { ...event(at + 1000, 99, null), barsSinceFill: 3 }).exitReason).toBe('NO_PROGRESS'); expect(advanceFreshPosition(p, { ...event(at + 1000, 101, null), barsSinceFill: 12 }).exitReason).toBe('MAX_HOLD'); });
});
it('bounds contract work and applies payoff gates before choosing a strike', () => { const r = request(); const one = { strike: 25000, expiry: '2026-11-03', contract: r.contract, quote: r.quote }; expect(selectFreshContract(r, [one]).selected?.admission.ok).toBe(true); expect(selectFreshContract(r, Array(11).fill(one)).refusals[0].code).toBe('SHORTLIST_LIMIT'); const bad = { ...one, contract: { ...r.contract, targetPremiumScenarios: [120, 110] } }; expect(selectFreshContract(r, [bad]).selected).toBeNull(); });
