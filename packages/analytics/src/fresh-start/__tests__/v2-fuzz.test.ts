// 2.0 robustness: 1500 random (seeded) sessions with random / missing / malformed 2.0 inputs. The engine must never throw,
// every strategy must end in a candidate or a named refusal, and every 2.0 candidate must be internally consistent.
import { describe, expect, it } from 'vitest';
import { evaluateFreshStrategies, FRESH_ACTIVE_STRATEGIES, FRESH_ALL_STRATEGIES, type FreshBar, type FreshContext } from '../strategies.js';

// mulberry32: 32-bit integer arithmetic, so the sequence does not collapse (a float LCG loses precision past 2^53).
let seed = 1731;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const open = 1800000000000;

function randomContext(): FreshContext {
    const n = 6 + Math.floor(rnd() * 40), drift = (rnd() - .5) * .6;
    let px = 100;
    const today: FreshBar[] = Array.from({ length: n }, (_, i) => {
        const o = px, c = o + drift + (rnd() - .5) * 2, h = Math.max(o, c) + rnd(), l = Math.min(o, c) - rnd();
        px = c;
        return { time: open + i * 300000, availableAt: open + (i + 1) * 300000, open: o, high: h, low: l, close: c, volume: 500 + rnd() * 2000 };
    });
    const now = today[n - 1].time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => ({ time: open - (105 - i) * 300000, availableAt: open - (104 - i) * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const slope = (rnd() - .5) * .4;
    const bars15 = Array.from({ length: 80 }, (_, i) => { const b = 100 + slope * (i - 80); return { time: open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, availableAt: 0, open: b, high: b + 1, low: b - 1, close: b, volume: 1000 }; });
    const vw = 100 + (rnd() - .5) * 4;
    const kind = pick(['STOCK', 'INDEX', 'MCX', 'OTHER'] as const);
    const strikes = Array.from({ length: 8 }, (_, i) => ({ strike: 90 + i * 3, callOi: rnd() * 1000, putOi: rnd() * 1000 }));
    const maybe = <T>(x: T): T | null | undefined => pick([x, x, x, null, undefined]);
    return {
        now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: `X:${kind}`, sourceEpoch: 'e1',
        bars5: [...prior, ...today], bars15: bars15.map(x => ({ ...x, availableAt: x.time + 900000 })),
        bars1: Array.from({ length: n * 5 }, (_, i) => ({ time: open + i * 60000, availableAt: open + (i + 1) * 60000, open: vw, high: vw, low: vw, close: vw, volume: 1000 })),
        rvolReferences: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000),
        levels: [{ price: 130, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 130, previousLow: 70,
        referenceVerified: true, eventClear: true, calendarVerified: true,
        orderFlow: rnd() < .7 ? { source: 'DHAN', instrument: 'F', proxy: rnd() < .3, bars: today.filter(() => rnd() < .9).map(b => ({ time: b.time, buy: rnd() * 1000, sell: rnd() * 1000, unclassified: rnd() * 600, trades: Math.floor(rnd() * 30) })) } : undefined,
        ...(kind === 'STOCK' ? { stockIntel: maybe({ at: now - rnd() * 500000, relativeStrength: (rnd() - .5) * 4, oiInterpretation: pick(['LONG_BUILDUP', 'SHORT_BUILDUP', 'SHORT_COVERING', 'LONG_UNWINDING', 'CALL_WRITING']), sectorRelativeStrength: pick([null, (rnd() - .5) * 2]), atmSpreadPct: pick([null, rnd() * 2]), ivRank: pick([null, rnd() * 100]) }) } : {}),
        ...(kind === 'INDEX' ? { indexIntel: maybe({ at: now - rnd() * 500000, breadth: pick([null, rnd()]), breadthCoverage: rnd(), futuresOi: pick([null, 'NEUTRAL', 'LONG_BUILDUP', 'SHORT_BUILDUP']), oiNow: pick([null, { at: now - rnd() * 240000, strikes }]), oiBefore: pick([null, { at: now - 15 * 60000 - rnd() * 120000, strikes: strikes.map(s => ({ ...s, callOi: s.callOi * (0.8 + rnd() * .4) })) }]) }) } : {}),
        ...(kind === 'MCX' ? { commodity: true, footprint15: pick([null, { barTime: Math.floor(now / 900000) * 900000 - 900000, deltaPct: pick([null, (rnd() - .5) * 2]), buyImbalances: Math.floor(rnd() * 6), sellImbalances: Math.floor(rnd() * 6), trades: 100 }]) } : {}),
    };
}

describe('2.0 robustness (seeded fuzz)', () => {
    it('never throws, names every outcome, and emits only consistent 2.0 candidates across 1500 random sessions', () => {
        let candidates = 0; const deep = new Set<string>();
        const DEEP = ['RS_NOT_HOLDING_VWAP', 'RS_NO_TRIGGER', 'RS_RISK_TOO_WIDE', 'IDX_NOT_HOLDING_VWAP', 'IDX_NO_TRIGGER', 'IDX_RISK_TOO_WIDE', 'IDX_LOCATION_NO_ROOM', 'IDX_OI_UNAVAILABLE', 'IDX_FLOW_OPPOSED', 'MCX_NOT_HOLDING_VWAP', 'MCX_NO_TRIGGER', 'MCX_RISK_TOO_WIDE'];
        for (let i = 0; i < 1500; i++) {
            const c = randomContext();
            const e = evaluateFreshStrategies(c);
            for (const s of FRESH_ALL_STRATEGIES)
                expect(e.candidates.some(x => x.strategy === s) || e.refusals.some(x => x.strategy === s), `${s} #${i}`).toBe(true);
            for (const r of e.refusals) { expect(typeof r.code).toBe('string'); if (r.detail && DEEP.includes(r.detail)) deep.add(r.strategy); }
            for (const x of e.candidates) deep.add(x.strategy);
            for (const x of e.candidates.filter(x => (FRESH_ACTIVE_STRATEGIES as readonly string[]).includes(x.strategy))) {
                candidates++;
                const d = x.direction === 'BULLISH' ? 1 : -1;
                expect(d * (x.referenceEntry - x.stop)).toBeGreaterThan(0);
                expect(d * (x.target - x.referenceEntry)).toBeGreaterThan(0);
                expect(x.exitProfile).toBe('TREND');
                expect(x.expiresAt).toBeGreaterThan(x.at);
                expect([x.stop, x.target, x.atr, x.referenceEntry].every(Number.isFinite)).toBe(true);
                if (x.strategy === 'NEW_RS_STOCK_V1') expect(c.stockIntel).toBeTruthy();
                if (x.strategy === 'NEW_INDEX_BREADTH_V1') expect(c.indexIntel?.oiNow).toBeTruthy();
                if (x.strategy === 'NEW_MCX_FLOW_V1') expect(c.commodity && c.orderFlow).toBeTruthy();
            }
        }
        // Every 2.0 strategy must be driven deep into its gates (past the data checks, where the arithmetic runs).
        expect(deep.size, [...deep].join(',')).toBe(3);
    });
});

// Known-good setups (the fixtures of rs-stock / index-breadth / mcx-flow tests), jittered: prices +-0.05, volumes, intel and
// flow within their valid ranges. Many must still enter, and every entry must hold the invariants.
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): FreshBar => ({ time: open + i * 300000, availableAt: open + (i + 1) * 300000, open: o, high: h, low: l, close: c, volume: v });
const goodDay = [bar(0, 101.3, 101.8, 101.25, 101.6), bar(1, 101.6, 102.2, 101.5, 102.0), bar(2, 102.0, 102.5, 101.8, 102.3), bar(3, 102.3, 102.8, 102.1, 102.6), bar(4, 102.6, 103.0, 102.3, 102.8), bar(5, 102.8, 103.1, 102.4, 102.5), bar(6, 102.5, 102.6, 101.8, 101.9), bar(7, 101.9, 102.0, 101.3, 101.4), bar(8, 101.4, 101.9, 101.35, 101.8), bar(9, 101.8, 102.7, 101.75, 102.6, 1600)];
function jittered(kind: 'STOCK' | 'INDEX' | 'MCX'): FreshContext {
    const j = () => (rnd() - .5) * .1;
    const today = goodDay.map(b => { const o = b.open + j(), c = b.close + j(); return { ...b, open: o, close: c, high: Math.max(b.high + j(), o, c), low: Math.min(b.low + j(), o, c), volume: b.volume * (0.9 + rnd() * .2) }; });
    const now = today[9].time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => ({ time: open - (105 - i) * 300000, availableAt: open - (104 - i) * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    const bars15 = Array.from({ length: 80 }, (_, i) => ({ time: open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, availableAt: 0, open: 96 + i * .1, high: 97 + i * .1, low: 95 + i * .1, close: 96 + i * .1, volume: 1000 }));
    const share = 0.6 + rnd() * .25;
    return {
        now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: `J:${kind}`, sourceEpoch: 'e1', bars5: [...prior, ...today], bars15: bars15.map(x => ({ ...x, availableAt: x.time + 900000 })),
        bars1: Array.from({ length: 50 }, (_, i) => ({ time: open + i * 60000, availableAt: open + (i + 1) * 60000, open: 101.2, high: 101.2, low: 101.2, close: 101.2, volume: 1000 })),
        rvolReferences: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000),
        levels: [{ price: 125, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 125, previousLow: 95, referenceVerified: true, eventClear: true, calendarVerified: true,
        orderFlow: { source: 'DHAN', instrument: 'F', proxy: false, bars: today.map(b => ({ time: b.time, buy: 1000 * share, sell: 1000 * (1 - share), unclassified: 100, trades: 20 })) },
        ...(kind === 'STOCK' ? { stockIntel: { at: now - 60000, relativeStrength: 0.8 + rnd() * 2, oiInterpretation: pick(['LONG_BUILDUP', 'SHORT_COVERING']), sectorRelativeStrength: rnd(), atmSpreadPct: rnd(), ivRank: rnd() * 79 } } : {}),
        ...(kind === 'INDEX' ? { indexIntel: { at: now - 60000, breadth: 0.7 + rnd() * .3, breadthCoverage: 1, futuresOi: pick(['LONG_BUILDUP', 'NEUTRAL', null]), oiNow: { at: now - 60000, strikes: [{ strike: 110 + rnd() * 5, callOi: 1000, putOi: 100 }] }, oiBefore: null } } : {}),
        ...(kind === 'MCX' ? { commodity: true, footprint15: null } : {}),
    };
}

describe('2.0 robustness around known setups (seeded jitter)', () => {
    it('keeps entering under small perturbations, and every entry holds its invariants', () => {
        const entered = { STOCK: 0, INDEX: 0, MCX: 0 };
        const strategyOf = { STOCK: 'NEW_RS_STOCK_V1', INDEX: 'NEW_INDEX_BREADTH_V1', MCX: 'NEW_MCX_FLOW_V1' } as const;
        for (let i = 0; i < 300; i++)
            for (const kind of ['STOCK', 'INDEX', 'MCX'] as const) {
                const c = jittered(kind), e = evaluateFreshStrategies(c), x = e.candidates.find(y => y.strategy === strategyOf[kind]);
                expect(e.refusals.some(r => r.strategy === strategyOf[kind]) || !!x).toBe(true);
                if (!x) continue;
                entered[kind]++;
                expect(x.direction).toBe('BULLISH');
                expect(x.referenceEntry - x.stop).toBeGreaterThan(0);
                expect(x.referenceEntry - x.stop).toBeLessThanOrEqual(1.2 * x.atr + 1e-9);
                expect(x.target).toBeGreaterThan(x.referenceEntry);
                expect(x.exitProfile).toBe('TREND');
                expect(x.expiresAt).toBe(x.at + 20000);
                expect(x.evidence.orderBlock).toHaveProperty('near');
                // No other 2.0 strategy may claim this instrument's kind.
                for (const other of e.candidates.filter(y => (FRESH_ACTIVE_STRATEGIES as readonly string[]).includes(y.strategy))) expect(other.strategy).toBe(strategyOf[kind]);
            }
        // Most jittered setups still qualify; a strategy that never enters here would be a broken path.
        for (const kind of ['STOCK', 'INDEX', 'MCX'] as const) expect(entered[kind], kind).toBeGreaterThan(150);
    });
});

