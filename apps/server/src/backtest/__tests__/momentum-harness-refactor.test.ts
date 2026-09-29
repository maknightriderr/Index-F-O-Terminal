// ============================================================
// The backtest harness refactor must not change momentum-break
// ============================================================
// 1. Data-free: a seeded synthetic year replayed through replaySymbol for all
//    four momentum variants. The snapshot was written by the harness BEFORE
//    it was generalised into a strategy interface; any drift fails here.
// 2. With the saved 15m history present (apps/server/backtest-data/, not in
//    git): the rendered momentum report is byte-identical to the committed
//    reference copy of the report the momentum PR shipped.
// ============================================================

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOMENTUM_BREAK_VARIANTS, prepareMomentumSeries, type MomentumBar } from '@fno/analytics';
import { replaySymbol, sessionMasks, statsOf, type LoadedSymbol } from '../momentum-backtest.js';

const BAR = 15 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));

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

describe('momentum harness — unchanged by the refactor', () => {
  it('synthetic replay, every variant, matches the pre-refactor snapshot', () => {
    const loaded = syntheticSymbol();
    const window = { from: '2026-01-01', to: '2026-12-31' };
    const out = MOMENTUM_BREAK_VARIANTS.map((v) => {
      const trades = replaySymbol(loaded, v, window);
      return { variant: v.id, stats: statsOf(trades), trades };
    });
    expect(out.reduce((n, r) => n + r.trades.length, 0)).toBeGreaterThan(0);
    expect(out).toMatchSnapshot();
  });

  const dataDir = join(HERE, '../../../backtest-data');
  const reference = join(HERE, '__fixtures__/momentum-report.reference.md');
  const haveData = existsSync(join(dataDir, 'NIFTY_INDEX.json')) && existsSync(join(dataDir, 'CRUDEOIL.json'));
  it.skipIf(!haveData)('the momentum report rendered from the saved history is byte-identical to the shipped one', async () => {
    const { renderMomentumReport } = await import('../momentum-report.js');
    const { lines } = renderMomentumReport(dataDir, { inSampleOnly: false, quiet: true });
    expect(lines.join('\n')).toBe(readFileSync(reference, 'utf8'));
  }, 600_000);
});
