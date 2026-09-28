// ============================================================
// MOMENTUM-BREAK — detector, no-look-ahead, gradePath, roll masking
// ============================================================
// Every bar here is a FABRICATED fixture: flat 15m sessions around 100 with
// a known ATR, then one trigger bar built to pass (or fail exactly one of)
// the rules. The bullish cases mirror the bearish ones (p -> 200 - p).
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  buildMomentumLevels,
  closedBarsAt,
  evaluateMomentumBreak,
  isLevelReclaimed,
  MOMENTUM_BREAK_VARIANTS,
  prepareMomentumSeries,
  recentMomentumBreak,
  slotVolumeBaseline,
  type MomentumBar,
} from '@fno/analytics';
import { gradePath, gradeThesis, type GradeBar } from '../grade-path.js';
import { sessionMasks, borrowVolume, statsOf, passesGoLiveBar, allowedSymbols, chooseVariant, splitDate, type BacktestTrade } from '../../backtest/momentum-backtest.js';

const VARIANT = MOMENTUM_BREAK_VARIANTS.find((v) => v.id === 'R1.5-V1.5')!;
const BAR = 15 * 60 * 1000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

function bar(time: number, open: number, close: number, volume = 1000, wick = 0.2): MomentumBar {
  return { time, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume };
}

/** A 25-bar NSE-like session from 09:15 IST, closes given bar by bar (open = previous close). */
function session(date: string, closes: number[], startOpen: number, volume = 1000): MomentumBar[] {
  const out: MomentumBar[] = [];
  let prev = startOpen;
  closes.forEach((c, k) => {
    out.push(bar(at(date, '09:15') + k * BAR, prev, c, volume));
    prev = c;
  });
  return out;
}

const alternating = (n: number) => Array.from({ length: n }, (_, k) => (k % 2 === 0 ? 100 : 100.5));
const DATES = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16', '2026-01-19'];
const TODAY = '2026-01-20';
// Previous session drifts 100 -> 97 -> 100, giving a previous-day low and a pivot S1 below.
const DRIFT = [...Array.from({ length: 13 }, (_, k) => 100 - 0.25 * k), ...Array.from({ length: 12 }, (_, k) => 97.25 + 0.25 * k)];

/** History + today's bars up to (not including) the trigger at 12:00 IST (bar index 11 of the session). */
function history(prevDays = DATES.length, driftPrevDay = true): MomentumBar[] {
  const days = DATES.slice(DATES.length - prevDays);
  const bars: MomentumBar[] = [];
  let last = 100.5;
  days.forEach((d, k) => {
    const closes = k === days.length - 1 && driftPrevDay ? DRIFT : alternating(25);
    bars.push(...session(d, closes, last));
    last = bars[bars.length - 1].close;
  });
  bars.push(...session(TODAY, alternating(11).map((c, k) => (k === 10 ? 100.5 : c)), last));
  return bars;
}

const triggerTime = at(TODAY, '12:00');
/** Bearish trigger: breaks today's low (99.8) and closes near its low on 3x volume. */
function bearishTrigger(over: Partial<MomentumBar> = {}): MomentumBar {
  return { time: triggerTime, open: 100.1, high: 100.1, low: 99.1, close: 99.2, volume: 3000, ...over };
}
function after(n: number, from: number, step: number): MomentumBar[] {
  return Array.from({ length: n }, (_, k) => bar(triggerTime + (k + 1) * BAR, from + step * k, from + step * (k + 1)));
}

const mirror = (b: MomentumBar): MomentumBar => ({ time: b.time, open: 200 - b.open, close: 200 - b.close, high: 200 - b.low, low: 200 - b.high, volume: b.volume });

function evalAt(bars: MomentumBar[], i = bars.length - 1) {
  return evaluateMomentumBreak(prepareMomentumSeries(bars), i, VARIANT);
}

describe('momentum-break detector — fires, both directions', () => {
  it('fires bearish through the nearest broken level with a level target at least 1.5 stop-distances away', () => {
    const bars = [...history(), bearishTrigger()];
    const ev = evalAt(bars);
    expect(ev.failed).toBeNull();
    const s = ev.signal!;
    expect(s.direction).toBe('BEARISH');
    expect(s.levelPrice).toBeCloseTo(99.8, 5);
    expect(['DAY_LOW', 'OPENING_RANGE_LOW', 'SWING_LOW']).toContain(s.levelKind);
    expect(s.entry).toBe(99.2);
    // stop = max(level + 0.25 ATR, close + 0.5 ATR)
    expect(s.stop).toBeCloseTo(Math.max(99.8 + 0.25 * s.atr, 99.2 + 0.5 * s.atr), 1);
    expect(s.target).toBeLessThanOrEqual(s.entry - 1.5 * (s.stop - s.entry) + 1e-6);
    expect(s.rUnderlying).toBeGreaterThanOrEqual(1.5);
    expect(s.quality).toBeGreaterThanOrEqual(70);
    expect(s.quality).toBeLessThanOrEqual(95);
  });

  it('fires bullish on the mirrored series', () => {
    const bars = [...history(), bearishTrigger()].map(mirror);
    const s = evalAt(bars).signal!;
    expect(s.direction).toBe('BULLISH');
    expect(s.levelPrice).toBeCloseTo(100.2, 5);
    expect(s.entry).toBeCloseTo(100.8, 5);
    expect(s.stop).toBeLessThan(s.levelPrice);
    expect(s.target).toBeGreaterThanOrEqual(s.entry + 1.5 * (s.entry - s.stop) - 1e-6);
  });

  it('invalidation is a close back through the broken level', () => {
    expect(isLevelReclaimed('BEARISH', 99.8, 99.9)).toBe(true);
    expect(isLevelReclaimed('BEARISH', 99.8, 99.7)).toBe(false);
    expect(isLevelReclaimed('BULLISH', 100.2, 100.1)).toBe(true);
  });
});

describe('momentum-break detector — each filter refuses on its own', () => {
  it('RANGE_TOO_SMALL', () => {
    const h = history();
    h[h.length - 1] = { ...h[h.length - 1], close: 99.9, high: 100.1 };
    expect(evalAt([...h, bearishTrigger({ open: 99.9, high: 99.9, low: 99.55, close: 99.6 })]).failed).toBe('RANGE_TOO_SMALL');
  });
  it('VOLUME_TOO_LOW', () => {
    expect(evalAt([...history(), bearishTrigger({ volume: 1400 })]).failed).toBe('VOLUME_TOO_LOW');
  });
  it('WEAK_CLOSE (close not in the lower 35% of the range)', () => {
    expect(evalAt([...history(), bearishTrigger({ low: 98.5 })]).failed).toBe('WEAK_CLOSE');
  });
  it('CHASING (close more than 1 ATR beyond the level)', () => {
    expect(evalAt([...history(), bearishTrigger({ low: 98.1, close: 98.2 })]).failed).toBe('CHASING');
  });
  it('NO_LEVEL_BROKEN (a big bar that clears no level)', () => {
    // Falls from 100.5 to 100.35: above session VWAP (~100.25) and the day low.
    expect(evalAt([...history(), bearishTrigger({ high: 101.5, low: 100.3, close: 100.35 })]).failed).toBe('NO_LEVEL_BROKEN');
  });
  it('NO_LEVEL_BROKEN (the close must clear the level by 0.1 ATR, not just touch it)', () => {
    const ev = evalAt([...history(), bearishTrigger({ low: 99.7, close: 99.78 })]);
    expect(ev.levels.find((l) => l.kind === 'DAY_LOW')!.price).toBeCloseTo(99.8, 5);
    // 99.78 is below the day low but by less than 0.1 ATR, so only VWAP (above) counts as broken — the day low does not.
    const s = evalAt([...history(), bearishTrigger({ low: 99.7, close: 99.78, volume: 3000, high: 101.2 })]);
    expect(s.signal?.levelKind).not.toBe('DAY_LOW');
  });
  it('NO_TARGET when no level sits 1.5 stop-distances ahead', () => {
    expect(evalAt([...history(DATES.length, false), bearishTrigger()]).failed).toBe('NO_TARGET');
  });
  it('NO_VOLUME_BASELINE with fewer than 5 previous sessions of the same slot', () => {
    expect(evalAt([...history(4), bearishTrigger()]).failed).toBe('NO_VOLUME_BASELINE');
  });
  it('the same thresholds scale by variant: 1.9x volume passes V1.5 and fails V2.0', () => {
    const bars = [...history(), bearishTrigger({ volume: 1900 })];
    const series = prepareMomentumSeries(bars);
    expect(evaluateMomentumBreak(series, bars.length - 1, VARIANT).signal).not.toBeNull();
    expect(evaluateMomentumBreak(series, bars.length - 1, MOMENTUM_BREAK_VARIANTS.find((v) => v.id === 'R1.5-V2.0')!).failed).toBe('VOLUME_TOO_LOW');
  });
});

describe('momentum-break levels — every kind, from bars before i only', () => {
  const bars = [...history(), bearishTrigger()];
  const series = prepareMomentumSeries(bars);
  const i = bars.length - 1;
  const levels = buildMomentumLevels(series, i);
  const byKind = Object.fromEntries(levels.map((l) => [l.kind, l.price]));

  it('builds each level type', () => {
    for (const kind of ['OPENING_RANGE_HIGH', 'OPENING_RANGE_LOW', 'DAY_HIGH', 'DAY_LOW', 'PREV_DAY_HIGH', 'PREV_DAY_LOW', 'VWAP', 'PIVOT_R1', 'PIVOT_S1']) {
      expect(byKind, kind).toHaveProperty(kind);
    }
    expect(byKind.DAY_LOW).toBeCloseTo(99.8, 5);
    expect(byKind.DAY_HIGH).toBeCloseTo(100.7, 5);
    expect(byKind.PREV_DAY_LOW).toBeCloseTo(96.8, 5);
    expect(byKind.PREV_DAY_HIGH).toBeCloseTo(100.2, 5);
    // classic pivot from the previous session
    const pp = (100.2 + 96.8 + 100) / 3;
    expect(byKind.PIVOT_S1).toBeCloseTo(2 * pp - 100.2, 5);
    expect(byKind.PIVOT_R1).toBeCloseTo(2 * pp - 96.8, 5);
  });

  it("today's high/low and VWAP exclude the decision bar itself", () => {
    // The trigger bar's low (99.1) is not the day low it is judged against.
    expect(byKind.DAY_LOW).toBeGreaterThan(99.1);
  });

  it('the opening range exists only once its 30 minutes have closed', () => {
    const at0945 = bars.findIndex((b) => b.time === at(TODAY, '09:45'));
    const at0930 = bars.findIndex((b) => b.time === at(TODAY, '09:30'));
    expect(buildMomentumLevels(series, at0945).some((l) => l.kind === 'OPENING_RANGE_HIGH')).toBe(true);
    expect(buildMomentumLevels(series, at0930).some((l) => l.kind === 'OPENING_RANGE_HIGH')).toBe(false);
  });

  it('swing levels are confirmed fractals only (need 2 bars after)', () => {
    const b = history();
    // A clean 5-bar fractal high at 101 three bars before the end of today.
    const n = b.length;
    b[n - 3] = { ...b[n - 3], high: 101 };
    const s2 = prepareMomentumSeries(b);
    const confirmed = buildMomentumLevels(s2, n).find((l) => l.kind === 'SWING_HIGH');
    expect(confirmed?.price).toBe(101);
    // Evaluated one bar earlier the fractal has only one bar after it — not confirmed.
    expect(buildMomentumLevels(s2, n - 1).find((l) => l.kind === 'SWING_HIGH')?.price).not.toBe(101);
  });

  it('the volume baseline is the same-slot median over previous sessions, never today', () => {
    const base = slotVolumeBaseline(series, i);
    expect(base.median).toBe(1000);
    expect(base.samples).toBe(10);
  });
});

describe('NO LOOK-AHEAD', () => {
  const base = [...history(), bearishTrigger()];
  const i = base.length - 1;
  const expected = evalAt(base, i);

  it('appending future bars never changes the decision at t', () => {
    for (const future of [after(8, 99.2, -0.5), after(8, 99.2, +0.5), after(30, 99.2, 0.1)]) {
      const extended = evalAt([...base, ...future], i);
      expect(extended).toEqual(expected);
    }
    // Including a future bar that would itself be a much bigger trigger.
    const wild = [...base, { time: triggerTime + BAR, open: 99.2, high: 99.3, low: 90, close: 90.1, volume: 99999 }];
    expect(evalAt(wild, i)).toEqual(expected);
  });

  it('levels at t are unchanged by anything at or after t', () => {
    const series = prepareMomentumSeries(base);
    const mutated = prepareMomentumSeries([...base.slice(0, i), bearishTrigger({ low: 50, high: 150, close: 60, volume: 1 }), ...after(5, 60, 1)]);
    expect(buildMomentumLevels(mutated, i)).toEqual(buildMomentumLevels(series, i));
  });

  it('the live closed-bar filter drops the still-forming bar', () => {
    const bars = [...base, bar(triggerTime + BAR, 99.2, 99.0)];
    expect(closedBarsAt(bars, triggerTime + BAR + 7 * 60000)).toHaveLength(base.length);
    expect(closedBarsAt(bars, triggerTime + 2 * BAR)).toHaveLength(base.length + 1);
  });

  it('the regime assist finds a recent trigger until the level is reclaimed', () => {
    const bars = [...base, ...after(2, 99.2, -0.1)];
    const series = prepareMomentumSeries(bars);
    expect(recentMomentumBreak(series, bars.length - 1, 4, VARIANT)?.barsAgo).toBe(2);
    const reclaimed = [...base, bar(triggerTime + BAR, 99.2, 100)];
    expect(recentMomentumBreak(prepareMomentumSeries(reclaimed), reclaimed.length - 1, 4, VARIANT)).toBeNull();
  });
});

// ---------------- gradePath ----------------

/** The loop exactly as it stood inline in missed-winner-audit.ts gradeDecision before the extraction. */
function legacyGrade(entry: number, atr: number, direction: number, stopAtr: number, targetAtr: number, candles: GradeBar[]) {
  const stopLevel = entry - direction * stopAtr * atr;
  const targetLevel = entry + direction * targetAtr * atr;
  let mfe = 0;
  let mae = 0;
  let hitTarget = false;
  let hitStop = false;
  let settledR: number | null = null;
  let barsToMfe: number | null = null;
  let barsToTarget: number | null = null;
  let barIndex = 0;
  for (const c of candles) {
    barIndex++;
    const favourable = direction > 0 ? c.high - entry : entry - c.low;
    const adverse = direction > 0 ? entry - c.low : c.high - entry;
    if (favourable > mfe) { mfe = favourable; barsToMfe = barIndex; }
    if (adverse > mae) mae = adverse;
    const stopped = direction > 0 ? c.low <= stopLevel : c.high >= stopLevel;
    const targeted = direction > 0 ? c.high >= targetLevel : c.low <= targetLevel;
    if (stopped) { hitStop = true; settledR = -1; break; }
    if (targeted) { hitTarget = true; settledR = targetAtr / stopAtr; barsToTarget = barIndex; break; }
  }
  const mfeAtr = mfe / atr;
  const maeAtr = mae / atr;
  const riskPoints = stopAtr * atr;
  const mfeR = riskPoints > 0 ? mfe / riskPoints : 0;
  if (settledR == null) {
    const last = candles[candles.length - 1];
    const finalMove = direction > 0 ? last.close - entry : entry - last.close;
    settledR = riskPoints > 0 ? finalMove / riskPoints : 0;
  }
  return { hitStop, hitTarget, settledR, mfeAtr, maeAtr, mfeR, barsToMfe, barsToTarget };
}

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('gradePath extraction leaves gradeDecision unchanged', () => {
  it('matches the legacy inline loop exactly on 2,000 random paths', () => {
    const r = rng(42);
    for (let n = 0; n < 2000; n++) {
      const entry = 100 + r() * 50;
      const atr = 0.5 + r() * 3;
      const direction = r() < 0.5 ? 1 : -1;
      const stopAtr = [1, 1.5, 2, 2.37][Math.floor(r() * 4)];
      const targetAtr = [1.5, 3, 4.1][Math.floor(r() * 3)];
      let p = entry;
      const candles: GradeBar[] = Array.from({ length: 1 + Math.floor(r() * 40) }, () => {
        const o = p;
        p = p + (r() - 0.5) * atr * 2;
        return { high: Math.max(o, p) + r() * atr, low: Math.min(o, p) - r() * atr, close: p };
      });
      expect(gradeThesis({ entry, atr, direction: direction as 1 | -1, stopAtr, targetAtr, candles })).toEqual(legacyGrade(entry, atr, direction, stopAtr, targetAtr, candles));
    }
  });

  it('the stop wins a bar that spans both levels', () => {
    const g = gradePath([{ high: 112, low: 88, close: 100 }], 1, 100, 95, 110);
    expect(g.hitStop).toBe(true);
    expect(g.hitTarget).toBe(false);
    expect(g.settledR).toBe(-1);
  });

  it('target R is the target distance over the stop distance; an invalidating close exits at that close', () => {
    expect(gradePath([{ high: 101, low: 99.5, close: 100.5 }, { high: 111, low: 100, close: 110 }], 1, 100, 98, 106).settledR).toBe(3);
    const inv = gradePath([{ high: 101, low: 99, close: 99.4 }], 1, 100, 98, 106, { invalidateOnClose: (b) => b.close < 99.5 });
    expect(inv.invalidated).toBe(true);
    expect(inv.exitPrice).toBe(99.4);
    expect(inv.settledR).toBeCloseTo(-0.3, 10);
  });
});

// ---------------- backtest harness pieces ----------------

describe('roll masking', () => {
  function mcxDay(date: string, open: number, closes: number[], volume: number): MomentumBar[] {
    let prev = open;
    return closes.map((c, k) => {
      const b = { time: at(date, '09:00') + k * BAR, open: prev, high: Math.max(prev, c) + 1, low: Math.min(prev, c) - 1, close: c, volume };
      prev = c;
      return b;
    });
  }
  const flat = (p: number) => Array.from({ length: 40 }, (_, k) => p + (k % 2));
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];

  it('a volume hand-over with a > 3 ATR gap masks that session and the next; the rest trade', () => {
    const bars = [
      ...mcxDay(days[0], 5000, flat(5000), 1000),
      ...mcxDay(days[1], 5001, flat(5000), 300), // expiring contract drains
      ...mcxDay(days[2], 5300, flat(5300), 2000), // new contract: 6.7x volume, +299 gap
      ...mcxDay(days[3], 5301, flat(5300), 1800),
      ...mcxDay(days[4], 5301, flat(5300), 1800),
    ];
    const { masked, rolls } = sessionMasks(prepareMomentumSeries(bars), true);
    expect(rolls.map((r) => r.date)).toEqual([days[2]]);
    expect(masked.get(days[2])).toBe('ROLL');
    expect(masked.get(days[3])).toBe('AFTER_ROLL');
    expect(masked.has(days[4])).toBe(false);
  });

  it('a hand-over with a small gap is recorded but not masked; index series are never roll-masked', () => {
    const bars = [
      ...mcxDay(days[0], 5000, flat(5000), 1000),
      ...mcxDay(days[1], 5001, flat(5000), 300),
      ...mcxDay(days[2], 5002, flat(5000), 2000),
    ];
    const futures = sessionMasks(prepareMomentumSeries(bars), true);
    expect(futures.rolls[0].masked).toBe(false);
    expect(futures.masked.size).toBe(0);
    expect(sessionMasks(prepareMomentumSeries(bars), false).rolls).toHaveLength(0);
  });

  it('thin sessions (< half the median bar count) take no entries', () => {
    const bars = [...mcxDay(days[0], 5000, flat(5000), 1000), ...mcxDay(days[1], 5000, flat(5000).slice(0, 10), 1000), ...mcxDay(days[2], 5000, flat(5000), 1000)];
    expect(sessionMasks(prepareMomentumSeries(bars), false).masked.get(days[1])).toBe('THIN');
  });

  it('index spot borrows the future volume bar for bar', () => {
    const price = [bar(1, 1, 2, 0), bar(2, 2, 3, 0)];
    expect(borrowVolume(price, [bar(2, 0, 0, 77)]).map((b) => b.volume)).toEqual([0, 77]);
  });
});

describe('go-live bar and variant choice (pre-registered)', () => {
  const t = (netR: number, symbol = 'X', k = 0): BacktestTrade =>
    ({ symbol, date: '2026-01-01', decidedAt: new Date(k * 1000).toISOString(), hour: 10, signal: {} as never, exit: 'TARGET', exitPrice: 0, exitAt: '', grossR: netR + 0.1, netR });

  it('needs >= 30 trades, avg net R >= +0.10 and PF >= 1.2 together', () => {
    const passing = [...Array.from({ length: 12 }, (_, k) => t(1.5, 'X', k)), ...Array.from({ length: 18 }, (_, k) => t(-0.8, 'X', 100 + k))];
    const s = statsOf(passing);
    expect(s.trades).toBe(30);
    expect(passesGoLiveBar(s)).toBe(s.avgNetR! >= 0.1 && s.profitFactor! >= 1.2);
    expect(passesGoLiveBar(statsOf(passing.slice(0, 29)))).toBe(false);
    expect(passesGoLiveBar(statsOf(Array.from({ length: 40 }, (_, k) => t(k % 2 ? 1 : -1, 'X', k))))).toBe(false);
  });

  it('max drawdown is peak-to-trough on cumulative net R', () => {
    expect(statsOf([t(2, 'X', 1), t(-1, 'X', 2), t(-1.5, 'X', 3), t(1, 'X', 4)]).maxDrawdownR).toBe(2.5);
  });

  it('symbols with < 10 OOS trades or a negative OOS average are left off', () => {
    const group = (key: string, trades: number, avg: number) => ({ key, stats: { trades, avgNetR: avg, winRate: 0, totalNetR: 0, profitFactor: 1, maxDrawdownR: 0 } });
    expect(allowedSymbols([group('A', 12, 0.2), group('B', 9, 0.5), group('C', 20, -0.01), group('D', 10, 0)])).toEqual(['A', 'D']);
  });

  it('variant choice is highest in-sample average net R, first-registered on ties; split is chronological ⅔', () => {
    const v = MOMENTUM_BREAK_VARIANTS;
    const stats = (avg: number) => ({ trades: 10, avgNetR: avg, winRate: 0, totalNetR: 0, profitFactor: 1, maxDrawdownR: 0 });
    expect(chooseVariant([{ variant: v[0], stats: stats(-0.1) }, { variant: v[1], stats: stats(0.05) }, { variant: v[2], stats: stats(0.05) }]).id).toBe(v[1].id);
    expect(splitDate(['2026-01-03', '2026-01-01', '2026-01-02'])).toBe('2026-01-03');
  });
});
