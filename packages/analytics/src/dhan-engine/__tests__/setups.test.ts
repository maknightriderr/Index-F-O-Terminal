// Dhan engine v2, phase 3: setups A-D (both directions through the same rules), the 10-point score, mandatory gates,
// the no-trade engine and the expiry-gamma module, on hand-built sessions (fixture.ts). Shadow only: no position.
import { describe, expect, it } from 'vitest';
import { evaluateDhanSetups, sessionWindow, thirtyMinuteBars, type SetupContext, type SetupResult } from '../setups.js';
import { evaluateExpiryGamma, pivotR1, type GammaSample } from '../expiry-gamma.js';
import { contextOf, QUIET, even, OPEN, Q, type BarSpec } from './fixture.js';

const A_DAY: BarSpec[] = [
  { o: 100, h: 101, l: 99, c: 100 },
  { o: 100, h: 102, l: 99, c: 101 },
  { o: 101, h: 103, l: 100, c: 102 }, // pivot high 103
  { o: 102, h: 102, l: 99, c: 99.5 },
  { o: 99.5, h: 101, l: 98.5, c: 99 },
  { o: 99, h: 100, l: 97, c: 98.5, rows: [[97, 20, 120], [98, 30, 40], [99, 30, 20], [100, 10, 10]] }, // sweeps PDL 98, sellers absorbed at 97
  { o: 98.6, h: 101, l: 98, c: 100.5, rows: [[98, 10, 40], [99, 130, 10], [100, 60, 10], [101, 40, 5]] }, // confirms; stacked buy 99-101
  { o: 100.5, h: 103.5, l: 100, c: 103.4, rows: [[100, 30, 20], [101, 80, 20], [102, 60, 20], [103, 40, 15]] }, // CHoCH over 103
  { o: 103.4, h: 104, l: 103.1, c: 103.6, rows: [[103, 20, 25], [104, 20, 20]] }, // retest holds
];
const C_DAY: BarSpec[] = [
  { o: 104, h: 104.4, l: 103, c: 104 },
  { o: 104, h: 104, l: 102, c: 102.5, rows: [[102, 10, 40], [103, 10, 30], [104, 10, 20]] },
  { o: 102.5, h: 103, l: 100, c: 100.5, rows: [[100, 10, 60], [101, 10, 60], [102, 20, 40], [103, 10, 30]] },
  { o: 100.5, h: 103, l: 101, c: 102.5, rows: [[101, 40, 10], [102, 40, 20], [103, 30, 0]] },
  { o: 102.5, h: 104, l: 102, c: 103.5, rows: [[102, 30, 10], [103, 30, 10], [104, 20, 0]] },
  { o: 103.5, h: 103.5, l: 100.5, c: 101, rows: [[101, 20, 50], [102, 20, 40], [103, 20, 30]] },
  { o: 101, h: 101.5, l: 99, c: 99.5, rows: [[99, 1, 2], [100, 20, 40], [101, 29, 38]] },
  { o: 99.5, h: 102, l: 99.5, c: 101.8, rows: [[100, 40, 10], [101, 40, 10], [102, 30, 10]] },
  { o: 101.8, h: 103, l: 101, c: 102.5, rows: even(101, 103, 30, 20) },
  { o: 102.5, h: 104.8, l: 102.3, c: 104.5, rows: [[103, 50, 10], [104, 60, 10]] },
];
const D_DAY: BarSpec[] = [
  { o: 100, h: 101, l: 99, c: 100 },
  { o: 100, h: 102, l: 99.5, c: 101.5, rows: [[100, 30, 20], [101, 40, 20], [102, 30, 10]] },
  { o: 101.5, h: 103, l: 100.5, c: 102, rows: [[101, 30, 20], [102, 40, 20], [103, 30, 10]] },
  { o: 102, h: 102.5, l: 100.5, c: 101, rows: [[101, 20, 30], [102, 20, 30]] },
  { o: 101, h: 102, l: 100, c: 101.5, rows: [[100, 20, 20], [101, 25, 20], [102, 25, 20]] },
  { o: 101.5, h: 104, l: 101, c: 103.8, rows: [[101, 20, 10], [102, 40, 10], [103, 40, 10], [104, 30, 5]] },
  { o: 103.8, h: 104.5, l: 103, c: 104, rows: [[103, 30, 20], [104, 30, 20]] },
  { o: 103, h: 103.2, l: 101.3, c: 102.3, rows: [[101, 20, 100], [102, 30, 40], [103, 30, 25]] },
  { o: 102.5, h: 104, l: 102.2, c: 103.8, rows: [[103, 60, 10], [104, 50, 10]] },
];
const P = (o: number, h: number, l: number, c: number): BarSpec => ({ o, h, l, c });
const B_PRIOR: BarSpec[] = [P(100,101,99,100.5),P(100.5,100.8,99.5,100),P(100,101.5,100,101),P(101,102,100.5,101.5),P(101.5,103,101,102.5),P(102.5,102.8,101.8,102.5),P(102.5,102.5,101,101.5),P(101.5,102,101.2,101.5),P(101.5,102,100.8,101.5),P(101.5,101.9,101,101.8),P(101.8,103,101.5,102.8),P(102.8,104,102.5,103.9)];
const B_DAY: BarSpec[] = [P(104,105,103,104.5),P(104.5,105.5,104,105),P(105,105.8,104.2,105.2),P(105.2,105.9,104.5,105),P(105,105.9,104.3,105.5),P(105.5,105.9,104.6,105.4),
  { o: 105.4, h: 108, l: 105.3, c: 107.8, rows: [[105, 20, 20], [106, 80, 10], [107, 90, 10], [108, 60, 5]] },
  { o: 107.8, h: 108, l: 106.2, c: 107, rows: [[106, 20, 30], [107, 30, 30]] }];

const find = (r: SetupResult[], setup: string, side: string) => r.find((x) => x.setup === setup && x.side === side)!;
const run = (c: SetupContext) => evaluateDhanSetups(c).results;
const bCtx = (rvol: number | null = 2) => { const c = contextOf(B_PRIOR, B_DAY); c.rvol = c.bars.map((_, k) => (k === B_PRIOR.length + 6 ? rvol : null)); return c; };

/** Reflect a context around 250 (p -> 250 - p, highs <-> lows, buy <-> sell): the bearish twin of a bullish day. */
function reflect(c: SetupContext): SetupContext {
  const fps = c.fps.map((f) => ({ ...f, levels: f.levels.map((l) => ({ price: 250 - l.price, buy: l.sell, sell: l.buy, unclassified: l.unclassified })).sort((a, b) => a.price - b.price), buyVolume: f.sellVolume, sellVolume: f.buyVolume, delta: f.delta == null ? null : -f.delta, deltaPct: f.deltaPct == null ? null : -f.deltaPct, high: 250 - f.low!, low: 250 - f.high!, close: 250 - f.close! }));
  const bar = (b: SetupContext['bars'][number]) => ({ ...b, open: 250 - b.open, high: 250 - b.low, low: 250 - b.high, close: 250 - b.close });
  const vwapSums = fps.map((f) => f.levels.reduce((a, l) => { const q = l.buy + l.sell; return { pv: a.pv + l.price * q, v: a.v + q, p2v: a.p2v + l.price * l.price * q }; }, { pv: 0, v: 0, p2v: 0 }));
  return { ...c, bars: c.bars.map(bar), fps, daily: c.daily.map(bar), vwapSums };
}

describe('Setup A: liquidity sweep + absorption reversal', () => {
  it('signals after sweep, confirmed absorption, CVD, imbalance, CHoCH and a held retest', () => {
    const a = find(run(contextOf(QUIET, A_DAY)), 'A', 'BULLISH');
    expect(a).toMatchObject({ status: 'SIGNAL', failed: null, strategy: 'DHAN_A_SWEEP_ABSORPTION', plan: { entry: 103.6, sl: 96.6864, target: 120, targetKind: 'PDH', rr: 2.37 } });
    expect(a.checks.every((c) => c.ok)).toBe(true);
    expect(a.score).toMatchObject({ total: 8, eligibility: 'PREFERRED' });
    expect(a.score!.lines.find((l) => l.item === 'HTF_ALIGNMENT')!.points).toBe(0);
    expect(a.gates.every((g) => g.ok)).toBe(true);
    expect(a.noTrade).toEqual({ tradeable: true, reasons: [], notEvaluated: ['OPTION_SPREAD', 'DAILY_LOSS_LIMIT', 'FO_RESTRICTIONS'] });
  });
  it('the reflected (bearish) day signals the mirror trade through the same rules', () => {
    const r = run(reflect(contextOf(QUIET, A_DAY)));
    expect(find(r, 'A', 'BEARISH')).toMatchObject({ status: 'SIGNAL', plan: { entry: 146.4, sl: 153.3136, target: 130, rr: 2.37 } });
    expect(find(r, 'A', 'BULLISH').status).toBe('NO_SETUP');
  });
  it('names the condition that failed', () => {
    const noRetest = A_DAY.map((b, k) => (k === 8 ? { ...b, c: 102.9 } : b));
    expect(find(run(contextOf(QUIET, noRetest)), 'A', 'BULLISH')).toMatchObject({ status: 'NO_SETUP', failed: 'A9_RETEST_HOLDS' });
    const absorptionFails = A_DAY.map((b, k) => (k === 6 ? { ...b, l: 96.5 } : b));
    expect(find(run(contextOf(QUIET, absorptionFails)), 'A', 'BULLISH').failed).toBe('A4_A5_ABSORPTION_CONFIRMED');
  });
  it('8 Nov: a lost bar of the session (restart gap) ends the session CVD -> no CVD-based setup on incomplete totals', () => {
    const c = contextOf(QUIET, A_DAY);
    c.health = { ...c.health, sessionGapAt: OPEN + 2 * Q };
    expect(find(run(c), 'A', 'BULLISH')).toMatchObject({ status: 'NO_SETUP', failed: 'A6_CVD_IMPROVES' });
    // A gap after the decision bar changes nothing.
    const later = contextOf(QUIET, A_DAY);
    later.health = { ...later.health, sessionGapAt: OPEN + 20 * Q };
    expect(find(run(later), 'A', 'BULLISH').status).toBe('SIGNAL');
  });
  it('second audit: previous-day / week levels from an incomplete day are not used (here the swept PDL / PWL)', () => {
    const c = contextOf(QUIET, A_DAY, { referenceComplete: { previousDay: false, previousWeek: false } });
    expect(find(run(c), 'A', 'BULLISH')).toMatchObject({ status: 'NO_SETUP', failed: 'A2_SWEEP' });
    expect(find(run(contextOf(QUIET, A_DAY, { referenceComplete: { previousDay: true, previousWeek: true } })), 'A', 'BULLISH').status).toBe('SIGNAL');
  });
  it('a stale feed turns the signal into NO_TRADE (gate and no-trade reason both recorded)', () => {
    const a = find(run(contextOf(QUIET, A_DAY, { health: { stale: true, mappingValid: true } })), 'A', 'BULLISH');
    expect(a.status).toBe('NO_TRADE');
    expect(a.gates.find((g) => g.id === 'VALID_DATA')!.ok).toBe(false);
    expect(a.noTrade!.reasons).toContain('FEED_STALE');
  });
});

describe('Setup B: footprint imbalance breakout', () => {
  it('signals a stacked-imbalance breakout from a box, on 30-minute bullish structure, with RVOL, after a retest', () => {
    const b = find(run(bCtx()), 'B', 'BULLISH');
    expect(b).toMatchObject({ status: 'SIGNAL', plan: { entry: 107, sl: 105.7, target: 120, rr: 10 } });
    expect(b.checks.map((c) => c.id)).toEqual(['B1_HTF_BULLISH', 'B2_ABOVE_VWAP', 'B3_CONSOLIDATION_BELOW_RESISTANCE', 'B4_RVOL_EXPANSION', 'B5_DELTA_EXPANSION', 'B6_STACKED_BUY_IMBALANCE', 'B7_CLOSE_ABOVE_RESISTANCE', 'B8_RETEST_HOLDS', 'B9_NO_OPPOSING_ABSORPTION']);
    expect(b.score).toMatchObject({ total: 8, eligibility: 'PREFERRED' });
    expect(find(run(reflect(bCtx())), 'B', 'BEARISH')).toMatchObject({ status: 'SIGNAL', plan: { entry: 143, sl: 144.3, target: 130 } });
  });
  it('8 Nov: never reads an incomplete session VWAP (restart gap)', () => {
    const c = bCtx();
    c.health = { ...c.health, sessionGapAt: OPEN + Q };
    expect(find(run(c), 'B', 'BULLISH').failed).toBe('B2_ABOVE_VWAP');
  });
  it('never fires without measured participation (RVOL unavailable until 20 sessions are recorded)', () => {
    expect(find(run(bCtx(null)), 'B', 'BULLISH').failed).toBe('B4_RVOL_EXPANSION');
    expect(find(run(bCtx(1.2)), 'B', 'BULLISH').failed).toBe('B4_RVOL_EXPANSION');
  });
});

describe('Setup C: failed auction + CVD divergence', () => {
  it('meets every condition; a 5/10 score is rejected (NO_TRADE), never traded', () => {
    const c = find(run(contextOf(QUIET, C_DAY)), 'C', 'BULLISH');
    expect(c.failed).toBeNull();
    expect(c.checks.find((x) => x.id === 'C2_CVD_HIGHER_LOW')!.value).toEqual({ cvd: [-200, -150] });
    expect(c.score).toMatchObject({ total: 5, eligibility: 'REJECT' });
    expect(c.status).toBe('NO_TRADE');
    expect(find(run(reflect(contextOf(QUIET, C_DAY))), 'C', 'BEARISH')).toMatchObject({ failed: null, status: 'NO_TRADE', score: { total: 5 } });
  });
  it('divergence alone is not an entry: without the BOS on the decision bar it is NO_SETUP', () => {
    const noBos = C_DAY.map((b, k) => (k === 9 ? { ...b, c: 104.1 } : b));
    expect(find(run(contextOf(QUIET, noBos)), 'C', 'BULLISH').failed).toBe('C7_BULLISH_BOS');
  });
});

describe('Setup D: VWAP + volume-profile rejection', () => {
  it('meets every condition at the VWAP; scored 6/10 it is NO_TRADE', () => {
    const d = find(run(contextOf(QUIET, D_DAY)), 'D', 'BULLISH');
    expect(d.checks[0]).toMatchObject({ id: 'D1_ZONE_REJECTED', value: { kind: 'VWAP', touchIndex: 7 } });
    expect(d).toMatchObject({ failed: null, status: 'NO_TRADE', score: { total: 6, eligibility: 'REJECT' }, plan: { entry: 103.8, sl: 101.02 } });
  });
  it('a touch without absorption is not a setup', () => {
    const noAbs = D_DAY.map((b, k) => (k === 7 ? { ...b, rows: even(101, 103, 40, 40) } : b));
    expect(find(run(contextOf(QUIET, noAbs)), 'D', 'BULLISH').failed).toBe('D2_BULLISH_ABSORPTION');
  });
});

describe('sessions and timeframes', () => {
  it('NSE/BSE windows per Part 17; MCX keeps its own session', () => {
    const at = (h: number, m: number) => Date.parse('2026-11-09T00:00:00Z') - 19_800_000 + (h * 60 + m) * 60_000;
    expect([sessionWindow('NSE', at(9, 30)), sessionWindow('NSE', at(9, 45)), sessionWindow('BSE', at(12, 0)), sessionWindow('NSE', at(14, 0)), sessionWindow('NSE', at(15, 0))]).toEqual(['OPENING_OBSERVATION', 'PRIMARY', 'SELECTIVE', 'SECONDARY', 'AFTER_CUTOFF']);
    // A bar closing at 14:45 cannot be entered inside the secondary window (it ends at 14:45).
    expect([sessionWindow('NSE', at(14, 30)), sessionWindow('NSE', at(14, 45))]).toEqual(['SECONDARY', 'AFTER_CUTOFF']);
    expect([sessionWindow('MCX', at(9, 15)), sessionWindow('MCX', at(21, 0))]).toEqual(['MCX_OPENING_OBSERVATION', 'MCX_SESSION']);
  });
  it('30-minute bars pair 15-minute bars from each session open', () => {
    const b = (t: number, h: number, l: number) => ({ time: t, open: l, high: h, low: l, close: h, volume: 1 });
    expect(thirtyMinuteBars([b(OPEN, 2, 1), b(OPEN + Q, 3, 0.5), b(OPEN + 2 * Q, 4, 2), b(OPEN + 86_400_000, 9, 8)])).toEqual([
      { time: OPEN, open: 1, high: 3, low: 0.5, close: 3, volume: 2 }, { time: OPEN + 2 * Q, open: 2, high: 4, low: 2, close: 4, volume: 1 }, { time: OPEN + 86_400_000, open: 8, high: 9, low: 8, close: 9, volume: 1 }]);
  });
});

describe('expiry gamma module (owner\'s definition)', () => {
  const ist = (h: number, m: number) => Date.parse('2026-11-10T00:00:00Z') - 19_800_000 + (h * 60 + m) * 60_000; // Tuesday expiry
  const strikes = (calls: number[], puts: number[]) => [23800, 23900, 24000, 24100, 24200].map((strike, k) => ({ strike, callOi: calls[k], putOi: puts[k] }));
  const base: GammaSample = { at: ist(13, 10), spot: 23990, strikes: strikes([500, 700, 1000, 600, 400], [900, 800, 800, 500, 300]) };
  const squeeze: GammaSample = { at: ist(13, 58), spot: 24010, strikes: strikes([500, 700, 700, 600, 400], [900, 900, 1100, 500, 300]) };
  const input = { index: 'NIFTY', expiryToday: true, now: ist(14, 0), samples: [squeeze, base], dayHigh: 24015, dayLow: 23900, r1: null, futuresPrice: 24050, futuresVwap: 24000, strikeStep: 100 };
  it('bullish squeeze: tests the day high, ATM call OI -300, put OI +300, PCR 1.031 -> 1.276', () => {
    const [bull, bear] = evaluateExpiryGamma(input);
    expect(bull).toMatchObject({ strategy: 'DHAN_EXPIRY_GAMMA', side: 'BULLISH', status: 'SIGNAL', strikes: { atm: 24000, itm: 23900, right: 'CE' }, forcedExitAt: ist(15, 15), evidence: { dCallOi: -300, dPutOi: 300, pcrBase: 1.031, pcrNow: 1.276, pinned: true, maxOiStrike: 24000 } });
    expect(bear).toMatchObject({ status: 'NO_SETUP', failed: 'G4_BREAKS_DAY_LOW_OR_VWAP' });
  });
  it('bearish flush: spot below the day low while ATM put writers exit', () => {
    const flush: GammaSample = { at: ist(13, 58), spot: 23880, strikes: strikes([500, 800, 1000, 600, 400], [900, 500, 800, 500, 300]) };
    const [bull, bear] = evaluateExpiryGamma({ ...input, samples: [base, flush] });
    expect(bear).toMatchObject({ status: 'SIGNAL', strikes: { atm: 23900, itm: 24000, right: 'PE' }, evidence: { dPutOi: -300 } });
    expect(bull.status).toBe('NO_SETUP');
  });
  it('only on expiry day, 13:30-15:00, on a fresh chain with a midday baseline', () => {
    expect(evaluateExpiryGamma({ ...input, expiryToday: false })[0].failed).toBe('G0_EXPIRY_DAY');
    expect(evaluateExpiryGamma({ ...input, now: ist(15, 5), samples: [base, { ...squeeze, at: ist(15, 4) }] })[0].failed).toBe('G1_ENTRY_WINDOW');
    expect(evaluateExpiryGamma({ ...input, now: ist(14, 10) })[0].failed).toBe('G2_FRESH_CHAIN');
    expect(evaluateExpiryGamma({ ...input, samples: [squeeze] })[0].failed).toBe('G3_MIDDAY_BASELINE');
    expect(evaluateExpiryGamma({ ...input, samples: [base, { ...squeeze, strikes: strikes([500, 700, 900, 600, 400], [900, 800, 850, 500, 300]) }] })[0].failed).toBe('G7_PCR_SHARPLY_HIGHER');
  });
  it('R1 floor pivot', () => {
    expect(pivotR1({ high: 110, low: 100, close: 108 })).toBe(112);
  });
});
