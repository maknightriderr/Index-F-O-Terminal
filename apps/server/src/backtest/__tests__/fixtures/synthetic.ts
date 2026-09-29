// Fabricated, seeded fixtures for the backtest tests. Not a test file.

import { prepareMomentumSeries, type MomentumBar } from '@fno/analytics';
import { sessionMasks, type LoadedSymbol } from '../../momentum-backtest.js';

const BAR = 15 * 60 * 1000;

/** Mulberry32 — a fixed-seed PRNG so the fixture is the same on every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ~60 NSE-like sessions (09:15-15:30 IST, 25 bars), a random walk with occasional impulse bars on heavy volume. */
export function syntheticSymbol(seed = 7): LoadedSymbol {
  const rnd = prng(seed);
  const bars: MomentumBar[] = [];
  let price = 20000;
  let day = Date.parse('2026-01-05T09:15:00+05:30');
  for (let d = 0; d < 60; d++) {
    const dow = new Date(day + 5.5 * 3600e3).getUTCDay();
    if (dow === 0 || dow === 6) { day += 86400e3; d--; continue; }
    for (let k = 0; k < 25; k++) {
      const impulse = rnd() < 0.06;
      const step = (rnd() - 0.5) * (impulse ? 160 : 40);
      const open = price;
      const close = price + step;
      const high = Math.max(open, close) + rnd() * 12;
      const low = Math.min(open, close) - rnd() * 12;
      const volume = Math.round((impulse ? 4 : 1) * (8000 + rnd() * 4000));
      bars.push({ time: day + k * BAR, open, high, low, close, volume });
      price = close;
    }
    day += 86400e3;
  }
  const series = prepareMomentumSeries(bars);
  const { masked, rolls } = sessionMasks(series, false);
  return {
    spec: { symbol: 'SYNTH', exchange: 'NSE', priceFile: 'SYNTH', futuresPrice: false },
    series,
    masked,
    rolls,
    droppedPartial: 0,
    droppedOutOfSession: 0,
    volumeCoverage: 1,
    firstBar: new Date(bars[0].time).toISOString(),
    lastBar: new Date(bars[bars.length - 1].time).toISOString(),
  };
}


/**
 * Structure-engine fixture: alternating "quiet" and "pattern" NSE sessions.
 * A quiet day rises M → M+30, falls to M−30 and recovers to M+20, so the next
 * day has PDH = M+30 and PDL = M−30. A pattern day holds near PDH−8, sweeps
 * PDH by 3 and closes back inside, displaces ~15 down taking the session low,
 * leaves a fair-value gap, then (seeded) retraces into it and either runs to
 * PDL (win), reverses through the stop (loss), or falls straight to PDL
 * without a retrace (missed).
 */
export function structureSymbol(seed = 3, days = 36): LoadedSymbol {
  const rnd = prng(seed);
  const bars: MomentumBar[] = [];
  let day = Date.parse('2026-02-02T09:15:00+05:30');
  let M = 1000;
  let H = 0;
  let prevClose = M;
  const push = (k: number, open: number, high: number, low: number, close: number) => {
    bars.push({ time: day + k * BAR, open, high, low, close, volume: 1000 + Math.round(rnd() * 500) });
    prevClose = close;
  };
  const line = (k0: number, n: number, from: number, to: number) => {
    for (let k = 0; k < n; k++) {
      const o = from + ((to - from) * k) / n;
      const c = from + ((to - from) * (k + 1)) / n;
      push(k0 + k, o, Math.max(o, c) + 0.8, Math.min(o, c) - 0.8, c);
    }
  };
  for (let d = 0; d < days; d++) {
    const dow = new Date(day + 5.5 * 3600e3).getUTCDay();
    if (dow === 0 || dow === 6) { day += 86400e3; d--; continue; }
    if (d % 2 === 0) {
      M = prevClose - 20;
      line(0, 8, prevClose, M + 30);
      line(8, 8, M + 30, M - 30);
      line(16, 9, M - 30, M + 20);
      H = M + 30 + 0.8; // the quiet day's high (wick included)
    } else {
      // Hold near PDH − 8.
      for (let k = 0; k < 6; k++) {
        const c = H - (k % 2 === 0 ? 8 : 6);
        push(k, prevClose, Math.max(prevClose, c) + 0.8, Math.min(prevClose, c) - 0.8, c);
      }
      push(6, H - 6, H + 3, H - 7, H - 4); // sweep PDH, close back inside
      push(7, H - 4, H - 3.5, H - 19, H - 18.5); // displacement
      push(8, H - 18.5, H - 12, H - 19.5, H - 16); // FVG: H−7 > H−12
      const outcome = rnd();
      let k = 9;
      if (outcome < 0.4) {
        push(k++, H - 16, H - 11.5, H - 16.5, H - 14); // fills at H − 12
        line(k, 8, H - 14, H - 64);
        k += 8;
      } else if (outcome < 0.75) {
        push(k++, H - 16, H - 11.5, H - 16.5, H - 12.5); // fills
        line(k, 5, H - 12.5, H + 6); // through the stop
        k += 5;
      } else {
        line(k, 6, H - 16, H - 64); // straight to PDL: missed
        k += 6;
      }
      while (k < 25) {
        push(k, prevClose, prevClose + 0.8, prevClose - 0.8, prevClose);
        k++;
      }
    }
    day += 86400e3;
  }
  const series = prepareMomentumSeries(bars);
  const { masked, rolls } = sessionMasks(series, false);
  return {
    spec: { symbol: 'SYNTH_S', exchange: 'NSE', priceFile: 'SYNTH_S', futuresPrice: false },
    series,
    masked,
    rolls,
    droppedPartial: 0,
    droppedOutOfSession: 0,
    volumeCoverage: 1,
    firstBar: new Date(bars[0].time).toISOString(),
    lastBar: new Date(bars[bars.length - 1].time).toISOString(),
  };
}

/**
 * The structure fixture at 5m: each 15m bar of structureSymbol split into
 * three 5m bars along its open → extreme → extreme → close path (bearish
 * bars go via the high first), so the 15m series is exactly the 5m series
 * aggregated. Loaded as the harness loads a 5m symbol: 5m series, 15m pools.
 */
export function structureSymbol5m(seed = 3, days = 36): LoadedSymbol {
  const l15 = structureSymbol(seed, days);
  const M5 = 5 * 60 * 1000;
  const bars: MomentumBar[] = [];
  for (const b of l15.series.bars) {
    const up = b.close >= b.open;
    const [x1, x2] = up ? [b.low, b.high] : [b.high, b.low];
    const v = Math.round(b.volume / 3);
    bars.push({ time: b.time, open: b.open, high: Math.max(b.open, x1), low: Math.min(b.open, x1), close: x1, volume: v });
    bars.push({ time: b.time + M5, open: x1, high: b.high, low: b.low, close: x2, volume: v });
    bars.push({ time: b.time + 2 * M5, open: x2, high: Math.max(x2, b.close), low: Math.min(x2, b.close), close: b.close, volume: b.volume - 2 * v });
  }
  const series = prepareMomentumSeries(bars);
  return {
    ...l15,
    spec: { ...l15.spec, symbol: 'SYNTH_S5' },
    series,
    barMs: M5,
    poolSeries: l15.series,
    firstBar: new Date(bars[0].time).toISOString(),
    lastBar: new Date(bars[bars.length - 1].time).toISOString(),
  };
}
