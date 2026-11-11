// 2.0 NEW_MCX_FLOW_V1 (a commodity trend the inferred aggressive volume confirms), the index order-flow veto and the
// order-block shadow tag. Same synthetic session as rs-stock.test.ts (ATR ~1.5-2, rising 15-minute trend, VWAP 101.2).
import { describe, expect, it } from 'vitest';
import { evaluateFreshStrategies, freshMcxFlowDiagnostic, FRESH_ALL_STRATEGIES, FRESH_SHADOW_STRATEGIES, type FreshBar, type FreshContext, type FreshIndexIntel } from '../strategies.js';
import type { FreshFlowBar } from '../order-flow-evidence.js';

const open = 1800000000000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): FreshBar => ({ time: open + i * 300000, availableAt: open + (i + 1) * 300000, open: o, high: h, low: l, close: c, volume: v });
const VWAP = 101.2;
/** One flow bar per five-minute bar: `buy` share of 1000 classified, 20 updates. */
const flowFor = (today: FreshBar[], buyShare = (_: number) => 0.65): FreshFlowBar[] => today.map((b, i) => ({ time: b.time, buy: 1000 * buyShare(i), sell: 1000 * (1 - buyShare(i)), unclassified: 100, trades: 20 }));
function context(today: FreshBar[], extra: Partial<FreshContext> = {}): FreshContext {
    const now = today.at(-1)!.time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => ({ time: open - (105 - i) * 300000, availableAt: open - (104 - i) * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const bars15 = Array.from({ length: 80 }, (_, i) => ({ time: open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, availableAt: 0, open: 96 + i * .1, high: 97 + i * .1, low: 95 + i * .1, close: 96 + i * .1, volume: 1000 }));
    return { now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: 'MCX_FO:CRUDE', sourceEpoch: 'e1', bars5: [...prior, ...today], bars15: bars15.map(x => ({ ...x, availableAt: x.time + 900000 })), bars1: Array.from({ length: today.length * 5 }, (_, i) => ({ time: open + i * 60000, availableAt: open + (i + 1) * 60000, open: VWAP, high: VWAP, low: VWAP, close: VWAP, volume: 1000 })), rvolReferences: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000), levels: [{ price: 125, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 125, previousLow: 95, referenceVerified: true, eventClear: true, calendarVerified: true, commodity: true, orderFlow: { source: 'DHAN', instrument: 'CRUDE', proxy: false, bars: flowFor(today) }, ...extra };
}
const mirror = (c: FreshContext): FreshContext => {
    const m = (b: FreshBar) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close });
    return { ...c, bars5: c.bars5.map(m), bars15: c.bars15.map(m), bars1: c.bars1.map(m), levels: [{ price: 125, role: 'SUPPORT', knownAt: open - 1, kind: 'PDL' }], previousHigh: 155, previousLow: 125, orderFlow: c.orderFlow && { ...c.orderFlow, bars: c.orderFlow.bars.map(x => ({ ...x, buy: x.sell, sell: x.buy })) }, footprint15: c.footprint15 && { ...c.footprint15, deltaPct: c.footprint15.deltaPct == null ? null : -c.footprint15.deltaPct, buyImbalances: c.footprint15.sellImbalances, sellImbalances: c.footprint15.buyImbalances } };
};
const S = 'NEW_MCX_FLOW_V1';
const find = (c: FreshContext, s = S) => evaluateFreshStrategies(c).candidates.find(x => x.strategy === s);
const refusal = (c: FreshContext, s = S) => evaluateFreshStrategies(c).refusals.find(x => x.strategy === s);

const trend = [bar(0, 101.3, 101.8, 101.25, 101.6), bar(1, 101.6, 102.2, 101.5, 102.0), bar(2, 102.0, 102.5, 101.8, 102.3), bar(3, 102.3, 102.8, 102.1, 102.6), bar(4, 102.6, 103.0, 102.3, 102.8), bar(5, 102.8, 103.1, 102.4, 102.5)];
const pullbackDay = [...trend, bar(6, 102.5, 102.6, 101.8, 101.9), bar(7, 101.9, 102.0, 101.3, 101.4), bar(8, 101.4, 101.9, 101.35, 101.8), bar(9, 101.8, 102.7, 101.75, 102.6, 1600)];
const baseDay = [...trend, bar(6, 102.5, 102.7, 102.4, 102.6), bar(7, 102.6, 102.75, 102.45, 102.55), bar(8, 102.55, 102.8, 102.5, 102.7), bar(9, 102.7, 102.8, 102.45, 102.6), bar(10, 102.6, 103.6, 102.55, 103.5, 1600)];

describe('2.0 NEW_MCX_FLOW_V1', () => {
    it('is an active (not shadow) strategy', () => {
        expect(FRESH_ALL_STRATEGIES).toContain(S);
        expect(FRESH_SHADOW_STRATEGIES.has(S)).toBe(false);
    });
    it('takes a VWAP hold whose resumption bar is bought, in both directions, with the flow as evidence', () => {
        for (const [c, d] of [[context(pullbackDay), 'BULLISH'], [mirror(context(pullbackDay)), 'BEARISH']] as const) {
            const x = find(c);
            expect(x, JSON.stringify(refusal(c))).toMatchObject({ direction: d, exitProfile: 'TREND', evidence: { mcxFlow: { trigger: 'FLOW_HOLD', setupDelta: 0.3, barDelta: 0.3 } } });
        }
    });
    it('takes a tight-base break on delta >= 20% that the 15-minute footprint does not contradict', () => {
        const strong = (c: FreshContext) => ({ ...c, orderFlow: { ...c.orderFlow!, bars: flowFor(baseDay, () => 0.7) } });
        const c = strong(context(baseDay, { footprint15: { barTime: open + 900000, deltaPct: 0.2, buyImbalances: 4, sellImbalances: 1, trades: 300 } }));
        expect(find(c), JSON.stringify(refusal(c))).toMatchObject({ direction: 'BULLISH', evidence: { mcxFlow: { trigger: 'FLOW_BREAK' } } });
        // A footprint dominated by sellers vetoes the break.
        const against = strong(context(baseDay, { footprint15: { barTime: open + 900000, deltaPct: -0.2, buyImbalances: 1, sellImbalances: 4, trades: 300 } }));
        expect(refusal(against)?.detail).toBe('MCX_NO_TRIGGER');
    });
    it('names the gate that stopped it, and never trades without flow', () => {
        const c = context(pullbackDay);
        expect(refusal({ ...c, orderFlow: undefined })?.detail).toBe('MCX_FLOW_UNAVAILABLE');
        expect(refusal({ ...c, orderFlow: { ...c.orderFlow!, bars: c.orderFlow!.bars.slice(0, -1) } })?.detail).toBe('MCX_FLOW_UNAVAILABLE'); // the decision bar is missing
        expect(refusal({ ...c, orderFlow: { ...c.orderFlow!, bars: c.orderFlow!.bars.map(x => ({ ...x, unclassified: 5000 })) } })?.detail).toBe('MCX_FLOW_UNAVAILABLE'); // < 50% classified
        // Sampled order flow (9 Nov): observed 1100 of 12100 = 9% coverage -> unavailable; 1100 of 4100 = 27% -> a usable sample.
        expect(refusal({ ...c, orderFlow: { ...c.orderFlow!, bars: c.orderFlow!.bars.map(x => ({ ...x, unreconciled: 11000 })) } })?.detail).toBe('MCX_FLOW_UNAVAILABLE');
        expect(find({ ...c, orderFlow: { ...c.orderFlow!, bars: c.orderFlow!.bars.map(x => ({ ...x, unreconciled: 3000 })) } })).toMatchObject({ evidence: { mcxFlow: { trigger: 'FLOW_HOLD' } } });
        expect(refusal({ ...c, orderFlow: { ...c.orderFlow!, bars: flowFor(pullbackDay, () => 0.52) } })?.detail).toBe('MCX_FLOW_NOT_ALIGNED');
        expect(refusal({ ...c, orderFlow: { ...c.orderFlow!, bars: flowFor(pullbackDay, i => (i === 9 ? 0.4 : 0.8)) } })?.detail).toBe('MCX_FLOW_NOT_ALIGNED'); // decision bar sold
        expect(refusal({ ...c, commodity: undefined })?.detail).toBe('MCX_NOT_A_COMMODITY');
        const early = pullbackDay.slice(2).map((b, i) => ({ ...b, time: open + i * 300000, availableAt: open + (i + 1) * 300000 }));
        expect(refusal(context(early))?.detail).toBe('MCX_BEFORE_START');
    });
});

describe('2.0 index order-flow veto', () => {
    const intel = (now: number): FreshIndexIntel => ({ at: now - 60000, breadth: 0.8, breadthCoverage: 1, futuresOi: 'LONG_BUILDUP', oiNow: { at: now - 60000, strikes: [{ strike: 110, callOi: 1000, putOi: 100 }] }, oiBefore: null });
    const idx = (buyShare: number) => { const c = context(pullbackDay, { commodity: undefined }); return { ...c, instrument: 'NSE_FO:NIFTY', indexIntel: intel(c.now), orderFlow: { ...c.orderFlow!, bars: flowFor(pullbackDay, () => buyShare) } }; };
    it('refuses an index entry whose decision bar is clearly sold, and takes it otherwise (or without flow)', () => {
        expect(refusal(idx(0.3), 'NEW_INDEX_BREADTH_V1')?.detail).toBe('IDX_FLOW_OPPOSED');
        expect(find(idx(0.5), 'NEW_INDEX_BREADTH_V1')?.evidence.index).toMatchObject({ flow: 'NEUTRAL' });
        expect(find(idx(0.7), 'NEW_INDEX_BREADTH_V1')?.evidence.index).toMatchObject({ flow: 'ALIGNED' });
        expect(find({ ...idx(0.3), orderFlow: undefined }, 'NEW_INDEX_BREADTH_V1')?.evidence.index).toMatchObject({ flow: 'UNAVAILABLE' });
    });
});

describe('2.0 order-block shadow tag', () => {
    it('tags every 2.0 entry with whether an unmitigated order block of its side sits at the entry, and never refuses on it', () => {
        const x = find(context(pullbackDay))!;
        expect(x.evidence.orderBlock).toHaveProperty('near');
        expect(typeof (x.evidence.orderBlock as { near: boolean }).near).toBe('boolean');
    });
});

describe('MCX flow diagnostic (9 Nov, log only)', () => {
    it('reports the flow numbers and agrees with the strategy check', () => {
        const ok = freshMcxFlowDiagnostic(context(pullbackDay));
        expect(ok).toMatchObject({ trend: 'BULL', setupDeltaPct: 30, barDeltaPct: 30, flowCheck: 'PASS', trades: 60 });
        expect(ok.classifiedSharePct).toBeCloseTo(90.9, 1);
        expect(freshMcxFlowDiagnostic(mirror(context(pullbackDay)))).toMatchObject({ trend: 'BEAR', setupDeltaPct: -30, flowCheck: 'PASS' });
        // A rising trend with only 52% buying: 4% < 8% (2.1) -> the strategy's MCX_FLOW_NOT_ALIGNED.
        const weak = context(pullbackDay); weak.orderFlow = { ...weak.orderFlow!, bars: flowFor(pullbackDay, () => 0.52) };
        expect(freshMcxFlowDiagnostic(weak)).toMatchObject({ setupDeltaPct: 4, flowCheck: 'SETUP_DELTA_BELOW_MIN' });
        expect(refusal(weak)?.detail).toBe('MCX_FLOW_NOT_ALIGNED');
        expect(freshMcxFlowDiagnostic({ ...context(pullbackDay), orderFlow: undefined }).flowCheck).toBe('NO_FLOW_SOURCE');
    });
});
