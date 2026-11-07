// Test fixtures for the Dhan setups: 15-minute bars with explicit footprint rows (price step 1, tick 0.1).
import type { FootprintBar } from '../../order-flow/index.js';
import type { EngineBar } from '../common.js';
import type { SetupContext } from '../setups.js';

export const OPEN = Date.parse('2026-11-09T03:45:00Z'); // Monday 09:15 IST
export const Q = 900_000;
export type Rows = Array<[number, number, number]>; // [price, buy, sell]

export interface BarSpec { o: number; h: number; l: number; c: number; rows?: Rows; trades?: number }

/** Rows from ceil(low) to floor(high) with the same buy / sell on each. */
export const even = (l: number, h: number, buy: number, sell: number): Rows => {
  const out: Rows = [];
  for (let p = Math.ceil(l); p <= Math.floor(h); p++) out.push([p, buy, sell]);
  return out;
};

export function fpOf(time: number, s: BarSpec): FootprintBar {
  const rows = s.rows ?? even(s.l, s.h, 25, 25);
  const levels = rows.map(([price, buy, sell]) => ({ price, buy, sell, unclassified: 0 }));
  const buy = levels.reduce((a, l) => a + l.buy, 0), sell = levels.reduce((a, l) => a + l.sell, 0);
  return {
    barTime: time, barMs: Q, deltaMode: 'INFERRED', trades: s.trades ?? 100, volume: buy + sell, buyVolume: buy, sellVolume: sell, unclassifiedVolume: 0,
    delta: buy - sell, deltaPct: Math.round(((buy - sell) / (buy + sell)) * 10000) / 10000, levels, poc: null, vah: null, val: null, buyImbalances: 0, sellImbalances: 0,
    high: s.h, low: s.l, close: s.c, priceStep: 1, tickSize: 0.1, sourceInstrument: 'X-FUT', unreconciledVolume: 0,
  };
}

/** A context: `prior` bars on the previous trading day (Friday), `today` from the session open. */
export function contextOf(prior: BarSpec[], today: BarSpec[], extra: Partial<SetupContext> = {}): SetupContext {
  const friday = OPEN - 3 * 86_400_000;
  const all = [...prior.map((s, k) => [friday + k * Q, s] as const), ...today.map((s, k) => [OPEN + k * Q, s] as const)];
  const bars: EngineBar[] = all.map(([t, s]) => ({ time: t, open: s.o, high: s.h, low: s.l, close: s.c, volume: 0 }));
  const fps = all.map(([t, s]) => fpOf(t, s));
  // Trade VWAP sums from the rows (each row's volume at its price).
  const vwapSums = fps.map((f) => f.levels.reduce((a, l) => { const q = l.buy + l.sell; return { pv: a.pv + l.price * q, v: a.v + q, p2v: a.p2v + l.price * l.price * q }; }, { pv: 0, v: 0, p2v: 0 }));
  return {
    symbol: 'X', instrument: 'X-FUT', kind: 'INDEX', exchange: 'NSE', tickSize: 0.1, bars, fps, vwapSums, rvol: bars.map(() => null),
    daily: [{ time: friday, open: 100, high: 120, low: 98, close: 100 }], sessionOpen: OPEN, health: { stale: false, mappingValid: true }, ...extra,
  };
}

/** The previous session: 12 quiet bars 98-102 (range 4), rows sell 10 / buy 10 -> the absorption baseline. */
export const QUIET: BarSpec[] = Array.from({ length: 12 }, () => ({ o: 100, h: 102, l: 98, c: 100, rows: even(98, 102, 10, 10) }));
