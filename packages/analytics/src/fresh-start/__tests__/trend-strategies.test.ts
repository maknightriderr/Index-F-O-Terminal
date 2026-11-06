import { describe, expect, it } from 'vitest';
import { evaluateFreshStrategies, FRESH_TREND_TRAIL_ATR, type FreshBar, type FreshContext } from '../strategies.js';
import { advanceFreshPosition, freshTrailingStop, FRESH_TREND_MAX_HOLD_BARS, type FreshPaperPosition } from '../paper.js';
import { at, position } from './fixtures.js';

// Same synthetic session as strategies.test.ts: 105 flat earlier bars (ATR ~2), flat 1-minute VWAP at 100, a strong
// rising 15-minute trend, rvol references of 1000 per slot.
const open = 1800000000000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): FreshBar => ({ time: open + i * 300000, availableAt: open + (i + 1) * 300000, open: o, high: h, low: l, close: c, volume: v });
function context(today: FreshBar[], extra: Partial<FreshContext> = {}): FreshContext {
    const now = today.at(-1)!.time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => ({ time: open - (105 - i) * 300000, availableAt: open - (104 - i) * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const bars15 = Array.from({ length: 80 }, (_, i) => ({ time: open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, availableAt: 0, open: 96 + i * .1, high: 97 + i * .1, low: 95 + i * .1, close: 96 + i * .1, volume: 1000 }));
    return { now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: 'CRUDEOIL-FUT', sourceEpoch: 'e1', bars5: [...prior, ...today], bars15: bars15.map(x => ({ ...x, availableAt: x.time + 900000 })), bars1: Array.from({ length: today.length * 5 }, (_, i) => ({ time: open + i * 60000, availableAt: open + (i + 1) * 60000, open: 100, high: 101, low: 99, close: 100, volume: 1000 })), rvolReferences: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000), levels: [{ price: 125, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 125, previousLow: 95, referenceVerified: true, eventClear: true, calendarVerified: true, ...extra };
}
const mirror = (c: FreshContext): FreshContext => {
    const m = (b: FreshBar) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close });
    return { ...c, bars5: c.bars5.map(m), bars15: c.bars15.map(m), bars1: c.bars1.map(m), levels: [{ price: 125, role: 'SUPPORT', knownAt: open - 1, kind: 'PDL' }], previousHigh: 155, previousLow: 125 };
};
const find = (c: FreshContext, s: string) => evaluateFreshStrategies(c).candidates.find(x => x.strategy === s);
const refusal = (c: FreshContext, s: string) => evaluateFreshStrategies(c).refusals.find(x => x.strategy === s);

// A quiet drift, then one wide, strong, high-volume bar through the session high.
const quiet = [bar(0, 100, 101, 99.5, 100.5), bar(1, 100.5, 101.2, 100.2, 100.8), bar(2, 100.8, 101.3, 100.5, 101), bar(3, 101, 101.4, 100.7, 101.1), bar(4, 101.1, 101.5, 100.9, 101.2), bar(5, 101.2, 101.6, 101, 101.3)];
const momentumDay = [...quiet, bar(6, 101.3, 104.6, 101.2, 104.4, 2500)];

describe('1.8 momentum breakout', () => {
    it('takes a strong close through the session extreme in both directions, with a trailing exit', () => {
        for (const [c, d] of [[context(momentumDay), 'BULLISH'], [mirror(context(momentumDay)), 'BEARISH']] as const) {
            const x = find(c, 'NEW_MOMENTUM_BREAKOUT_V1');
            expect(x, JSON.stringify(evaluateFreshStrategies(c).refusals)).toMatchObject({ direction: d, exitProfile: 'TREND', trailAtr: FRESH_TREND_TRAIL_ATR });
            expect(Math.abs(x!.referenceEntry - x!.stop)).toBeLessThanOrEqual(2 * x!.atr);
        }
    });
    it('1.9: takes an ordinary breakout bar (~1 ATR, 55% body, close in the top 30%) that 1.8 refused, still refuses a weak one', () => {
        // 5 Nov: NIFTY's breakouts of the day's high were refused MOM_BAR_QUALITY (1.2 ATR / 60% body / 70% close).
        const ordinary = [...quiet, bar(6, 101.5, 103.2, 101.2, 102.6, 2500)];
        for (const [c, d] of [[context(ordinary), 'BULLISH'], [mirror(context(ordinary)), 'BEARISH']] as const)
            expect(find(c, 'NEW_MOMENTUM_BREAKOUT_V1'), JSON.stringify(refusal(c, 'NEW_MOMENTUM_BREAKOUT_V1'))).toMatchObject({ direction: d });
        const indecisive = [...quiet, bar(6, 101.8, 103.2, 101.2, 102.6, 2500)]; // 40% body
        expect(refusal(context(indecisive), 'NEW_MOMENTUM_BREAKOUT_V1')).toMatchObject({ code: 'SETUP_CONDITIONS_NOT_MET', detail: 'MOM_BAR_QUALITY' });
    });
    it('1.11: takes a breakout ~4 ATR from VWAP (a trend day), still refuses one beyond 5 ATR', () => {
        const atVwap = (c: FreshContext, p: number): FreshContext => ({ ...c, bars1: c.bars1.map(x => ({ ...x, open: p, high: p, low: p, close: p })) });
        const c = context(momentumDay), a = evaluateFreshStrategies(c).candidates.find(x => x.strategy === 'NEW_MOMENTUM_BREAKOUT_V1')!.atr;
        expect(find(atVwap(c, 104.4 - 4 * a), 'NEW_MOMENTUM_BREAKOUT_V1')).toBeDefined();
        expect(refusal(atVwap(c, 104.4 - 5.5 * a), 'NEW_MOMENTUM_BREAKOUT_V1')).toMatchObject({ code: 'SETUP_CONDITIONS_NOT_MET', detail: 'MOM_EXTENDED_OR_CHASED' });
    });
    it('refuses normal volume, a weak bar and the first half hour, naming the gate', () => {
        const lowVol = [...quiet, bar(6, 101.3, 104.6, 101.2, 104.4, 1500)];
        expect(refusal(context(lowVol), 'NEW_MOMENTUM_BREAKOUT_V1')).toMatchObject({ code: 'SETUP_CONDITIONS_NOT_MET', detail: 'MOM_VOLUME' });
        const weak = [...quiet, bar(6, 101.3, 104.6, 101.2, 101.9, 2500)];
        expect(find(context(weak), 'NEW_MOMENTUM_BREAKOUT_V1')).toBeUndefined();
        const early = momentumDay.slice(2).map((b, i) => ({ ...b, time: open + i * 300000, availableAt: open + (i + 1) * 300000 }));
        expect(refusal(context(early), 'NEW_MOMENTUM_BREAKOUT_V1')?.detail).toBe('MOM_FIRST_30_MIN');
    });
    it('trades a reversal day against the 15-minute EMA stack once price is through the 15-minute EMA20', () => {
        // A long rising 15-minute history (EMA20 above EMA50), then the last 15-minute close collapses below EMA20.
        const c = mirror(context(momentumDay));
        // Rising 15-minute history in the mirrored price region (~140 → ~148: EMA20 above EMA50), last close back at 145.
        const h = c.bars15.map((x, i) => ({ ...x, open: 140 + i * .1, high: 141 + i * .1, low: 139 + i * .1, close: 140 + i * .1 }));
        const reversal = { ...c, bars15: [...h.slice(0, -1), { ...h[h.length - 1], open: 148, high: 148.2, low: 144.8, close: 145 }] };
        expect(find(reversal, 'NEW_MOMENTUM_BREAKOUT_V1'), JSON.stringify(evaluateFreshStrategies(reversal).refusals)).toMatchObject({ direction: 'BEARISH' });
    });
    it('does not chase a move that already closed at new highs repeatedly', () => {
        const chase = [bar(0, 100, 100.6, 99.8, 100.4), bar(1, 100.4, 101.2, 100.3, 101.1), bar(2, 101.1, 101.9, 101, 101.8), bar(3, 101.8, 102.6, 101.7, 102.5), bar(4, 102.5, 103.3, 102.4, 103.2), bar(5, 103.2, 104, 103.1, 103.9), bar(6, 103.9, 106.6, 103.8, 106.4, 2500)];
        expect(find(context(chase), 'NEW_MOMENTUM_BREAKOUT_V1')).toBeUndefined();
    });
});

// Opening, a three-bar pole, a tight three-bar flag on lower volume, then the break.
const flagDay = [bar(0, 100, 100.5, 99.5, 100.2), bar(1, 100.2, 100.6, 99.8, 100.3), bar(2, 100.3, 100.7, 100, 100.4), bar(3, 100.4, 102.2, 100.3, 102, 2000), bar(4, 102, 103.8, 101.9, 103.6, 2000), bar(5, 103.6, 105.3, 103.5, 105, 2000), bar(6, 105, 105.2, 104.4, 104.6, 800), bar(7, 104.6, 105, 104.3, 104.8, 700), bar(8, 104.8, 105.1, 104.4, 104.9, 800), bar(9, 104.9, 106.6, 104.8, 106.4, 1500)];

describe('1.8 trend flag', () => {
    it('enters the break of a tight flag after a strong pole, stop beyond the flag', () => {
        const x = find(context(flagDay), 'NEW_TREND_FLAG_V1');
        expect(x, JSON.stringify(evaluateFreshStrategies(context(flagDay)).refusals)).toMatchObject({ direction: 'BULLISH', exitProfile: 'TREND', origin: open + 3 * 300000 });
        expect(x!.stop).toBeLessThan(104.3);
        expect(find(mirror(context(flagDay)), 'NEW_TREND_FLAG_V1')).toMatchObject({ direction: 'BEARISH' });
    });
    it('refuses a loose flag and a flag on rising volume', () => {
        const loose = flagDay.map((b, i) => (i === 7 ? { ...b, low: 101.5, close: 102 } : b));
        expect(find(context(loose), 'NEW_TREND_FLAG_V1')).toBeUndefined();
        const heavy = flagDay.map((b, i) => (i >= 6 && i <= 8 ? { ...b, volume: 3000 } : b));
        expect(find(context(heavy), 'NEW_TREND_FLAG_V1')).toBeUndefined();
    });
});

// Flat until a release at bar 6; bars 6–8 form the post-release range; bar 9 is the first close out of it.
const eventDay = [...Array.from({ length: 6 }, (_, i) => bar(i, 100, 100.6, 99.6, 100.1)), bar(6, 100.1, 101.5, 99.5, 100.4), bar(7, 100.4, 101.3, 99.8, 100.9), bar(8, 100.9, 101.4, 100.2, 101), bar(9, 101, 103.2, 100.9, 103, 1600)];

describe('1.8 event breakout', () => {
    const release = open + 6 * 300000;
    it('takes the first close out of the 15-minute post-release range', () => {
        const x = find(context(eventDay, { recentReleases: [release] }), 'NEW_EVENT_BREAKOUT_V1');
        expect(x).toMatchObject({ direction: 'BULLISH', exitProfile: 'TREND', origin: release });
        expect(find(mirror(context(eventDay, { recentReleases: [release] })), 'NEW_EVENT_BREAKOUT_V1')).toMatchObject({ direction: 'BEARISH' });
    });
    it('needs a release, and only the first break counts', () => {
        expect(refusal(context(eventDay), 'NEW_EVENT_BREAKOUT_V1')?.detail).toBe('EVENT_NO_RECENT_RELEASE');
        const second = [...eventDay.slice(0, 9), bar(9, 101, 102.4, 100.9, 102.2, 1600), bar(10, 102.2, 102.4, 101.8, 102, 1000), bar(11, 102, 104, 101.9, 103.8, 1700)];
        expect(find(context(second, { recentReleases: [release] }), 'NEW_EVENT_BREAKOUT_V1')).toBeUndefined();
    });
});

describe('1.8 trailing exit (paper engine)', () => {
    const trendPosition = (): FreshPaperPosition => {
        const p = position();
        return { ...p, candidate: { ...p.candidate, referenceEntry: 100, stop: 97, target: 107.5, atr: 1, exitProfile: 'TREND', trailAtr: 2 } };
    };
    const ev = (t: number, underlying: number, close: number | null, bars = 5) => ({ at: t, underlying, underlyingAt: t, quote: null, cutoff: at + 14400000, barsSinceFill: bars, trail: false, underlyingClose: close == null ? null : { price: close, closedAt: t } });
    it('keeps the structural stop until the best price is 2 ATR clear, then trails 2 ATR behind it', () => {
        const p = trendPosition();
        expect(freshTrailingStop(p)).toBeNull();
        expect(freshTrailingStop({ ...p, maxUnderlyingFavorable: 1.5 })).toBeNull();
        expect(freshTrailingStop({ ...p, maxUnderlyingFavorable: 6 })).toBe(104);
        expect(freshTrailingStop(position())).toBeNull();
    });
    it('rides past the nominal target and exits on a close below the trail as TRAILING_STOP', () => {
        let p = trendPosition();
        p = advanceFreshPosition(p, ev(at + 1000, 108, 108)); // past the 107.5 nominal target: no target exit
        expect(p.state).toBe('OPEN');
        expect(freshTrailingStop(p)).toBe(106);
        p = advanceFreshPosition(p, ev(at + 2000, 106.4, 106.4));
        expect(p.state).toBe('OPEN');
        p = advanceFreshPosition(p, ev(at + 3000, 106.2, 105.9)); // a five-minute close below the 106 trail
        expect(p).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'TRAILING_STOP' });
    });
    it('holds a trend position up to the longer limit only', () => {
        const p = trendPosition();
        expect(advanceFreshPosition(p, ev(at + 1000, 101, 101, 12)).state).toBe('OPEN');
        expect(advanceFreshPosition(p, ev(at + 1000, 101, 101, FRESH_TREND_MAX_HOLD_BARS))).toMatchObject({ exitReason: 'MAX_HOLD' });
        expect(advanceFreshPosition(position(), { ...ev(at + 1000, 101, 101, 12) })).toMatchObject({ exitReason: 'MAX_HOLD' });
    });
});

describe('5 Nov: no daily entry cap per instrument', () => {
    it('admits a third entry on the same instrument when every other exposure rule passes', async () => {
        const { admitFreshPaper } = await import('../paper.js');
        const { request } = await import('./fixtures.js');
        expect(admitFreshPaper({ ...request(), entriesToday: 5 }).ok).toBe(true);
        // 2.0: a re-entry cooldown and a same-group position are recorded in paper; the same instrument is still refused.
        expect(admitFreshPaper({ ...request(), entriesToday: 5, barsSinceLastClose: 1 })).toMatchObject({ ok: true, riskFlags: ['WOULD_BLOCK_REENTRY_COOLDOWN'] });
        expect(admitFreshPaper({ ...request(), entriesToday: 5, correlatedPositionOpen: true })).toMatchObject({ ok: true, riskFlags: ['WOULD_BLOCK_CORRELATED'] });
        expect(admitFreshPaper({ ...request(), entriesToday: 5, instrumentPositionOpen: true })).toMatchObject({ ok: false, code: 'EXPOSURE_OR_PARENT' });
    });
});

describe('order flow is shadow evidence only', () => {
    it('tags a candidate with the flow, and the same candidate is emitted with or without it', () => {
        const bars = [{ time: open + 6 * 300000, buy: 900, sell: 100, unclassified: 0, trades: 50 }];
        const withFlow = find(context(momentumDay, { orderFlow: { source: 'DHAN', instrument: 'X', proxy: false, bars } }), 'NEW_MOMENTUM_BREAKOUT_V1')!;
        const without = find(context(momentumDay), 'NEW_MOMENTUM_BREAKOUT_V1')!;
        expect((withFlow.evidence.orderFlow as { alignment: string }).alignment).toBe('ALIGNED');
        expect((without.evidence.orderFlow as { alignment: string }).alignment).toBe('UNAVAILABLE');
        expect({ ...withFlow, evidence: {} }).toEqual({ ...without, evidence: {} });
        const opposed = find(context(momentumDay, { orderFlow: { source: 'DHAN', instrument: 'X', proxy: false, bars: [{ ...bars[0], buy: 100, sell: 900 }] } }), 'NEW_MOMENTUM_BREAKOUT_V1')!;
        expect((opposed.evidence.orderFlow as { alignment: string }).alignment).toBe('OPPOSED');
    });
});
