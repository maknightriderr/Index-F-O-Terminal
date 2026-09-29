// ============================================================
// STRUCTURE ENGINE — pools, sweeps, displacement, zone, lifecycle, look-ahead
// ============================================================
// Every bar is a FABRICATED fixture. Flat history sessions give a known ATR
// (~0.7); the previous session runs 100 → 97.2 → 101.8, so PDL = 97.0 and
// PDH = 102.0. Today opens around 101.0-101.3 and the scenario bars are laid
// on top. The bullish cases mirror the bearish ones (p → 200 − p).
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  buildLiquidityPools,
  evaluateStructureSession,
  momentumAtrAt,
  prepareMomentumSeries,
  scoreStructureSetup,
  STRUCTURE_VARIANTS,
  type MomentumBar,
  type StructureSetup,
} from '@fno/analytics';

const V10 = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-GUARD')!;
const V15 = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.5-GUARD')!;
const BAR = 15 * 60 * 1000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

function bar(time: number, open: number, close: number, wick = 0.2, volume = 1000): MomentumBar {
  return { time, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume };
}
function session(date: string, closes: number[], startOpen: number): MomentumBar[] {
  let prev = startOpen;
  return closes.map((c, k) => {
    const b = bar(at(date, '09:15') + k * BAR, prev, c);
    prev = c;
    return b;
  });
}
const alternating = (n: number, a = 100, b = 100.5) => Array.from({ length: n }, (_, k) => (k % 2 === 0 ? a : b));
const HIST = ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16'];
const PREV = '2026-01-19';
const TODAY = '2026-01-20';
const PREV_CLOSES = [100, 99.5, 99, 98.5, 98, 97.5, 97.2, 97.5, 98, 98.5, 99, 99.5, 100, 100.5, 101, 101.5, 101.8, 101.5, 101.2, 101.0, 101.2, 101.0, 101.2, 101.0, 101.2];

/** History + the previous session + today's first six bars (09:15-10:30). */
function base(): MomentumBar[] {
  const bars: MomentumBar[] = [];
  let last = 100.5;
  for (const d of HIST) {
    bars.push(...session(d, alternating(25), last));
    last = bars[bars.length - 1].close;
  }
  bars.push(...session(PREV, PREV_CLOSES, last));
  last = bars[bars.length - 1].close;
  bars.push(...session(TODAY, [101.3, 101.0, 101.3, 101.0, 101.3, 101.0], last));
  return bars;
}
const t = (k: number) => at(TODAY, '10:45') + k * BAR; // k = 0 is the sweep bar
const B = (k: number, open: number, high: number, low: number, close: number, volume = 1000): MomentumBar => ({ time: t(k), open, high, low, close, volume });

// The canonical bearish setup: PDH (102.0) swept at 10:45, displacement at 11:00, FVG confirmed at 11:15.
const SWEEP = B(0, 101.0, 102.3, 100.9, 101.6);
const DISP = B(1, 101.6, 101.7, 100.1, 100.2);
const CONF = B(2, 100.2, 100.6, 99.9, 100.3);
const FILL = B(3, 100.3, 100.8, 100.2, 100.4);
const run = (bars: MomentumBar[], i = bars.length - 1, variant = V10) => evaluateStructureSession(prepareMomentumSeries(bars), i, variant);
const only = (setups: StructureSetup[], dir: 'BEARISH' | 'BULLISH') => setups.filter((s) => s.direction === dir);

const mirror = (b: MomentumBar): MomentumBar => ({ time: b.time, open: 200 - b.open, close: 200 - b.close, high: 200 - b.low, low: 200 - b.high, volume: b.volume });

describe('liquidity pools', () => {
  it('ranks previous-day, session, opening-range and fractal pools; merges near-duplicates into the better rank', () => {
    const bars = base();
    const series = prepareMomentumSeries(bars);
    const s = series.sessionIdx[bars.length - 1];
    const atr = momentumAtrAt(series, bars.length)!;
    expect(atr).toBeGreaterThan(0.5);
    expect(atr).toBeLessThan(1);
    const pools = buildLiquidityPools(series, s, bars.length, atr);
    const pdh = pools.find((p) => p.kind === 'PREV_DAY_HIGH');
    const pdl = pools.find((p) => p.kind === 'PREV_DAY_LOW');
    expect(pdh).toMatchObject({ price: 102, rank: 1, side: 'HIGH' });
    expect(pdl).toMatchObject({ price: 97, rank: 1, side: 'LOW' });
    // Session high 101.5 and the opening-range high 101.5 are the same level: the session (rank 3) wins.
    expect(pools.filter((p) => p.side === 'HIGH' && Math.abs(p.price - 101.5) < 0.05).map((p) => p.kind)).toEqual(['SESSION_HIGH']);
  });

  it('a pool already traded through is marked taken and dropped', () => {
    const bars = [...base(), B(0, 101.0, 102.3, 100.9, 102.2)]; // closes above PDH: a break, not a sweep
    const series = prepareMomentumSeries(bars);
    const s = series.sessionIdx[bars.length - 1];
    const pools = buildLiquidityPools(series, s, bars.length, 0.7);
    expect(pools.find((p) => p.kind === 'PREV_DAY_HIGH')).toBeUndefined();
    expect(pools.find((p) => p.kind === 'PREV_DAY_LOW')).toBeDefined();
  });

  it('two confirmed swings within 0.1 ATR are one EQUAL_HIGHS pool (rank 2)', () => {
    const bars = [
      ...base(),
      B(0, 101.0, 101.3, 100.95, 101.2),
      B(1, 101.2, 101.75, 101.1, 101.3), // swing high
      B(2, 101.3, 101.4, 101.0, 101.1),
      B(3, 101.1, 101.3, 100.9, 101.0),
      B(4, 101.0, 101.4, 100.95, 101.2),
      B(5, 101.2, 101.76, 101.1, 101.3), // equal swing high, a hair above
      B(6, 101.3, 101.4, 101.0, 101.1),
      B(7, 101.1, 101.3, 100.95, 101.0),
    ];
    const series = prepareMomentumSeries(bars);
    const s = series.sessionIdx[bars.length - 1];
    const pools = buildLiquidityPools(series, s, bars.length, 0.7);
    const eq = pools.find((p) => p.kind === 'EQUAL_HIGHS');
    expect(eq).toMatchObject({ rank: 2, side: 'HIGH' });
    expect(eq!.price).toBeCloseTo(101.76, 2);
    // It outranks the session high at the same price.
    expect(pools.find((p) => p.kind === 'SESSION_HIGH')).toBeUndefined();
  });
});

describe('sweep → displacement → zone → fill → T1 (bearish)', () => {
  it('1-bar sweep of PDH is DEVELOPING', () => {
    const ev = run([...base(), SWEEP]);
    const [st] = only(ev.setups, 'BEARISH');
    expect(st.stage).toBe('DEVELOPING');
    expect(st.pool.kind).toBe('PREV_DAY_HIGH');
    expect(st.sweep).toMatchObject({ bars: 1, extreme: 102.3 });
  });

  it('2-bar sweep: the break closes beyond, the next bar closes back inside', () => {
    const ev = run([...base(), B(0, 101.0, 102.25, 100.9, 102.1), B(1, 102.1, 102.3, 101.4, 101.5)]);
    const [st] = only(ev.setups, 'BEARISH');
    expect(st.sweep).toMatchObject({ bars: 2, extreme: 102.3 });
    expect(st.pool.kind).toBe('PREV_DAY_HIGH');
  });

  it('displacement then the gap bar → CONFIRMED with an FVG zone, a stop beyond the extreme and T1 = PDL', () => {
    const ev = run([...base(), SWEEP, DISP, CONF]);
    const [st] = only(ev.setups, 'BEARISH');
    expect(st.stage).toBe('CONFIRMED');
    expect(st.displacement).toMatchObject({ bodyAtr: expect.any(Number) });
    expect(st.zone).toEqual({ kind: 'FVG', near: 100.6, far: 100.9 });
    expect(st.entry).toBe(100.6);
    expect(st.stop!).toBeGreaterThan(102.3);
    expect(st.t1).toEqual({ kind: 'PREV_DAY_LOW', price: 97 });
    expect(st.rToT1!).toBeGreaterThanOrEqual(1.5);
    expect(st.score!.tier1.poolRank).toBe(15);
    expect(st.score!.tier1.fvg).toBe(10);
    expect(st.history.map((h) => h.stage)).toEqual(['DEVELOPING', 'CONFIRMED']);
  });

  it('the limit fills on the retrace (ENTRY), then ACTIVE, then T1', () => {
    const down = [B(4, 100.4, 100.5, 99.0, 99.1), B(5, 99.1, 99.2, 97.8, 97.9), B(6, 97.9, 98.0, 96.9, 97.1)];
    const ev = run([...base(), SWEEP, DISP, CONF, FILL, ...down]);
    const [st] = only(ev.setups, 'BEARISH');
    expect(st.fill).toMatchObject({ price: 100.6 });
    expect(st.exit).toMatchObject({ kind: 'T1', price: 97 });
    expect(st.history.map((h) => h.stage)).toEqual(['DEVELOPING', 'CONFIRMED', 'ENTRY', 'ACTIVE', 'CLOSED']);
  });

  it('conservative fill: a fill bar that also reaches the stop is a loss', () => {
    const ev = run([...base(), SWEEP, DISP, CONF, B(3, 100.3, 102.5, 100.2, 101.0)]);
    const [st] = only(ev.setups, 'BEARISH');
    expect(st.exit?.kind).toBe('STOP');
    expect(st.exit?.index).toBe(st.fill?.index);
  });

  it('the displacement threshold is the variant: 1.0 × ATR passes, 1.5 × ATR does not', () => {
    // Body 0.9 ≈ 1.2 ATR.
    const disp = B(1, 101.6, 101.7, 100.6, 100.7);
    const conf = B(2, 100.7, 100.75, 100.3, 100.5);
    const ok = only(run([...base(), SWEEP, disp, conf], undefined, V10).setups, 'BEARISH')[0];
    expect(ok.displacement).not.toBeNull();
    const no = run([...base(), SWEEP, disp, conf, B(3, 100.5, 100.6, 100.4, 100.5)], undefined, V15);
    expect(only(no.setups, 'BEARISH')[0]).toMatchObject({ stage: 'INVALIDATED', invalidReason: 'NO_DISPLACEMENT' });
  });

  it('no gap → the displacement candle 50% level is the zone', () => {
    const conf = B(2, 100.2, 101.3, 100.0, 100.3); // high 101.3 fills the gap (S.low 100.9)
    const ev = run([...base(), SWEEP, DISP, conf]);
    const [st] = only(ev.setups, 'BEARISH');
    // The 50% level (100.9) was already traded by the confirming bar → mitigated.
    expect(st).toMatchObject({ stage: 'INVALIDATED', invalidReason: 'ZONE_TRADED_THROUGH' });
    expect(st.zone).toEqual({ kind: 'DISP_50', near: 100.9, far: 100.9 });
  });
});

describe('lifecycle endings', () => {
  it('SWEEP_RECLAIMED: a close back beyond the sweep extreme before displacement', () => {
    const ev = run([...base(), SWEEP, B(1, 101.6, 102.6, 101.5, 102.4)]);
    expect(only(ev.setups, 'BEARISH')[0]).toMatchObject({ stage: 'INVALIDATED', invalidReason: 'SWEEP_RECLAIMED' });
  });

  it('LATE: price already more than 1R toward T1 when it confirmed', () => {
    const conf = B(2, 100.2, 100.3, 98.0, 98.1);
    const ev = run([...base(), SWEEP, DISP, conf]);
    const [st] = only(ev.setups, 'BEARISH');
    expect(st.stage).toBe('LATE');
    expect(st.late).toBe(true);
  });

  it('MISSED: T1 reached before the limit filled', () => {
    const down = [B(3, 100.3, 100.4, 99.0, 99.1), B(4, 99.1, 99.2, 96.8, 97.0)];
    const ev = run([...base(), SWEEP, DISP, CONF, ...down]);
    expect(only(ev.setups, 'BEARISH')[0].stage).toBe('MISSED');
  });

  it('NO_FILL: no retrace within 8 bars', () => {
    const drift = Array.from({ length: 8 }, (_, k) => B(3 + k, 100.3 - 0.05 * k, 100.35 - 0.05 * k, 100.0 - 0.05 * k, 100.25 - 0.05 * k));
    const ev = run([...base(), SWEEP, DISP, CONF, ...drift]);
    expect(only(ev.setups, 'BEARISH')[0]).toMatchObject({ stage: 'INVALIDATED', invalidReason: 'NO_FILL' });
  });

  it('LOW_RR: an opposite pool closer than 1.5R', () => {
    // A previous-day low at 99.8 (not 97.0) sits only ~0.4R below the entry.
    const bars = base().map((b) => (b.low < 99.8 && b.time < at(TODAY, '09:15') && b.time >= at(PREV, '09:15') ? { ...b, low: 99.8, close: Math.max(b.close, 99.9), open: Math.max(b.open, 99.9) } : b));
    const ev = run([...bars, SWEEP, DISP, CONF]);
    expect(only(ev.setups, 'BEARISH')[0].stage).toBe('LOW_RR');
  });

  it('WATCH: price within 0.5 ATR of an untaken pool, with no lifecycle running', () => {
    const ev = run([...base(), B(0, 101.0, 101.8, 100.9, 101.75)]);
    expect(ev.watch.BEARISH?.kind).toBe('PREV_DAY_HIGH');
    expect(ev.watch.BULLISH).toBeNull();
  });

  it('bullish mirrors bearish', () => {
    const bars = [...base(), SWEEP, DISP, CONF, FILL].map(mirror);
    const ev = run(bars);
    const [st] = only(ev.setups, 'BULLISH');
    expect(st.pool.kind).toBe('PREV_DAY_LOW');
    expect(st.entry).toBe(99.4);
    expect(st.fill).not.toBeNull();
  });
});

describe('no look-ahead', () => {
  const full = [...base(), SWEEP, DISP, CONF, FILL, B(4, 100.4, 100.5, 99.0, 99.1), B(5, 99.1, 99.2, 97.8, 97.9), B(6, 97.9, 98.0, 96.9, 97.1)];
  it('the state at every bar is the same whether or not later bars exist', () => {
    const series = prepareMomentumSeries(full);
    const todayStart = full.findIndex((b) => b.time >= at(TODAY, '09:15'));
    for (let i = todayStart; i < full.length; i++) {
      const withFuture = evaluateStructureSession(series, i, V10);
      const truncated = evaluateStructureSession(prepareMomentumSeries(full.slice(0, i + 1)), i, V10);
      expect(withFuture).toEqual(truncated);
    }
  });
  it('appending arbitrary future bars never changes the state at t', () => {
    const i = full.length - 4; // just after the fill
    const before = evaluateStructureSession(prepareMomentumSeries(full.slice(0, i + 1)), i, V10);
    const futures = [
      [B(10, 99, 110, 90, 105), B(11, 105, 106, 80, 81)],
      Array.from({ length: 30 }, (_, k) => B(10 + k, 100, 100 + k, 100 - k, 100)),
    ];
    for (const extra of futures) {
      const after = evaluateStructureSession(prepareMomentumSeries([...full.slice(0, i + 1), ...extra]), i, V10);
      expect(after).toEqual(before);
    }
  });
});

describe('score', () => {
  it('tier 1 is bounded at 60; live tiers add ±25 and ±15; the total is clamped to 0-100', () => {
    const s = { pool: { kind: 'PREV_DAY_HIGH', side: 'HIGH', price: 1, rank: 1 }, sweep: { index: 0, barTime: 0, bars: 1, extreme: 2, depthAtr: 5 }, displacement: { index: 1, barTime: 0, bodyAtr: 9, closeLocation: 0, structureShift: true, volMult: 2 }, zone: { kind: 'FVG', near: 1, far: 2 } } as const;
    const top = scoreStructureSetup(s as any, 1, { positioning: 'AGREE', oiWallInPath: false, regimeAlignment: 'WITH' });
    expect(top.tier1.sum).toBe(60);
    expect(top.total).toBe(100);
    const bottom = scoreStructureSetup({ ...s, pool: { ...s.pool, rank: 5 }, displacement: { ...s.displacement, structureShift: false, bodyAtr: 1, volMult: 0.5 }, zone: { kind: 'DISP_50', near: 1, far: 1 }, sweep: { ...s.sweep, depthAtr: 0.1 } } as any, 1, { positioning: 'CONTRADICT', oiWallInPath: true, regimeAlignment: 'AGAINST' });
    expect(bottom.total).toBe(0);
  });
});
