// 2.0 NEW_INDEX_BREADTH_V1: an index move its heavyweights agree with, futures OI not against it, room to the next OI
// wall; entered on a VWAP / EMA20 hold, a tight-base break or an OI-wall break.
import { describe, expect, it } from 'vitest';
import { evaluateFreshStrategies, FRESH_ALL_STRATEGIES, FRESH_SHADOW_STRATEGIES, type FreshBar, type FreshContext, type FreshIndexIntel, type FreshOiSample } from '../strategies.js';

const open = 1800000000000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): FreshBar => ({ time: open + i * 300000, availableAt: open + (i + 1) * 300000, open: o, high: h, low: l, close: c, volume: v });
const VWAP = 101.2;
const chain = (at: number, xs: Array<[number, number, number]>): FreshOiSample => ({ at, expiry: '2026-11-10', strikes: xs.map(([strike, callOi, putOi]) => ({ strike, callOi, putOi })) });
// Walls far away by default: call wall 110 above, put wall 92 below.
const farWalls = (at: number) => chain(at, [[92, 100, 1000], [100, 300, 500], [103, 300, 300], [110, 1000, 100]]);
const intel = (now: number, x: Partial<FreshIndexIntel> = {}): FreshIndexIntel => ({ at: now - 60000, breadth: 0.8, breadthCoverage: 0.95, futuresOi: 'LONG_BUILDUP', oiNow: farWalls(now - 60000), oiBefore: farWalls(now - 60000 - 15 * 60000), ...x });
function context(today: FreshBar[], extra: Partial<FreshContext> = {}): FreshContext {
    const now = today.at(-1)!.time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => ({ time: open - (105 - i) * 300000, availableAt: open - (104 - i) * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const bars15 = Array.from({ length: 80 }, (_, i) => ({ time: open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, availableAt: 0, open: 96 + i * .1, high: 97 + i * .1, low: 95 + i * .1, close: 96 + i * .1, volume: 1000 }));
    return { now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: 'NSE_FO:NIFTY', sourceEpoch: 'e1', bars5: [...prior, ...today], bars15: bars15.map(x => ({ ...x, availableAt: x.time + 900000 })), bars1: Array.from({ length: today.length * 5 }, (_, i) => ({ time: open + i * 60000, availableAt: open + (i + 1) * 60000, open: VWAP, high: VWAP, low: VWAP, close: VWAP, volume: 1000 })), rvolReferences: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000), levels: [{ price: 125, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 125, previousLow: 95, referenceVerified: true, eventClear: true, calendarVerified: true, indexIntel: intel(now), ...extra };
}
const mirrorChain = (x: FreshOiSample | null): FreshOiSample | null => x && { at: x.at, expiry: x.expiry, strikes: x.strikes.map(s => ({ strike: 250 - s.strike, callOi: s.putOi, putOi: s.callOi })) };
const mirror = (c: FreshContext): FreshContext => {
    const m = (b: FreshBar) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close });
    const ix = c.indexIntel!;
    return { ...c, bars5: c.bars5.map(m), bars15: c.bars15.map(m), bars1: c.bars1.map(m), levels: [{ price: 125, role: 'SUPPORT', knownAt: open - 1, kind: 'PDL' }], previousHigh: 155, previousLow: 125, indexIntel: { ...ix, breadth: 1 - ix.breadth!, futuresOi: 'SHORT_BUILDUP', oiNow: mirrorChain(ix.oiNow), oiBefore: mirrorChain(ix.oiBefore) } };
};
const S = 'NEW_INDEX_BREADTH_V1';
const find = (c: FreshContext) => evaluateFreshStrategies(c).candidates.find(x => x.strategy === S);
const refusal = (c: FreshContext) => evaluateFreshStrategies(c).refusals.find(x => x.strategy === S);

const trend = [bar(0, 101.3, 101.8, 101.25, 101.6), bar(1, 101.6, 102.2, 101.5, 102.0), bar(2, 102.0, 102.5, 101.8, 102.3), bar(3, 102.3, 102.8, 102.1, 102.6), bar(4, 102.6, 103.0, 102.3, 102.8), bar(5, 102.8, 103.1, 102.4, 102.5)];
const pullbackDay = [...trend, bar(6, 102.5, 102.6, 101.8, 101.9), bar(7, 101.9, 102.0, 101.3, 101.4), bar(8, 101.4, 101.9, 101.35, 101.8), bar(9, 101.8, 102.7, 101.75, 102.6, 1600)];
// Grinding under the 103 call wall, then a 5-minute close through it on 1.6x volume.
const wallDay = [...trend, bar(6, 102.5, 102.9, 102.4, 102.8), bar(7, 102.8, 102.95, 102.6, 102.9), bar(8, 102.9, 102.98, 102.55, 102.95), bar(9, 102.95, 104.1, 102.9, 104.0, 1600)];
const wallBreak = (now: number, unwound = true) => ({ oiNow: chain(now - 60000, [[92, 100, 1000], [100, 300, 500], [103, unwound ? 850 : 1000, 400], [110, 900, 100]]), oiBefore: chain(now - 16 * 60000, [[92, 100, 1000], [100, 300, 500], [103, 1000, 200], [110, 900, 100]]) });

describe('2.0 NEW_INDEX_BREADTH_V1', () => {
    it('is an active (not shadow) strategy', () => {
        expect(FRESH_ALL_STRATEGIES).toContain(S);
        expect(FRESH_SHADOW_STRATEGIES.has(S)).toBe(false);
    });
    it('takes a VWAP hold its heavyweights agree with, in both directions, with a trailing exit', () => {
        for (const [c, d] of [[context(pullbackDay), 'BULLISH'], [mirror(context(pullbackDay)), 'BEARISH']] as const) {
            const x = find(c);
            expect(x, JSON.stringify(refusal(c))).toMatchObject({ direction: d, exitProfile: 'TREND', evidence: { index: { trigger: 'VWAP_HOLD' } } });
        }
    });
    it('takes an OI-wall break (writers covering) and names the wall', () => {
        const base = context(wallDay), c = { ...base, indexIntel: intel(base.now, wallBreak(base.now)) };
        expect(find(c), JSON.stringify(refusal(c))).toMatchObject({ direction: 'BULLISH', evidence: { index: { trigger: 'WALL_BREAK_103', nextWall: 110 } } });
        const m = mirror(c);
        expect(find(m), JSON.stringify(refusal(m))).toMatchObject({ direction: 'BEARISH', evidence: { index: { trigger: 'WALL_BREAK_147' } } });
        // The wall's OI did not fall: no wall-break trigger (and no other trigger on this tape).
        const held = { ...base, indexIntel: intel(base.now, wallBreak(base.now, false)) };
        expect(find(held)?.evidence?.index).not.toMatchObject({ trigger: 'WALL_BREAK_103' });
    });
    it('names the gate that stopped it', () => {
        const at = (x: Partial<FreshIndexIntel>) => { const c = context(pullbackDay); return { ...c, indexIntel: intel(c.now, x) }; };
        expect(refusal(at({ breadth: 0.5 }))?.detail).toBe('IDX_BREADTH_SPLIT');
        expect(refusal(at({ breadth: null }))?.detail).toBe('IDX_BREADTH_UNAVAILABLE');
        expect(refusal(at({ futuresOi: 'SHORT_BUILDUP' }))?.detail).toBe('IDX_FUTURES_OI_AGAINST');
        expect(find(at({ futuresOi: null }))).toBeDefined(); // unknown futures OI is not "against"
        expect(refusal(at({ oiNow: null, oiBefore: null }))?.detail).toBe('IDX_OI_UNAVAILABLE');
        const c = context(pullbackDay);
        // A call wall 0.5 points above the entry: less than 1.5R of room.
        expect(refusal({ ...c, indexIntel: intel(c.now, { oiNow: chain(c.now - 60000, [[92, 100, 1000], [103.1, 1000, 100]]) }) })?.detail).toBe('IDX_LOCATION_NO_ROOM');
        expect(refusal({ ...c, indexIntel: intel(c.now, { oiNow: chain(c.now - 4 * 60000, [[110, 1000, 100]]) }) })?.detail).toBe('IDX_OI_UNAVAILABLE'); // > 3 min old
        expect(refusal({ ...c, indexIntel: intel(c.now, { at: c.now - 7 * 60000 }) })?.detail).toBe('IDX_INTEL_STALE');
        expect(refusal({ ...c, indexIntel: null })?.detail).toBe('IDX_INTEL_STALE');
        expect(refusal({ ...c, indexIntel: undefined })?.detail).toBe('IDX_NOT_AN_INDEX');
        const early = pullbackDay.slice(2).map((b, i) => ({ ...b, time: open + i * 300000, availableAt: open + (i + 1) * 300000 }));
        expect(refusal(context(early))?.detail).toBe('IDX_BEFORE_10_00');
    });
});
