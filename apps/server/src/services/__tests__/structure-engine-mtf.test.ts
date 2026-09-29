// ============================================================
// STRUCTURE ENGINE — multi-timeframe (15m pools, 5m events)
// ============================================================
// Every bar is a FABRICATED fixture. The 5m series is laid out bar by bar;
// the 15m series is its exact aggregation (three 5m bars per 15m bar), so the
// only difference between the two is when a 15m bar's information becomes
// available — which is what these tests are about.
//
// History: five flat sessions (alternating 100 / 100.5) give a known ATR; the
// previous session injects a 97.0 low and a 102.0 high (PDL / PDH). Today
// opens alternating 101.0 / 101.3; the scenario starts at 10:45.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  buildLiquidityPools,
  buildMtfPools,
  closedBarCount,
  evaluateStructureSession,
  evaluateStructureSessionMTF,
  momentumAtrAt,
  prepareMomentumSeries,
  STRUCTURE_5M_VARIANTS,
  STRUCTURE_BAR_MS_15M,
  STRUCTURE_BAR_MS_5M,
  STRUCTURE_RULES,
  STRUCTURE_RULES_5M,
  STRUCTURE_VARIANTS,
  type MomentumBar,
  type StructureSetup,
} from '@fno/analytics';

const M5 = STRUCTURE_BAR_MS_5M;
const M15 = STRUCTURE_BAR_MS_15M;
const V = STRUCTURE_5M_VARIANTS[0]; // 5m-D1.0-C60
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

function bar(time: number, open: number, close: number, wick = 0.2): MomentumBar {
  return { time, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 1000 };
}
/** A 75-bar 5m session (09:15-15:30) from alternating closes. */
function session5(date: string, a: number, b: number, n = 75): MomentumBar[] {
  let prev = b;
  return Array.from({ length: n }, (_, k) => {
    const c = k % 2 === 0 ? a : b;
    const x = bar(at(date, '09:15') + k * M5, prev, c);
    prev = c;
    return x;
  });
}
/** Aggregate 5m bars into 15m bars (open-time aligned). */
function to15(bars5: MomentumBar[]): MomentumBar[] {
  const out: MomentumBar[] = [];
  for (const b of bars5) {
    const t = Math.floor(b.time / M15) * M15;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

const HIST = ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16'];
const PREV = '2026-01-19';
const TODAY = '2026-01-20';

function base5(): MomentumBar[] {
  const bars: MomentumBar[] = [];
  for (const d of HIST) bars.push(...session5(d, 100, 100.5));
  const prev = session5(PREV, 100, 100.5);
  prev[10] = { ...prev[10], low: 97.0 };
  prev[50] = { ...prev[50], high: 102.0 };
  bars.push(...prev);
  // Today 09:15 → 10:40 (18 bars), alternating 101.0 / 101.3.
  bars.push(...session5(TODAY, 101.0, 101.3, 18));
  return bars;
}
const t5 = (k: number) => at(TODAY, '10:45') + k * M5; // k = 0 is the sweep bar
const B = (k: number, open: number, high: number, low: number, close: number): MomentumBar => ({ time: t5(k), open, high, low, close, volume: 1000 });

// The canonical bearish setup on 5m: PDH (102.0) swept at 10:45, displacement 10:50, FVG confirmed 10:55.
const SWEEP = B(0, 101.0, 102.3, 100.9, 101.6);
const DISP = B(1, 101.6, 101.7, 100.1, 100.2);
const CONF = B(2, 100.2, 100.6, 99.9, 100.3);
const FILL = B(3, 100.3, 100.8, 100.2, 100.4);

function run(bars5: MomentumBar[], i = bars5.length - 1, variant = V, bars15 = to15(bars5)) {
  return evaluateStructureSessionMTF(prepareMomentumSeries(bars15), prepareMomentumSeries(bars5), i, variant);
}
const bear = (setups: StructureSetup[]) => setups.filter((s) => s.direction === 'BEARISH');

describe('5m → 15m bar mapping', () => {
  const bars5 = base5();
  const s15 = prepareMomentumSeries(to15(bars5));
  it('a 15m bar counts only once it has closed by the 5m bar\'s close', () => {
    // 5m bar 10:00-10:05 (close 10:05): the 09:45 15m bar (close 10:00) is in, the 10:00 one is not.
    const c1 = closedBarCount(s15, at(TODAY, '10:05'), M15);
    expect(s15.bars[c1 - 1].time).toBe(at(TODAY, '09:45'));
    // 5m bar 10:10-10:15 (close 10:15): now the 10:00 15m bar has closed.
    const c2 = closedBarCount(s15, at(TODAY, '10:15'), M15);
    expect(s15.bars[c2 - 1].time).toBe(at(TODAY, '10:00'));
    expect(c2).toBe(c1 + 1);
  });

  it('no pool from a 15m bar that has not closed: SESSION_HIGH appears only after 09:30', () => {
    const today0 = bars5.findIndex((b) => b.time === at(TODAY, '09:15'));
    // After the 09:15 and 09:20 5m bars (closes 09:20, 09:25) no 15m bar of today has closed.
    for (const i of [today0, today0 + 1]) {
      const ev = run(bars5, i);
      expect(ev.pools.find((p) => p.kind === 'SESSION_HIGH')).toBeUndefined();
      expect(ev.pools.find((p) => p.kind === 'PREV_DAY_HIGH')).toMatchObject({ price: 102 });
    }
    // After the 09:25 5m bar (close 09:30) the 09:15 15m bar has closed.
    expect(run(bars5, today0 + 2).pools.find((p) => p.kind === 'SESSION_HIGH')).toBeDefined();
  });

  it('a still-forming 15m bar in the 15m series (the live partial bar) never contributes a pool', () => {
    const i = bars5.length - 1; // 10:40-10:45 bar, close 10:45
    const clean = run(bars5, i);
    // A forming 10:45 15m bar with an absurd high/low, as the broker returns mid-bar.
    const forming = [...to15(bars5), { time: at(TODAY, '10:45'), open: 101, high: 150, low: 50, close: 101, volume: 1 }];
    expect(run(bars5, i, V, forming)).toEqual(clean);
  });
});

describe('pools taken by intrabar 5m highs and lows', () => {
  it('a 5m bar through PDH marks it taken before its 15m bar closes', () => {
    // 10:45 5m bar trades to 102.1 and closes at 101.9 (inside the forming 10:45-11:00 15m bar).
    const bars5 = [...base5(), B(0, 101.0, 102.1, 100.9, 101.9)];
    const i = bars5.length - 1;
    const ev = run(bars5, i);
    expect(ev.pools.find((p) => p.kind === 'PREV_DAY_HIGH')).toBeUndefined();
    expect(ev.pools.find((p) => p.kind === 'PREV_DAY_LOW')).toMatchObject({ price: 97 });
    // The 15m-only read at the same instant still shows PDH untaken (the gap the 5m scan closes).
    const s15 = prepareMomentumSeries(to15(bars5));
    const n15 = closedBarCount(s15, bars5[i].time + M5, M15);
    const pools15 = buildLiquidityPools(s15, s15.sessionIdx[n15 - 1], n15, momentumAtrAt(s15, n15)!);
    expect(pools15.find((p) => p.kind === 'PREV_DAY_HIGH')).toMatchObject({ price: 102 });
  });

  it('buildMtfPools uses the 15m ATR for merging, and the scan is limited to bars after the last closed 15m bar', () => {
    const bars5 = base5();
    const s5 = prepareMomentumSeries(bars5);
    const s15 = prepareMomentumSeries(to15(bars5));
    const built = buildMtfPools(s15, s5, bars5.length)!;
    const n15 = closedBarCount(s15, bars5[bars5.length - 1].time + M5, M15);
    expect(built.atr15).toBeCloseTo(momentumAtrAt(s15, n15)!, 10);
    expect(built.pools.find((p) => p.kind === 'PREV_DAY_HIGH')).toMatchObject({ price: 102 });
  });
});

describe('sweep → displacement → zone → fill → T1 on 5m', () => {
  it('confirms with an FVG zone from 5m bars, a stop off the 5m ATR and T1 = the 15m PDL', () => {
    const ev = run([...base5(), SWEEP, DISP, CONF]);
    const [st] = bear(ev.setups);
    expect(st.pool).toMatchObject({ kind: 'PREV_DAY_HIGH', price: 102 });
    expect(st.stage).toBe('CONFIRMED');
    expect(st.zone).toEqual({ kind: 'FVG', near: 100.6, far: 100.9 });
    expect(st.entry).toBe(100.6);
    const atr5 = momentumAtrAt(prepareMomentumSeries([...base5(), SWEEP]), base5().length)!;
    expect(st.atr).toBeCloseTo(atr5, 10);
    expect(st.stop).toBeCloseTo(102.3 + STRUCTURE_RULES_5M.stopBufferAtr * atr5, 2);
    expect(st.t1).toEqual({ kind: 'PREV_DAY_LOW', price: 97 });
    // Transitions happen at 5m bar closes.
    expect(st.history.map((h) => h.at)).toEqual([t5(0) + M5, t5(2) + M5]);
  });

  it('the limit fills, then T1', () => {
    const down = [B(4, 100.4, 100.5, 99.0, 99.1), B(5, 99.1, 99.2, 97.8, 97.9), B(6, 97.9, 98.0, 96.9, 97.1)];
    const [st] = bear(run([...base5(), SWEEP, DISP, CONF, FILL, ...down]).setups);
    expect(st.fill).toMatchObject({ price: 100.6, barTime: t5(3) });
    expect(st.exit).toMatchObject({ kind: 'T1', price: 97 });
  });

  it('the 15m engine on the aggregated bars has not even seen the sweep at 10:55 — 5m confirms first', () => {
    const bars5 = [...base5(), SWEEP, DISP, CONF];
    const s15 = prepareMomentumSeries(to15(bars5));
    // The 10:45 15m bar (sweep + displacement + confirm) closes at 11:00.
    const last15 = s15.bars.length - 1;
    expect(s15.bars[last15].time).toBe(at(TODAY, '10:45'));
    const ev15 = evaluateStructureSession(s15, last15 - 1, STRUCTURE_VARIANTS[1]);
    expect(bear(ev15.setups)).toHaveLength(0);
    expect(bear(run(bars5).setups)[0].stage).toBe('CONFIRMED');
  });
});

describe('rules restated in time', () => {
  it('30 minutes to displace, 120 minutes to fill — the same clock time as the 15m rule for the fill', () => {
    expect(STRUCTURE_RULES_5M.displacementWithinBars * M5).toBe(30 * 60 * 1000);
    expect(STRUCTURE_RULES_5M.fillWithinBars * M5).toBe(STRUCTURE_RULES.fillWithinBars * M15);
    expect(STRUCTURE_RULES_5M.internalSwingLookback).toBe(2);
    expect(STRUCTURE_RULES_5M.lateR).toBe(1);
    // Everything else is the 15m rule.
    const { displacementWithinBars, fillWithinBars, internalSwingLookback, ...rest5 } = STRUCTURE_RULES_5M;
    const { displacementWithinBars: _a, fillWithinBars: _b, internalSwingLookback: _c, ...rest15 } = STRUCTURE_RULES;
    expect(rest5).toEqual(rest15);
  });

  const quiet = (k: number) => B(k, 101.5, 101.6, 101.35, 101.45);

  it('a displacement on the 5th bar after the sweep (25 minutes) still counts', () => {
    const d = B(5, 101.45, 101.5, 100.0, 100.1);
    const [st] = bear(run([...base5(), SWEEP, quiet(1), quiet(2), quiet(3), quiet(4), d]).setups);
    expect(st.displacement).not.toBeNull();
    expect(st.stage).toBe('DEVELOPING');
  });

  it('no displacement within 6 bars (30 minutes) → NO_DISPLACEMENT at the 6th', () => {
    const bars5 = [...base5(), SWEEP, ...[1, 2, 3, 4, 5, 6].map(quiet)];
    const five = bear(run(bars5, bars5.length - 2).setups)[0];
    expect(five.stage).toBe('DEVELOPING');
    const six = bear(run(bars5).setups)[0];
    expect(six).toMatchObject({ stage: 'INVALIDATED', invalidReason: 'NO_DISPLACEMENT' });
    expect(six.history.at(-1)!.at - SWEEP.time - M5).toBe(30 * 60 * 1000);
  });

  it('NO_FILL after 24 bars (120 minutes) without a retrace', () => {
    const drift = Array.from({ length: 24 }, (_, k) => {
      const c = 100.25 - 0.02 * k;
      return B(3 + k, c + 0.02, c + 0.1, c - 0.1, c);
    });
    const bars5 = [...base5(), SWEEP, DISP, CONF, ...drift];
    expect(bear(run(bars5, bars5.length - 2).setups)[0].stage).toBe('CONFIRMED');
    const st = bear(run(bars5).setups)[0];
    expect(st).toMatchObject({ stage: 'INVALIDATED', invalidReason: 'NO_FILL' });
    expect(st.history.at(-1)!.at - (CONF.time + M5)).toBe(120 * 60 * 1000);
  });
});

describe('no look-ahead (15m pools, 5m events)', () => {
  const full5 = [...base5(), SWEEP, DISP, CONF, FILL, B(4, 100.4, 100.5, 99.0, 99.1), B(5, 99.1, 99.2, 97.8, 97.9), B(6, 97.9, 98.0, 96.9, 97.1)];
  const full15 = to15(full5);
  const todayStart = full5.findIndex((b) => b.time >= at(TODAY, '09:15'));

  it('the state at every 5m bar equals the state computed from only the 5m and 15m bars closed by then', () => {
    const s5 = prepareMomentumSeries(full5);
    const s15 = prepareMomentumSeries(full15);
    for (let i = todayStart; i < full5.length; i++) {
      const closeI = full5[i].time + M5;
      const withFuture = evaluateStructureSessionMTF(s15, s5, i, V);
      const only = evaluateStructureSessionMTF(
        prepareMomentumSeries(full15.filter((b) => b.time + M15 <= closeI)),
        prepareMomentumSeries(full5.slice(0, i + 1)),
        i,
        V
      );
      expect(withFuture).toEqual(only);
    }
  });

  it('appending arbitrary future 5m or 15m bars never changes the state at t', () => {
    const i = full5.length - 4; // just after the fill
    const closeI = full5[i].time + M5;
    const past15 = full15.filter((b) => b.time + M15 <= closeI);
    const before = evaluateStructureSessionMTF(prepareMomentumSeries(past15), prepareMomentumSeries(full5.slice(0, i + 1)), i, V);
    const t15 = Math.floor(closeI / M15) * M15;
    const futures5 = [
      [B(10, 99, 110, 90, 105), B(11, 105, 106, 80, 81)],
      Array.from({ length: 30 }, (_, k) => B(10 + k, 100, 100 + k, 100 - k, 100)),
    ];
    const futures15 = [
      [{ time: t15, open: 100, high: 130, low: 70, close: 100, volume: 5 }],
      Array.from({ length: 10 }, (_, k) => ({ time: t15 + k * M15, open: 100, high: 101 + k, low: 99 - k, close: 100, volume: 5 })),
    ];
    for (const extra5 of futures5) {
      for (const extra15 of [[], ...futures15]) {
        const after = evaluateStructureSessionMTF(
          prepareMomentumSeries([...past15, ...extra15]),
          prepareMomentumSeries([...full5.slice(0, i + 1), ...extra5]),
          i,
          V
        );
        expect(after).toEqual(before);
      }
    }
  });

  it('every 5m variant is pre-registered once: D {1.0, 1.5} × closing guard {60, 15}, opening guard off', () => {
    expect(STRUCTURE_5M_VARIANTS.map((v) => [v.dispMult, v.closingGuardMin, v.openingGuard])).toEqual([
      [1.0, 60, false],
      [1.0, 15, false],
      [1.5, 60, false],
      [1.5, 15, false],
    ]);
  });
});
