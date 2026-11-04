import { describe, it, expect } from 'vitest';
import { evaluateFreshStrategies, freshSwingLevels, type FreshBar, type FreshContext } from '../strategies.js';
const open = 1800000000000;
function bar(time: number, o = 100, h = 101, l = 99, c = 100, v = 1000): FreshBar { return { time, availableAt: time + 300000, open: o, high: h, low: l, close: c, volume: v }; }
function context(today: FreshBar[]): FreshContext {
    const now = today.at(-1)!.time + 300000 + 100;
    const prior = Array.from({ length: 105 }, (_, i) => bar(open - (105 - i) * 300000));
    const bars15 = Array.from({ length: 80 }, (_, i) => bar(open + Math.floor((now - open) / 900000) * 900000 - (80 - i) * 900000, 96 + i * .1, 97 + i * .1, 95 + i * .1, 96 + i * .1));
    return { now, session: '2026-10-30', sessionOpen: open, sessionClose: open + 21600000, instrument: 'NIFTY-FUT', sourceEpoch: 'e1', bars5: [...prior, ...today], bars15, bars1: Array.from({ length: today.length * 5 }, (_, i) => ({ ...bar(open + i * 60000, 100, 101, 99, 100), availableAt: open + (i + 1) * 60000 })), rvolReferences: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, Array(20).fill(1000)])), openingVolumeReferences: Array(20).fill(1000), levels: [{ price: 125, role: 'RESISTANCE', knownAt: open - 1, kind: 'PDH' }], previousHigh: 125, previousLow: 95, referenceVerified: true, eventClear: true, calendarVerified: true };
}
/** Shifts a session forward by nine flat opening bars (45 minutes), so a pattern lands after the 10:30 VWAP window. */
function late(bars: FreshBar[]): FreshBar[] { const pad = Array.from({ length: 9 }, (_, i) => bar(open + i * 300000)); return [...pad, ...bars.map(x => ({ ...x, time: x.time + 2700000, availableAt: x.availableAt + 2700000 }))]; }
function orb() { return context([bar(open, 100, 101, 99, 100.5), bar(open + 300000, 100.5, 101, 99.5, 100.5), bar(open + 600000, 100.5, 101, 99.5, 100.5), bar(open + 900000, 100.5, 104.5, 100.4, 104, 2000), bar(open + 1200000, 101.2, 103, 100.9, 102.8)]); }
function mirrored(c: FreshContext): FreshContext { const map = (b: FreshBar) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close }); return { ...c, bars5: c.bars5.map(map), bars15: c.bars15.map(map), bars1: c.bars1.map(map), previousHigh: 250 - c.previousLow, previousLow: 250 - c.previousHigh, levels: c.levels.map(x => ({ ...x, price: 250 - x.price, role: x.role === 'RESISTANCE' ? 'SUPPORT' : 'RESISTANCE' })) }; }
describe('fresh-start point-in-time strategy rules', () => {
    it('names the furthest gate behind every "no setup" and every choppy refusal (4 Nov diagnostics)', () => {
        const c = orb();
        const early = { ...c, bars5: c.bars5.slice(0, -1), now: c.now - 300000 };
        const r = evaluateFreshStrategies(early);
        for (const x of r.refusals.filter(x => x.code === 'SETUP_CONDITIONS_NOT_MET' || x.code === 'CHOPPY_REGIME')) expect(x.detail, JSON.stringify(x)).toMatch(/^[A-Z0-9_]+$/);
        const orbRefusal = r.refusals.find(x => x.strategy === 'NEW_ORB_RETEST_V1');
        if (orbRefusal?.code === 'SETUP_CONDITIONS_NOT_MET') expect(orbRefusal.detail).toMatch(/^ORB_/);
        expect(r.refusals.find(x => x.strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1')?.detail).toMatch(/^SWEEP_/);
    });
    it('confirms the first ORB retest in both price directions', () => {
        for (const [c, d] of [[orb(), 'BULLISH'], [mirrored(orb()), 'BEARISH']] as const) {
            const found = evaluateFreshStrategies(c).candidates.find(x => x.strategy === 'NEW_ORB_RETEST_V1');
            expect(found).toMatchObject({ direction: d });
            expect(found!.at).toBe(c.bars5.at(-1)!.availableAt);
        }
    });
    it('confirms a first opening pullback without relabeling a later pullback', () => {
        const c = context([bar(open, 100, 102.2, 99.8, 102), bar(open + 300000, 102, 104.2, 101.8, 104), bar(open + 600000, 104, 106.2, 103.8, 106), bar(open + 900000, 106, 106.1, 103.4, 104, 200), bar(open + 1200000, 104, 107, 103.5, 106.8, 200)]);
        for (const x of [c, mirrored(c)])
            expect(evaluateFreshStrategies(x).candidates.some(s => s.strategy === 'NEW_FIRST_OPENING_PULLBACK_V1'), JSON.stringify(evaluateFreshStrategies(x))).toBe(true);
    });
    it('measures the first pullback from the impulse extreme, not the third close', () => {
        // Low 103 retraces 3.2 of the 6.2-point impulse to its 106.2 high (52%): beyond the 50% limit.
        const c = context([bar(open, 100, 102.2, 99.8, 102), bar(open + 300000, 102, 104.2, 101.8, 104), bar(open + 600000, 104, 106.2, 103.8, 106), bar(open + 900000, 106, 106.1, 103, 104, 200), bar(open + 1200000, 104, 107, 103.5, 106.8, 200)]);
        for (const x of [c, mirrored(c)])
            expect(evaluateFreshStrategies(x).candidates.some(s => s.strategy === 'NEW_FIRST_OPENING_PULLBACK_V1')).toBe(false);
    });
    it('confirms the VWAP pullback with a known impulse break and preserved swing in both directions', () => {
        const c = context(late([bar(open), bar(open + 300000), bar(open + 600000, 100, 101.2, 99.8, 101), bar(open + 900000, 101, 102.2, 100.8, 102), bar(open + 1200000, 102, 104.2, 101.8, 104, 2000), bar(open + 1500000, 104, 104.1, 102.6, 103, 100), bar(open + 1800000, 103, 103.2, 102, 102.5, 100), bar(open + 2100000, 102.5, 104.8, 102.4, 104.6, 100)]));
        c.bars1 = c.bars1.map(x => ({ ...x, open: 102.2, high: 102.3, low: 102.1, close: 102.2 }));
        c.levels = [...c.levels, { price: 101.5, knownAt: open - 1, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' }, { price: 99.5, knownAt: open - 1, role: 'SUPPORT', kind: 'CONFIRMED_SWING' }];
        for (const x of [c, mirrored(c)])
            expect(evaluateFreshStrategies(x).candidates.some(s => s.strategy === 'NEW_VWAP_PULLBACK_V1'), JSON.stringify(evaluateFreshStrategies(x))).toBe(true);
    });
    it('refuses a VWAP pullback confirmed after only one pullback bar', () => {
        const c = context(late([bar(open), bar(open + 300000), bar(open + 600000, 100, 101.2, 99.8, 101), bar(open + 900000, 101, 102.2, 100.8, 102), bar(open + 1200000, 102, 104.2, 101.8, 104, 2000), bar(open + 1500000, 104, 104.1, 102, 102.5, 100), bar(open + 1800000, 102.5, 104.8, 102.4, 104.6, 100)]));
        c.bars1 = c.bars1.map(x => ({ ...x, open: 102.2, high: 102.3, low: 102.1, close: 102.2 }));
        c.levels = [...c.levels, { price: 101.5, knownAt: open - 1, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' }, { price: 99.5, knownAt: open - 1, role: 'SUPPORT', kind: 'CONFIRMED_SWING' }];
        for (const x of [c, mirrored(c)])
            expect(evaluateFreshStrategies(x).candidates.some(s => s.strategy === 'NEW_VWAP_PULLBACK_V1')).toBe(false);
    });
    it('measures the sweep from the session\'s first breach, so an earlier expansion breach is refused', () => {
        // First breach drives 2 points below PDL 95 (beyond 0.75 ATR); a later shallow wick must not hide it.
        const c = context([...Array.from({ length: 4 }, (_, i) => bar(open + i * 300000)), bar(open + 1200000, 95.5, 96, 93, 94.5), bar(open + 1500000, 95, 96, 94.8, 95.9, 2000), bar(open + 1800000, 95.9, 97.2, 95.6, 97)]);
        for (const x of [c, mirrored(c)])
            expect(evaluateFreshStrategies(x).candidates.some(s => s.strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1')).toBe(false);
    });
    it('requires a reclaim and subsequent momentum trigger for a previous-session sweep', () => {
        const c = context([...Array.from({ length: 5 }, (_, i) => bar(open + i * 300000)), bar(open + 1500000, 95, 96, 94.8, 95.9, 2000), bar(open + 1800000, 95.9, 97.2, 95.6, 97)]);
        for (const x of [c, mirrored(c)])
            expect(evaluateFreshStrategies(x).candidates.some(s => s.strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1'), JSON.stringify(evaluateFreshStrategies(x))).toBe(true);
        const invalid = { ...c, bars5: c.bars5.map((x, i, a) => i === a.length - 1 ? { ...x, low: 94 } : x) };
        expect(evaluateFreshStrategies(invalid).candidates.some(s => s.strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1')).toBe(false);
    });
    it('requires reference/event/calendar coverage and complete session bars', () => {
        for (const key of ['referenceVerified', 'eventClear', 'calendarVerified'] as const) {
            const c = orb();
            c[key] = false;
            expect(evaluateFreshStrategies(c).candidates).toEqual([]);
        }
        const c = orb();
        c.bars1 = c.bars1.slice(1);
        expect(evaluateFreshStrategies(c).refusals[0].code).toBe('MISSING_BARS');
    });
    it('does not use future bars, late-arriving confirmations or future target levels', () => { const c = orb(), baseline = evaluateFreshStrategies(c); c.bars5 = [...c.bars5, bar(open + 1500000, 103, 105, 102, 104)]; expect(evaluateFreshStrategies(c)).toEqual(baseline); const delayed = orb(); delayed.bars5 = delayed.bars5.map((x, i, a) => i === a.length - 1 ? { ...x, availableAt: delayed.now + 1000 } : x); expect(evaluateFreshStrategies(delayed).candidates).toEqual([]); const target = orb(); target.previousHigh = 0; target.previousLow = 0; target.levels = target.levels.map(x => ({ ...x, knownAt: target.now + 1000 })); expect(evaluateFreshStrategies(target).candidates.find(x => x.strategy === 'NEW_ORB_RETEST_V1')).toBeUndefined(); });
    it('rejects a stale decision and an unfinished breakout without retest', () => { const c = orb(); c.now += 2100; expect(evaluateFreshStrategies(c).refusals[0].code).toBe('LATE_DECISION'); const x = orb(); x.bars5 = x.bars5.slice(0, -1); x.now -= 300000; expect(evaluateFreshStrategies(x).candidates).toEqual([]); });
    it('does not label a swing before its two right-hand bars are known', () => { const b = [bar(open, 100, 101), bar(open + 300000, 100, 102), bar(open + 600000, 100, 105), bar(open + 900000, 100, 103), bar(open + 1200000, 100, 102)]; expect(freshSwingLevels(b, open + 1200000)).toEqual([]); expect(freshSwingLevels(b, open + 1500000)).toContainEqual({ price: 105, knownAt: open + 1500000, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' }); });
    describe('1.5 target selection', () => {
        const base = () => evaluateFreshStrategies(orb()).candidates.find(x => x.strategy === 'NEW_ORB_RETEST_V1')!;
        it('caps an unreachable level at 3 ATR and records the target R', () => {
            const c = base();
            expect(c.evidence.targetKind).toBe('ATR_CAP');
            expect(c.target).toBeCloseTo(c.referenceEntry + 3 * c.atr);
            expect(c.evidence.targetR as number).toBeGreaterThanOrEqual(1.5);
        });
        it('passes over a minor swing closer than 1.5R and aims at the next level', () => {
            const b = base(), risk = b.referenceEntry - b.stop, ctx = orb();
            ctx.levels = [...ctx.levels, { price: b.referenceEntry + 0.5 * risk, knownAt: open - 1, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' }, { price: b.referenceEntry + 2 * risk, knownAt: open - 1, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' }];
            const c = evaluateFreshStrategies(ctx).candidates.find(x => x.strategy === 'NEW_ORB_RETEST_V1')!;
            expect(c.target).toBeCloseTo(b.referenceEntry + 2 * risk);
        });
        it('refuses when a major level blocks the path before 1.5R', () => {
            const b = base(), risk = b.referenceEntry - b.stop, ctx = orb();
            ctx.levels = [...ctx.levels, { price: b.referenceEntry + 0.8 * risk, knownAt: open - 1, role: 'RESISTANCE', kind: 'PDH' }];
            const r = evaluateFreshStrategies(ctx);
            expect(r.candidates.some(x => x.strategy === 'NEW_ORB_RETEST_V1')).toBe(false);
            expect(r.refusals).toContainEqual({ strategy: 'NEW_ORB_RETEST_V1', code: 'TARGET_TOO_CLOSE' });
        });
    });
    describe('1.5 regime filter and VWAP window', () => {
        it('refuses the VWAP pullback before 10:30 even when the pattern is valid', () => {
            const c = context([bar(open), bar(open + 300000), bar(open + 600000, 100, 101.2, 99.8, 101), bar(open + 900000, 101, 102.2, 100.8, 102), bar(open + 1200000, 102, 104.2, 101.8, 104, 2000), bar(open + 1500000, 104, 104.1, 102.6, 103, 100), bar(open + 1800000, 103, 103.2, 102, 102.5, 100), bar(open + 2100000, 102.5, 104.8, 102.4, 104.6, 100)]);
            c.bars1 = c.bars1.map(x => ({ ...x, open: 102.2, high: 102.3, low: 102.1, close: 102.2 }));
            c.levels = [...c.levels, { price: 101.5, knownAt: open - 1, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' }, { price: 99.5, knownAt: open - 1, role: 'SUPPORT', kind: 'CONFIRMED_SWING' }];
            expect(evaluateFreshStrategies(c).candidates.some(s => s.strategy === 'NEW_VWAP_PULLBACK_V1')).toBe(false);
        });
        it('stands the trend strategies aside on a choppy session and records the efficiency on a trade', () => {
            // A see-saw open: the closes go nowhere over a long path (efficiency well below 0.3).
            const saw = context([bar(open, 100, 101, 99, 100.5), bar(open + 300000, 100.5, 101, 99.5, 99.5), bar(open + 600000, 99.5, 101, 99.4, 100.6), bar(open + 900000, 100.6, 101, 99.4, 99.6), bar(open + 1200000, 99.6, 101, 99.5, 100.4)]);
            const r = evaluateFreshStrategies(saw);
            for (const s of ['NEW_ORB_RETEST_V1', 'NEW_VWAP_PULLBACK_V1', 'NEW_FIRST_OPENING_PULLBACK_V1'] as const) expect(r.refusals).toContainEqual(expect.objectContaining({ strategy: s, code: 'CHOPPY_REGIME' }));
            expect(r.refusals.some(x => x.strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1' && x.code === 'CHOPPY_REGIME')).toBe(false);
            const ok = evaluateFreshStrategies(orb()).candidates.find(x => x.strategy === 'NEW_ORB_RETEST_V1')!;
            expect(ok.evidence.efficiency as number).toBeGreaterThanOrEqual(0.3);
        });
    });
});
