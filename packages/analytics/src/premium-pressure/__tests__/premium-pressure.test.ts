import { describe, expect, it } from 'vitest';
import { blackScholesPrice, calculateGreeks } from '../../greeks/index.js';
import { analyzePremiumPressure, ppClassifyLoss, ppDecompose, ppEntryPlan, ppGammaFlip, ppOiRead, ppPeriod, ppReplay, ppReplayStats, GXP_CONFIG, type PpLeg, type PpSample } from '../index.js';

const T0 = Date.parse('2026-11-17T05:30:00Z'); // 11:00 IST
const min = 60_000;
interface Shape { spot: number; ceIv?: number; peIv?: number; ceOi?: number; peOi?: number; ceVol?: number; peVol?: number; mte?: number; spread?: number; drop?: number[] }
/** A Black-Scholes-consistent chain: 7 strikes around 25000, step 50. */
function sample(at: number, x: Shape): PpSample {
  const mte = x.mte ?? 3 * 1440, t = mte / (365 * 1440);
  const leg = (strike: number, type: 'CE' | 'PE', iv: number, oi: number, volume: number): PpLeg => {
    const input = { spotPrice: x.spot, strikePrice: strike, timeToExpiry: t, riskFreeRate: 0.065, iv: iv / 100, optionType: type } as const;
    const ltp = Math.round(blackScholesPrice(input) * 20) / 20, g = calculateGreeks(input), half = (x.spread ?? 0.002) * ltp;
    return { ltp, bid: ltp - half, ask: ltp + half, oi, volume, iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
  };
  return {
    at, spot: x.spot, spotAt: at, expiry: '2026-11-19', minutesToExpiry: mte, strikeStep: 50,
    strikes: [24850, 24900, 24950, 25000, 25050, 25100, 25150].filter((k) => !(x.drop ?? []).includes(k)).map((strike) => ({
      strike, call: leg(strike, 'CE', x.ceIv ?? 14, x.ceOi ?? 100_000, x.ceVol ?? 50_000), put: leg(strike, 'PE', x.peIv ?? 14, x.peOi ?? 100_000, x.peVol ?? 50_000),
    })),
  };
}
/** Samples every minute for 10 minutes, each shape interpolated linearly from `a` to `b`. */
function series(a: Shape, b: Shape, n = 10, start = T0): PpSample[] {
  const lerp = (p: number | undefined, q: number | undefined, f: number, dflt: number) => (p ?? dflt) + ((q ?? dflt) - (p ?? dflt)) * f;
  return Array.from({ length: n + 1 }, (_, i) => {
    const f = i / n;
    return sample(start + i * min, { spot: lerp(a.spot, b.spot, f, 25000), ceIv: lerp(a.ceIv, b.ceIv, f, 14), peIv: lerp(a.peIv, b.peIv, f, 14), ceOi: lerp(a.ceOi, b.ceOi, f, 100_000), peOi: lerp(a.peOi, b.peOi, f, 100_000), ceVol: lerp(a.ceVol, b.ceVol, f, 50_000), peVol: lerp(a.peVol, b.peVol, f, 50_000), mte: (a.mte ?? 3 * 1440) - i, spread: a.spread, drop: a.drop });
  });
}
const run = (samples: PpSample[], extra: Partial<Parameters<typeof analyzePremiumPressure>[0]> = {}) => analyzePremiumPressure({ symbol: 'NIFTY', now: samples[samples.length - 1].at + 1000, samples, sessionOpen: T0 - 105 * min, ...extra });
const OPEN = T0 - 105 * min;

describe('premium pressure: signals', () => {
  it('1. PE premium crush with bullish confirmation -> BULLISH_PREMIUM_PRESSURE', () => {
    const a = run(series({ spot: 25000, peIv: 14, peOi: 100_000, peVol: 50_000 }, { spot: 25030, peIv: 12.6, peOi: 104_000, peVol: 62_000 }));
    expect(a.classification).toBe('BULLISH_PREMIUM_PRESSURE');
    expect(['BULLISH', 'STRONG_BULLISH']).toContain(a.state);
    expect(a.pe!.writerPressure).toBeGreaterThan(a.ce!.writerPressure);
    expect(a.pe!.pressurePct!).toBeLessThan(0);
    expect(a.explanation.join(' ')).toMatch(/PE premium/);
    expect(a.invalidation.length).toBeGreaterThan(0);
  });
  it('2. CE premium crush with bearish confirmation -> BEARISH_PREMIUM_PRESSURE', () => {
    const a = run(series({ spot: 25000 }, { spot: 24970, ceIv: 12.6, ceOi: 104_000, ceVol: 62_000 }));
    expect(a.classification).toBe('BEARISH_PREMIUM_PRESSURE');
    expect(['BEARISH', 'STRONG_BEARISH']).toContain(a.state);
    expect(a.score).toBeLessThan(0);
  });
  it('3. both sides crushed with a quiet underlying -> DUAL_SIDE_COMPRESSION, no direction', () => {
    const a = run(series({ spot: 25000 }, { spot: 25001, ceIv: 12.8, peIv: 12.8 }));
    expect(a.classification).toBe('DUAL_SIDE_COMPRESSION');
    expect(a.state).toBe('NEUTRAL');
    expect(ppEntryPlan(a, [], 20, 25001)).toEqual({ ok: false, code: 'NO_DIRECTIONAL_PRESSURE' });
  });
  it('4. premium expansion from IV alone, no underlying move -> not a directional signal', () => {
    const a = run(series({ spot: 25000 }, { spot: 25000, ceIv: 15.5 }));
    expect(a.classification).not.toBe('BULLISH_PREMIUM_PRESSURE');
    expect(['NEUTRAL', 'LOW_CONFIDENCE']).toContain(a.state);
  });
  it('5/6. premium decline reads as potential writing with OI up, long unwinding with OI down', () => {
    expect(ppOiRead(-4, 2)).toBe('POTENTIAL_WRITING');
    expect(ppOiRead(-4, -2)).toBe('POTENTIAL_LONG_UNWINDING');
    expect(ppOiRead(4, -2)).toBe('POTENTIAL_SHORT_COVERING');
    expect(ppOiRead(4, 2)).toBe('POTENTIAL_LONG_BUILDUP');
    expect(ppOiRead(-0.1, 2)).toBe('UNCLEAR');
    expect(ppOiRead(-4, null)).toBe('UNCLEAR');
    const up = run(series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 104_000 }));
    const down = run(series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 96_000 }));
    expect(up.pe!.writingShare).toBe(1);
    expect(down.pe!.writingShare).toBe(0);
    expect(up.pe!.writerPressure).toBeGreaterThan(down.pe!.writerPressure);
  });
  it('7. IV crush without directional movement is classified IV_CRUSH_DOMINATED', () => {
    const a = run(series({ spot: 25000 }, { spot: 25000, ceIv: 12.5, peIv: 12.5 }));
    expect(a.ce!.decay).toBe('IV_CRUSH_DOMINATED');
    expect(a.pe!.decay).toBe('IV_CRUSH_DOMINATED');
    expect(a.classification).not.toMatch(/BULLISH|BEARISH/);
  });
  it('8. expiry-day decay with flat IV and spot is THETA_DOMINATED and scores no writer pressure', () => {
    const a = run(series({ spot: 25000, mte: 150 }, { spot: 25000, mte: 150 }));
    expect(a.period).toBe('EXPIRY');
    expect(a.ce!.decay).toBe('THETA_DOMINATED_DECAY');
    expect(a.pe!.decay).toBe('THETA_DOMINATED_DECAY');
    expect(a.ce!.writerParts.compression).toBeLessThan(25);
    expect(a.classification).not.toMatch(/BULLISH|BEARISH/);
  });
  it('decomposition: a pure underlying move against the option is DIRECTIONAL_DECAY and adds up', () => {
    const [b, a] = [sample(T0, { spot: 25000 }), sample(T0 + 5 * min, { spot: 24960, mte: 3 * 1440 - 5 })];
    const d = ppDecompose(b.strikes[3].call!, a.strikes[3].call!, -40, 5, 5);
    expect(d.classification).toBe('DIRECTIONAL_DECAY');
    expect(d.reliable).toBe(true);
    expect(Math.abs(d.actual - (d.directional + d.theta + d.vega + d.residual))).toBeLessThan(0.02);
    expect(Math.abs(d.residual)).toBeLessThan(Math.abs(d.actual) * 0.2);
  });
});

describe('premium pressure: GEX context', () => {
  it('9. gamma flip: found between put-heavy and call-heavy strikes; a crossing is reported', () => {
    const tilt = (s: PpSample) => ({ ...s, strikes: s.strikes.map((k) => ({ ...k, call: { ...k.call!, oi: k.strike >= 25000 ? 400_000 : 20_000 }, put: { ...k.put!, oi: k.strike < 25000 ? 400_000 : 20_000 } })) });
    const below = tilt(sample(T0, { spot: 24940 })), flip = ppGammaFlip(below)!;
    expect(flip).toBeGreaterThan(24700); expect(flip).toBeLessThan(25100);
    const ss = series({ spot: flip - 25 }, { spot: flip + 25 }).map(tilt);
    const a = run(ss);
    expect(a.gex!.estimated).toBe(true);
    expect(a.gex!.flipCrossed).toBe('UP');
    expect(a.gex!.gammaFlip).not.toBeNull();
  });
  it('positive GEX is not bullish and negative GEX is not bearish: no premium evidence, no direction', () => {
    const heavy = (callOi: number, putOi: number) => series({ spot: 25000, ceOi: callOi, peOi: putOi }, { spot: 25001, ceOi: callOi, peOi: putOi });
    for (const a of [run(heavy(500_000, 50_000)), run(heavy(50_000, 500_000))]) expect(a.classification).not.toMatch(/BULLISH|BEARISH/);
  });
  it('a long-gamma pin at the wall lowers the score of the same premium evidence', () => {
    const base = series({ spot: 25000 }, { spot: 25012, peIv: 12.6, peOi: 104_000, peVol: 62_000 });
    const pinned = base.map((s) => ({ ...s, strikes: s.strikes.map((k) => (k.strike === 25000 ? { ...k, call: { ...k.call!, oi: k.call!.oi! + 3_000_000 } } : k)) }));
    expect(run(pinned).gex!.pinned).toBe(true);
    expect(run(pinned).components.gex!).toBeLessThan(run(base).components.gex ?? 0.001);
  });
});

describe('premium pressure: trap and data quality', () => {
  it('10. false breakout: CE expands, the move fails, CE reverses, PE expands, CE OI unconfirmed -> PREMIUM_TRAP, no entry', () => {
    const up = series({ spot: 25000 }, { spot: 25045, ceIv: 14.8 }, 5), down = series({ spot: 25045, ceIv: 14.8 }, { spot: 24998, ceIv: 13.6, peIv: 14.6 }, 5, T0 + 5 * min).slice(1).map((s, i) => ({ ...s, minutesToExpiry: 3 * 1440 - 6 - i }));
    const a = run([...up, ...down]);
    expect(a.classification).toBe('PREMIUM_TRAP');
    expect(a.trap!.side).toBe('CE');
    expect(ppEntryPlan(a, [], 20, 24998).ok).toBe(false);
  });
  it('11. a stale chain snapshot is a DATA_GAP', () => {
    const ss = series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 104_000 });
    const a = analyzePremiumPressure({ symbol: 'NIFTY', now: ss[ss.length - 1].at + 4 * min, samples: ss });
    expect(a.state).toBe('DATA_GAP'); expect(a.dataQuality.issues).toContain('STALE_CHAIN_SNAPSHOT');
  });
  it('12. missing OI / Greeks never count for the signal: no writer OI part, confidence reduced, flagged', () => {
    const ss = series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 104_000, peVol: 62_000 });
    const full = run(ss);
    const noOi = run(ss.map((s) => ({ ...s, strikes: s.strikes.map((k) => ({ ...k, call: { ...k.call!, oi: null }, put: { ...k.put!, oi: null } })) })));
    expect(noOi.dataQuality.issues).toContain('MISSING_OI');
    expect(noOi.components.oiVolume).toBeNull();
    expect(noOi.confidence).toBeLessThan(full.confidence);
    expect(noOi.pe!.writerParts.oi).toBeNull();
    const noGreeks = run(ss.map((s) => ({ ...s, strikes: s.strikes.map((k) => ({ ...k, call: { ...k.call!, delta: null, gamma: null, theta: null, vega: null }, put: { ...k.put!, delta: null, gamma: null, theta: null, vega: null } })) })));
    expect(noGreeks.dataQuality.issues).toContain('DECOMPOSITION_UNRELIABLE');
    expect(noGreeks.confidence).toBeLessThan(full.confidence);
    expect(noGreeks.components.decomposition).toBeNull();
  });
  it('13. illiquid strikes (wide books) and missing strikes cannot produce a signal', () => {
    const wide = run(series({ spot: 25000, spread: 0.2 }, { spot: 25030, peIv: 12.6, peOi: 104_000, spread: 0.2 }));
    expect(wide.state).toBe('DATA_GAP'); expect(wide.dataQuality.issues).toContain('ILLIQUID_OR_MISSING_STRIKES');
    const holes = run(series({ spot: 25000, drop: [24950, 25050, 25100] }, { spot: 25030, peIv: 12.6, peOi: 104_000 }));
    expect(holes.state).toBe('DATA_GAP');
    const zero = series({ spot: 25000 }, { spot: 25030 }).map((s) => ({ ...s, strikes: s.strikes.map((k) => ({ ...k, put: { ...k.put!, ltp: 0, bid: 0, ask: 0 } })) }));
    expect(run(zero).state).toBe('DATA_GAP');
  });
  it('14. last 30 minutes of expiry: its own (stricter) rules and no paper entry', () => {
    expect(ppPeriod(3 * 1440)).toBe('NON_EXPIRY'); expect(ppPeriod(200)).toBe('EXPIRY'); expect(ppPeriod(55)).toBe('EXPIRY_LAST_60'); expect(ppPeriod(25)).toBe('EXPIRY_LAST_30');
    expect(GXP_CONFIG.periods.EXPIRY_LAST_30.entryScore).toBeGreaterThan(GXP_CONFIG.periods.EXPIRY.entryScore);
    const a = run(series({ spot: 25000, mte: 28, peIv: 16, ceIv: 16 }, { spot: 25040, mte: 28, peIv: 11, ceIv: 16, peOi: 108_000, peVol: 70_000 }));
    expect(a.period).toBe('EXPIRY_LAST_30');
    const bars = Array.from({ length: 6 }, (_, i) => ({ time: T0 + i * 5 * min, open: 25000 + i * 5, high: 25010 + i * 6, low: 24995 + i * 5, close: 25005 + i * 6 }));
    const plan = ppEntryPlan({ ...a, state: 'BULLISH' }, bars, 20, 25040);
    expect(plan).toEqual({ ok: false, code: 'NO_ENTRIES_IN_LAST_30_MINUTES' });
  });
  it('15. spot / chain timestamp mismatch and an underlying discontinuity are DATA_GAPs', () => {
    const ss = series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 104_000 });
    const skew = [...ss.slice(0, -1), { ...ss[ss.length - 1], spotAt: ss[ss.length - 1].at - 45_000 }];
    expect(run(skew).dataQuality.issues).toContain('SPOT_CHAIN_TIMESTAMP_MISMATCH');
    const jump = [...ss.slice(0, -1), sample(ss[ss.length - 1].at, { spot: 25600, mte: 3 * 1440 - 10 })];
    expect(run(jump).dataQuality.issues).toContain('UNDERLYING_DISCONTINUITY');
    expect(run(jump).state).toBe('DATA_GAP');
  });
  it('a single sample (no window) and an empty series are DATA_GAPs, never neutral', () => {
    expect(run([sample(T0, { spot: 25000 })]).state).toBe('DATA_GAP');
    expect(analyzePremiumPressure({ symbol: 'NIFTY', now: T0, samples: [] }).state).toBe('DATA_GAP');
  });
});

describe('premium pressure: paper plan, costs, replay', () => {
  const bullish = () => run(series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 104_000, peVol: 62_000 }));
  const bars = Array.from({ length: 8 }, (_, i) => ({ time: OPEN + i * 5 * min, open: 24990 + i * 5, high: 25000 + i * 5, low: 24985 + i * 5, close: 24995 + i * 5 }));
  it('17. entry, structure stop and target: CE for bullish, PE for bearish, 1.5R on the underlying', () => {
    const plan = ppEntryPlan(bullish(), bars, 30, 25030);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.optionSide).toBe('CE');
    expect(plan.stop).toBeLessThan(Math.min(...bars.slice(-6).map((b) => b.low)));
    expect(plan.target - plan.entry).toBeCloseTo((plan.entry - plan.stop) * 1.5, 1);
    expect(plan.strikes).toEqual([25050, 25000]);
    const bear = run(series({ spot: 25000 }, { spot: 24970, ceIv: 12.6, ceOi: 104_000, ceVol: 62_000 }));
    const down = bars.map((b, i) => ({ ...b, high: 25010 - i * 5, low: 24995 - i * 5 }));
    const p2 = ppEntryPlan(bear, down, 30, 24970);
    if (!p2.ok) throw new Error(p2.code);
    expect(p2.optionSide).toBe('PE'); expect(p2.stop).toBeGreaterThan(p2.entry); expect(p2.target).toBeLessThan(p2.entry);
  });
  it('refuses a stop too far and an already-expanded premium; nothing else', () => {
    const far = bars.map((b) => ({ ...b, low: 24900 }));
    expect(ppEntryPlan(bullish(), far, 20, 25030)).toEqual({ ok: false, code: 'STRUCTURE_STOP_TOO_FAR' });
    const a = bullish();
    expect(ppEntryPlan({ ...a, ce: { ...a.ce!, normalizedChange: 3 } }, bars, 20, 25030)).toEqual({ ok: false, code: 'PREMIUM_ALREADY_EXPANDED' });
  });
  it('18. replay pays the spread and charges, has no look-ahead, and is deterministic', () => {
    const day = [...series({ spot: 25000 }, { spot: 25030, peIv: 12.6, peOi: 104_000, peVol: 62_000 }), ...series({ spot: 25030, peIv: 12.6, peOi: 104_000 }, { spot: 25110, peIv: 12.4, peOi: 106_000 }, 20, T0 + 10 * min).slice(1).map((s, i) => ({ ...s, minutesToExpiry: 3 * 1440 - 11 - i }))];
    const opts = { config: GXP_CONFIG, slippagePct: 0.005, costPct: 0.004, maxHoldMin: 90, rr: 1.5, stopSigma: 2, cooldownMin: 30 };
    const a = ppReplay('NIFTY', day, 'GEX_PLUS_PRESSURE', opts), b = ppReplay('NIFTY', day, 'GEX_PLUS_PRESSURE', opts);
    expect(a).toEqual(b);
    expect(a.trades.length).toBeGreaterThan(0);
    const t = a.trades[0];
    expect(t.side).toBe('BULLISH'); expect(t.exitAt).toBeGreaterThan(t.at);
    // Net of charges is strictly below the gross premium difference.
    expect(t.netPoints).toBeLessThan(t.exit - t.entry);
    const costly = ppReplay('NIFTY', day, 'GEX_PLUS_PRESSURE', { ...opts, costPct: 0.05 });
    expect(costly.trades[0].netPoints).toBeLessThan(t.netPoints);
    // Truncating the future does not change what was decided at the entry.
    const cut = ppReplay('NIFTY', day.filter((s) => s.at <= t.at + 2 * min), 'GEX_PLUS_PRESSURE', opts);
    expect(cut.trades[0].at).toBe(t.at); expect(cut.trades[0].entry).toBe(t.entry);
    const stats = ppReplayStats('GEX_PLUS_PRESSURE', [a]);
    expect(stats.trades).toBe(a.trades.length); expect(stats.bullish + stats.bearish).toBe(stats.trades);
    for (const v of ['PRESSURE_ONLY', 'GEX_CONTEXT_ONLY', 'UNDERLYING_BASELINE'] as const) expect(ppReplayStats(v, [ppReplay('NIFTY', day, v, opts)]).variant).toBe(v);
  });
  it('loss classification is routine and deterministic', () => {
    expect(ppClassifyLoss({ exitReason: 'STRUCTURAL_INVALIDATION', netPnl: -100, entry: { confidence: 70, period: 'NON_EXPIRY', components: {} as never } })).toBe('UNDERLYING_REVERSED');
    expect(ppClassifyLoss({ exitReason: 'STRUCTURAL_INVALIDATION', netPnl: -100, entry: { confidence: 48, period: 'NON_EXPIRY', components: {} as never } })).toBe('WEAK_EVIDENCE_AT_ENTRY');
    expect(ppClassifyLoss({ exitReason: 'NO_PROGRESS', netPnl: -100, entry: { confidence: 70, period: 'EXPIRY', components: {} as never } })).toBe('THETA_OUTRAN_THE_MOVE');
    expect(ppClassifyLoss({ exitReason: 'SESSION_CUTOFF', netPnl: -100 })).toBe('TIME_RAN_OUT');
    expect(ppClassifyLoss({ exitReason: 'UNDERLYING_TARGET', netPnl: -10, grossPnl: 30 })).toBe('COSTS_ONLY');
  });
});
