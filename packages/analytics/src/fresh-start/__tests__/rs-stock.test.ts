// 2.0 NEW_RS_STOCK_V1: a stock leading / lagging NIFTY with aligned futures OI, entered on a VWAP / EMA20 hold or a
// tight-base break. Same synthetic session as trend-strategies.test.ts (ATR ~1.5-2, rising 15-minute trend).
import { describe, expect, it } from 'vitest';
import { evaluateFreshStrategies, FRESH_ALL_STRATEGIES, FRESH_SHADOW_STRATEGIES, FRESH_INTEL_MAX_AGE_MS, type FreshBar, type FreshContext, type FreshStockIntel } from '../strategies.js';

const open = 1800000000000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): FreshBar => ({ time: open + i * 300000, availableAt: open + (i + 1) * 300000, open: o, high: h, low: l, close: c, volume: v });
const VWAP = 101.2;
function context(today: FreshBar[], extra: Partial<FreshContext> = {}): FreshContext {
    const now = today.at(-1)!.time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => ({ time: open - (105 - i) * 300000, availableAt: open - (104 - i) * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const bars15 = Array.from({ length: 80 }, (_, i) => ({ time: open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, availableAt: 0, open: 96 + i * .1, high: 97 + i * .1, low: 95 + i * .1, close: 96 + i * .1, volume: 1000 }));
    return { now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: 'NSE_FO:STOCK', sourceEpoch: 'e1', bars5: [...prior, ...today], bars15: bars15.map(x => ({ ...x, availableAt: x.time + 900000 })), bars1: Array.from({ length: today.length * 5 }, (_, i) => ({ time: open + i * 60000, availableAt: open + (i + 1) * 60000, open: VWAP, high: VWAP, low: VWAP, close: VWAP, volume: 1000 })), rvolReferences: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000), levels: [{ price: 125, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 125, previousLow: 95, referenceVerified: true, eventClear: true, calendarVerified: true, stockIntel: intel(now), ...extra };
}
const intel = (now: number, x: Partial<FreshStockIntel> = {}): FreshStockIntel => ({ at: now - 60000, relativeStrength: 1.4, oiInterpretation: 'LONG_BUILDUP', sectorRelativeStrength: 0.5, atmSpreadPct: 0.6, ivRank: 40, ...x });
const mirror = (c: FreshContext): FreshContext => {
    const m = (b: FreshBar) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close });
    return { ...c, bars5: c.bars5.map(m), bars15: c.bars15.map(m), bars1: c.bars1.map(m), levels: [{ price: 125, role: 'SUPPORT', knownAt: open - 1, kind: 'PDL' }], previousHigh: 155, previousLow: 125, stockIntel: intel(c.now, { relativeStrength: -1.4, oiInterpretation: 'SHORT_BUILDUP', sectorRelativeStrength: -0.5 }) };
};
const S = 'NEW_RS_STOCK_V1';
const find = (c: FreshContext) => evaluateFreshStrategies(c).candidates.find(x => x.strategy === S);
const refusal = (c: FreshContext) => evaluateFreshStrategies(c).refusals.find(x => x.strategy === S);

// Ten bars above VWAP (101.2), a pullback whose low touches VWAP (bar 7), then a resumption bar on 1.6x volume.
const trend = [bar(0, 101.3, 101.8, 101.25, 101.6), bar(1, 101.6, 102.2, 101.5, 102.0), bar(2, 102.0, 102.5, 101.8, 102.3), bar(3, 102.3, 102.8, 102.1, 102.6), bar(4, 102.6, 103.0, 102.3, 102.8), bar(5, 102.8, 103.1, 102.4, 102.5)];
const pullbackDay = [...trend, bar(6, 102.5, 102.6, 101.8, 101.9), bar(7, 101.9, 102.0, 101.3, 101.4), bar(8, 101.4, 101.9, 101.35, 101.8), bar(9, 101.8, 102.7, 101.75, 102.6, 1600)];
// The same trend, then four bars inside 0.4 points and a close out of the top on 1.6x volume.
const baseDay = [...trend, bar(6, 102.5, 102.7, 102.4, 102.6), bar(7, 102.6, 102.75, 102.45, 102.55), bar(8, 102.55, 102.8, 102.5, 102.7), bar(9, 102.7, 102.8, 102.45, 102.6), bar(10, 102.6, 103.6, 102.55, 103.5, 1600)];

describe('2.0 NEW_RS_STOCK_V1', () => {
    it('is an active (not shadow) strategy', () => {
        expect(FRESH_ALL_STRATEGIES).toContain(S);
        expect(FRESH_SHADOW_STRATEGIES.has(S)).toBe(false);
    });
    it('takes a VWAP hold on a stock in play in both directions, with a trailing exit and the scan inputs as evidence', () => {
        for (const [c, d] of [[context(pullbackDay), 'BULLISH'], [mirror(context(pullbackDay)), 'BEARISH']] as const) {
            const x = find(c);
            expect(x, JSON.stringify(refusal(c))).toMatchObject({ direction: d, exitProfile: 'TREND' });
            expect(Math.abs(x!.referenceEntry - x!.stop)).toBeLessThanOrEqual(1.2 * x!.atr + 1e-9);
            expect(x!.evidence.stockIntel).toMatchObject({ relativeStrength: d === 'BULLISH' ? 1.4 : -1.4 });
        }
    });
    it('takes a break out of a tight base', () => {
        const c = context(baseDay), x = find(c);
        expect(x, JSON.stringify(refusal(c))).toMatchObject({ direction: 'BULLISH', exitProfile: 'TREND' });
        expect(x!.stop).toBeLessThan(102.45);
    });
    it('names the gate that stopped it', () => {
        const at = (x: Partial<FreshStockIntel>) => { const c = context(pullbackDay); return { ...c, stockIntel: intel(c.now, x) }; };
        expect(refusal(at({ relativeStrength: 0.5 }))?.detail).toBe('RS_WEAK');
        expect(refusal(at({ oiInterpretation: 'LONG_UNWINDING' }))?.detail).toBe('RS_OI_NOT_ALIGNED');
        expect(refusal(at({ sectorRelativeStrength: -0.6 }))?.detail).toBe('RS_SECTOR_AGAINST');
        expect(refusal(at({ atmSpreadPct: 1.5 }))?.detail).toBe('RS_LIQUIDITY_OR_IV');
        expect(refusal(at({ atmSpreadPct: null }))?.detail).toBe('RS_LIQUIDITY_OR_IV');
        expect(refusal(at({ ivRank: 85 }))?.detail).toBe('RS_LIQUIDITY_OR_IV');
        const c = context(pullbackDay);
        expect(refusal({ ...c, stockIntel: intel(c.now, { at: c.now - FRESH_INTEL_MAX_AGE_MS - 1 }) })?.detail).toBe('RS_INTEL_STALE');
        expect(refusal({ ...c, stockIntel: null })?.detail).toBe('RS_INTEL_STALE');
        expect(refusal({ ...c, stockIntel: intel(c.now, { at: c.now + 1000 }) })?.detail).toBe('RS_INTEL_STALE'); // never a later scan
        expect(refusal({ ...c, stockIntel: undefined })?.detail).toBe('RS_NOT_A_STOCK');
        // A weak resumption bar (normal volume) is no trigger; nor is a session before 10:00 (45 minutes).
        const quiet = [...pullbackDay.slice(0, -1), bar(9, 101.8, 102.7, 101.75, 102.6, 1000)];
        expect(refusal(context(quiet))?.detail).toBe('RS_NO_TRIGGER');
        const early = pullbackDay.slice(2).map((b, i) => ({ ...b, time: open + i * 300000, availableAt: open + (i + 1) * 300000 }));
        expect(refusal(context(early))?.detail).toBe('RS_BEFORE_10_00');
    });
    it('refuses a resumption that leaves more than 1.2 ATR of risk', () => {
        const wide = [...pullbackDay.slice(0, -1), bar(9, 101.8, 103.6, 101.75, 103.5, 1600)];
        expect(refusal(context(wide))?.detail).toBe('RS_RISK_TOO_WIDE');
    });
    it('needs the stock holding VWAP: more than one close on the wrong side in the last six bars is refused', () => {
        const below = pullbackDay.map((b, i) => i === 5 || i === 6 ? { ...b, low: 100.5, close: 100.9 } : b);
        expect(refusal(context(below))?.detail).toBe('RS_NOT_HOLDING_VWAP');
    });
    it('is exempt from the choppy-index filter that stands the pullback strategies aside', () => {
        const c = context(pullbackDay), r = evaluateFreshStrategies(c).refusals;
        expect(r.find(x => x.strategy === S)?.code).not.toBe('CHOPPY_REGIME');
    });
});
