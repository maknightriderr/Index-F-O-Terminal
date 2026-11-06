import { describe, it, expect } from 'vitest';
import { selectFreshContract, admitFreshPaper, advanceFreshPosition, FRESH_THIN_BOOK_GRACE_MS, FRESH_THIN_BOOK_HAIRCUT, type FreshPaperPosition, type FreshQuote } from '../paper.js';
import { FRESH_PACK_VERSION, type FreshCandidate } from '../strategies.js';
import {at,candidate,request,position} from './fixtures.js';
const q = (at: number, bid = 100): FreshQuote => ({ ...request().quote, eventAt: at, receivedAt: at, bid, ask: bid + .5 });
describe('fresh-start executable paper admission', () => {
    it('uses ask plus one tick, freezes risk and sizes whole lots', () => {
        const a = admitFreshPaper(request());
        expect(a.ok).toBe(true);
        if (!a.ok)
            return;
        expect(a.entry).toBe(101);
        expect(a.emergencyStop).toBe(76);
        expect(a.initialRiskPerUnit).toBe(26.5);
        // 0.5% of INR 10,00,000 = INR 5,000 budget; 26.5 per unit × 25 per lot → 7 whole lots.
        expect(a.quantity).toBe(175);
        expect(a.initialRiskCurrency).toBe(4637.5);
        expect(a.riskRewardNet).toBeGreaterThan(1.5);
    });
    it.each(['eventClear', 'calendarVerified'] as const)('blocks missing %s', key => { const r = request(); r[key] = false; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'BLOCKED_REQUIRED_CAPABILITY' }); });
    it.each(['metadataVerified', 'modelVerified', 'feesVerified'] as const)('blocks unknown %s', key => { const r = request(); r.contract[key] = false; expect(admitFreshPaper(r).ok).toBe(false); });
    it.each([0, 26])('rejects index expiry sessions %s (25 is the monthly-series ceiling)', days => { const r = request(); r.contract.expiryTradableSessions = days; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'EXPIRY_INELIGIBLE' }); });
    it('does not treat a newly received old quote as a post-latency fill', () => { const r = request(); r.quote.eventAt = at + 100; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' }); });
    it('rejects a changed source epoch and wrong contract', () => { const r = request(); r.quote.epoch = 'e2'; expect(admitFreshPaper(r).ok).toBe(false); r.quote.epoch = 'e1'; r.quote.contract = 'OTHER'; expect(admitFreshPaper(r).ok).toBe(false); });
    it('never forces one lot when risk, depth or capital cannot afford it', () => {
        // 2.0: reserved open risk no longer shrinks the size (it is recorded); paper cash still bounds it.
        for (const change of [(r: ReturnType<typeof request>) => r.account.capital = 100, (r: ReturnType<typeof request>) => r.quote.askUnits = 24, (r: ReturnType<typeof request>) => r.account.reservedPremium = r.account.equity]) {
            const r = request();
            change(r);
            expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'ZERO_PERMITTED_LOTS' });
        }
        const r = request(); r.account.reservedRisk = 10000;
        expect(admitFreshPaper(r)).toMatchObject({ ok: true, riskFlags: ['WOULD_BLOCK_OPEN_RISK'] });
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
    it('blocks missing marks, parent reuse, a second position on the instrument and legacy exposure', () => {
        for (const change of [(r: ReturnType<typeof request>) => r.account.marksComplete = false, (r: ReturnType<typeof request>) => r.parentAlreadyTraded = true, (r: ReturnType<typeof request>) => r.legacyPositionOpen = true, (r: ReturnType<typeof request>) => r.instrumentPositionOpen = true, (r: ReturnType<typeof request>) => r.account.cohortNet = NaN]) {
            const r = request();
            change(r);
            expect(admitFreshPaper(r).ok).toBe(false);
        }
    });
    it('2.0: records a loss streak, daily loss and open-position count instead of refusing (paper)', () => {
        const streak = request(); streak.account.consecutiveNetLosses = 3;
        expect(admitFreshPaper(streak)).toMatchObject({ ok: true, riskFlags: ['WOULD_PAUSE_3_LOSSES'] });
        const daily = request(); daily.account.dailyNet = -10000;
        const d = admitFreshPaper(daily);
        expect(d.ok && d.riskFlags).toEqual(expect.arrayContaining(['WOULD_PAUSE_DAILY_LOSS', 'WOULD_BLOCK_OPEN_RISK']));
        const busy = request(); busy.account.openPositions = 5;
        expect(admitFreshPaper(busy)).toMatchObject({ ok: true, riskFlags: ['WOULD_BLOCK_MAX_OPEN'] });
        expect(admitFreshPaper(request())).toMatchObject({ ok: true, riskFlags: [] });
    });
    it('does not choose a farther target or bypass the worst IV scenario', () => { const r = request(); r.contract.targetPremiumScenarios = [200, 110]; expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'NET_PAYOFF_TOO_LOW' }); });
    it('has the same positive premium geometry for bought puts', () => { const r = request(); r.candidate = { ...candidate, direction: 'BEARISH', stop: 105, target: 85 }; r.contract.delta = -.55; expect(admitFreshPaper(r).ok).toBe(true); });
});
describe('fresh-start exit event reduction', () => {
    const event = (at: number, underlying: number | null, quote: FreshQuote | null) => ({ at, underlying, underlyingAt: underlying == null ? null : at, quote, cutoff: candidate.at + 14400000, barsSinceFill: 1, trail: false });
    it('records an unresolved target with no executable quote, then fills a later bid at actual gap price', () => { const p = position(), t = at + 1000; const pending = advanceFreshPosition(p, event(t, 116, null)); expect(pending.state).toBe('EXIT_PENDING'); expect(pending.netPnl).toBeNull(); expect(advanceFreshPosition(pending, event(t + 200, 116, q(t + 200, 150))).state).toBe('EXIT_PENDING'); const closed = advanceFreshPosition(pending, event(t + 300, 116, q(t + 300, 70))); expect(closed.exitPrice).toBe(69.5); expect(closed.netPnl).toBe((69.5 - 101 - 1) * p.quantity); expect(advanceFreshPosition(closed, event(t + 400, 120, q(t + 400, 200)))).toBe(closed); });
    it('forces a cutoff even without underlying or option quotes', () => { const p = position(), e = event(at + 1000, null, null); e.cutoff = e.at + 600000; expect(advanceFreshPosition(p, e).exitReason).toBe('SESSION_CUTOFF'); });
    it('fires the premium stop on price even when the book is thinner than the position, but delays the fill', () => {
        const p = position(), t = at + 1000, thin = (time: number, bid: number) => ({ ...q(time, bid), bidUnits: 1 });
        const pending = advanceFreshPosition(p, event(t, 100, thin(t, 60)));
        expect(pending.state).toBe('EXIT_PENDING');
        expect(pending.exitReason).toBe('PREMIUM_STOP');
        // Inside the grace window a thin book does not fill; an absent quote never fills.
        expect(advanceFreshPosition(pending, event(t + 30000, 100, thin(t + 30000, 59))).state).toBe('EXIT_PENDING');
        expect(advanceFreshPosition(pending, event(t + FRESH_THIN_BOOK_GRACE_MS + 1000, 100, null)).state).toBe('EXIT_PENDING');
        // After the grace window the displayed unit fills at bid − 1 tick and the remainder at the haircut, never better.
        const closed = advanceFreshPosition(pending, event(t + FRESH_THIN_BOOK_GRACE_MS + 1000, 100, thin(t + FRESH_THIN_BOOK_GRACE_MS + 1000, 58)));
        expect(closed.state).toBe('CLOSED');
        expect(closed.exitReason).toBe('PREMIUM_STOP+THIN_BOOK_HAIRCUT');
        expect(closed.exitPrice!).toBeLessThan(58);
        expect(closed.exitPrice!).toBeGreaterThanOrEqual(Math.floor(58 * (1 - FRESH_THIN_BOOK_HAIRCUT) / q(0).tick) * q(0).tick - 1e-9);
        expect(closed.netPnl!).toBeLessThan(0);
    });
    it('trails upward after net 1R/2R, never reduces initial R or loosens a stop', () => { const p = position(), t = at + 1000; const n = advanceFreshPosition(p, { ...event(t, 102, q(t, 155)), trail: true }); expect(n.currentStop).toBe(128.5); expect(n.originalRiskCurrency).toBe(p.originalRiskCurrency); const next = advanceFreshPosition(n, { ...event(t + 300, 102, q(t + 300, 140)), trail: true }); expect(next.currentStop).toBe(128.5); const pe = { ...p, candidate: { ...p.candidate, direction: 'BEARISH' as const, stop: 105, target: 85 } }; expect(advanceFreshPosition(pe, { ...event(t, 98, q(t, 155)), trail: true }).currentStop).toBe(n.currentStop); });
    it('rejects out-of-order events and uses protective stop on a simultaneous target', () => { const p = position(); expect(advanceFreshPosition(p, event(p.lastEventAt, 90, q(p.lastEventAt)))).toBe(p); expect(advanceFreshPosition(p, event(at + 1000, 116, q(at + 1000, 60))).exitReason).toBe('PREMIUM_STOP'); });
    it('observes max hold and the adverse no-progress rule', () => { const p = position(); expect(advanceFreshPosition(p, { ...event(at + 1000, 99, null), barsSinceFill: 3 }).exitReason).toBe('NO_PROGRESS'); expect(advanceFreshPosition(p, { ...event(at + 1000, 101, null), barsSinceFill: 12 }).exitReason).toBe('MAX_HOLD'); });
});
it('bounds contract work and applies payoff gates before choosing a strike', () => { const r = request(); const one = { strike: 25000, expiry: '2026-11-03', contract: r.contract, quote: r.quote }; expect(selectFreshContract(r, [one]).selected?.admission.ok).toBe(true); expect(selectFreshContract(r, Array(11).fill(one)).refusals[0].code).toBe('SHORTLIST_LIMIT'); const bad = { ...one, contract: { ...r.contract, targetPremiumScenarios: [120, 110] } }; expect(selectFreshContract(r, [bad]).selected).toBeNull(); });
describe('1.5 structural invalidation on a 5-minute close (E-03)', () => {
    const event = (t: number, underlying: number, close: { price: number; closedAt: number } | null) => ({ at: t, underlying, underlyingAt: t, quote: q(t, 100), cutoff: candidate.at + 14400000, barsSinceFill: 1, trail: false, underlyingClose: close });
    it('ignores a wick through the stop while the completed bar closed above it', () => {
        const p = position(), t = p.openedAt + 300000;
        expect(advanceFreshPosition(p, event(t, 94.5, { price: 96, closedAt: t - 1000 })).state).toBe('OPEN');
        expect(advanceFreshPosition(p, event(t, 94.5, null)).state).toBe('OPEN');
    });
    it('exits once a completed bar after the fill closes beyond the stop', () => {
        const p = position(), t = p.openedAt + 300000;
        expect(advanceFreshPosition(p, event(t, 96, { price: 94.9, closedAt: t - 1000 })).exitReason).toBe('STRUCTURAL_INVALIDATION');
        // A bar that closed before the fill is not evidence about this trade.
        expect(advanceFreshPosition(p, event(t, 96, { price: 94.9, closedAt: p.openedAt - 1 })).state).toBe('OPEN');
    });
    it('keeps the tick rule for callers that do not supply bar closes', () => {
        const p = position(), t = p.openedAt + 1000;
        expect(advanceFreshPosition(p, { ...event(t, 94.5, null), underlyingClose: undefined }).exitReason).toBe('STRUCTURAL_INVALIDATION');
    });
});
describe('1.5 risk policy', () => {
    it('sizes 0.5% per trade, keeps 1% open risk and a 1% daily limit', () => {
        const r = request();
        r.account.capital = r.account.equity = 500000;
        const a = admitFreshPaper(r);
        expect(a.ok && a.initialRiskCurrency).toBeLessThanOrEqual(2500);
        expect(a.ok && a.quantity).toBe(75); // INR 2,500 / (26.5 × 25) → 3 lots
        // 2.0: the same 0.5% size after the 1% open-risk / daily budgets are used; a live account would have skipped it.
        const full = request(); full.account.capital = full.account.equity = 500000; full.account.reservedRisk = 5000;
        expect(admitFreshPaper(full)).toMatchObject({ ok: true, quantity: 75, riskFlags: ['WOULD_BLOCK_OPEN_RISK'] });
        const down = request(); down.account.capital = down.account.equity = 500000; down.account.dailyNet = -5000;
        expect(admitFreshPaper(down)).toMatchObject({ ok: true, quantity: 75, riskFlags: ['WOULD_PAUSE_DAILY_LOSS', 'WOULD_BLOCK_OPEN_RISK'] });
    });
    it('flags the cohort at a 5% cumulative net loss', () => {
        const r = request(); r.account.capital = r.account.equity = 500000; r.account.cohortNet = -24999;
        expect(admitFreshPaper(r).ok).toBe(true);
        r.account.cohortNet = -25000;
        expect(admitFreshPaper(r)).toMatchObject({ ok: true, riskFlags: ['WOULD_PAUSE_COHORT'] }); // 2.0: recorded in paper
    });
});
describe('full-size MCX crude lot (100 bbl) at INR 30 lakh', () => {
    const crude = (capital: number) => {
        const r = request();
        r.account.capital = r.account.equity = capital;
        r.contract = { ...r.contract, lotQuantity: 100, targetPremiumScenarios: [800, 790], invalidationPremiumScenarios: [400, 390] };
        r.quote = { ...r.quote, bid: 500, ask: 500.1, tick: .1 };
        return admitFreshPaper(r);
    };
    it('fits one lot at INR 30 lakh (0.5% = 15,000 risk, 5% = 1.5 lakh premium)', () => {
        const a = crude(3000000);
        expect(a.ok).toBe(true);
        if (a.ok) { expect(a.quantity).toBe(100); expect(a.initialRiskCurrency).toBeLessThanOrEqual(15000); expect(a.premiumCurrency).toBeLessThanOrEqual(150000); }
    });
    it('is refused at INR 5 lakh', () => { expect(crude(500000)).toEqual({ ok: false, code: 'ZERO_PERMITTED_LOTS' }); });
});
