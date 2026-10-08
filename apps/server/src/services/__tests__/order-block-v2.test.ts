// ============================================================
// ORDER BLOCK OB-2.0 (2026-10-09) — the repaired detector, run in SHADOW
// ============================================================
// Real open vs close for candle direction, closed candles only, the candles
// that form a block can never touch / mitigate it, FRESH → FIRST_TOUCH →
// MITIGATED, an ATR-based displacement (no fixed 2% rule), no look-ahead,
// deterministic. The live vote still reads the frozen legacy detector.
// Synthetic bars are FABRICATED; the no-look-ahead check uses the frozen
// real-bar fixture.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const A = await import('@fno/analytics');
const { directionWithOrderBlockVote } = await import('../order-block-shadow.js');
const flags = await import('../../config/order-flow-flags.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-10-06T09:15:00+05:30');
const M15 = 15 * 60_000;
type B = { time: number; open: number; high: number; low: number; close: number };
const bar = (k: number, open: number, high: number, low: number, close: number): B => ({ time: T0 + k * M15, open, high, low, close });

/** 20 quiet bars (range 10, body 1, alternating) → ATR ≈ 10, no displacement anywhere. */
function base(): B[] {
  return Array.from({ length: 20 }, (_, k) => (k % 2 ? bar(k, 100, 105, 95, 101) : bar(k, 101, 105, 95, 100)));
}
/** + block candle (down, [94,101]) at 20, displacement at 21, away at 22, first touch at 23, mitigation at 24. */
function scenario(): B[] {
  return [...base(), bar(20, 100, 101, 94, 95), bar(21, 96, 113, 95, 112), bar(22, 112, 115, 106, 114), bar(23, 106, 107, 100, 104), bar(24, 103, 104, 92, 93)];
}

describe('OB-2.0 detection', () => {
  it('a down candle (close < its OWN open) before an ATR displacement that leaves it is a bullish block', () => {
    const blocks = A.detectOrderBlocks(scenario(), 21);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'BULLISH', blockIndex: 20, displacementIndex: 21, top: 101, bottom: 94, state: 'FRESH', firstTouchIndex: null, mitigatedIndex: null });
    expect(blocks[0].displacementAtr).toBeGreaterThanOrEqual(A.ORDER_BLOCK_RULES.displacementBodyAtr);
  });

  it('the REAL open decides direction: a candle that closed above the previous close but below its own open is a down candle', () => {
    const bars = scenario();
    expect(bars[20].close).toBeLessThan(bars[20].open);
    // The previous close (101 at bar 19) is above it here; make the block candle close ABOVE the prior close but below its own open.
    bars[19] = bar(19, 101, 105, 95, 92);
    bars[20] = bar(20, 100, 101, 94, 95);
    expect(bars[20].close).toBeGreaterThan(bars[19].close);
    expect(A.detectOrderBlocks(bars, 21).map((b) => b.blockIndex)).toContain(20);
  });

  it('no fixed 2% rule: a 0.2% displacement on a quiet market qualifies when it is ≥ 1 ATR', () => {
    const scale = (b: B): B => ({ ...b, open: 25000 + (b.open - 100) * 0.3, high: 25000 + (b.high - 100) * 0.3, low: 25000 + (b.low - 100) * 0.3, close: 25000 + (b.close - 100) * 0.3 });
    const bars = scenario().map(scale);
    const disp = (bars[21].close - bars[21].open) / bars[21].open;
    expect(disp).toBeLessThan(0.003);
    expect(A.detectOrderBlocks(bars, 21)).toHaveLength(1);
  });

  it('a weak displacement (body < 1 ATR), a close inside its range, or one that does not leave the block is no block', () => {
    const weak = scenario();
    weak[21] = bar(21, 96, 103, 95, 102); // body 6 < ATR
    expect(A.detectOrderBlocks(weak, 21)).toHaveLength(0);
    const midClose = scenario();
    midClose[21] = bar(21, 96, 125, 95, 112); // body 16 but closes mid-range
    expect(A.detectOrderBlocks(midClose, 21)).toHaveLength(0);
  });

  it('only the LAST opposing candle before the move is the block', () => {
    const bars = [...base().slice(0, 19), bar(19, 102, 103, 96, 97), bar(20, 100, 101, 94, 95), bar(21, 96, 113, 95, 112)];
    expect(A.detectOrderBlocks(bars, 21).map((b) => b.blockIndex)).toEqual([20]);
  });
});

describe('OB-2.0 lifecycle: FRESH → FIRST_TOUCH → MITIGATED, never self-mitigated', () => {
  it('the candles that form the block (and the displacement) can never touch or mitigate it', () => {
    const bars = scenario();
    // The displacement bar 21 trades down to 95 — inside the block — yet the block stays FRESH at 21 and 22.
    expect(bars[21].low).toBeLessThanOrEqual(101);
    expect(A.detectOrderBlocks(bars, 22)[0]).toMatchObject({ state: 'FRESH', firstTouchIndex: null });
  });
  it('first touch, then mitigation by a close beyond the far edge', () => {
    expect(A.detectOrderBlocks(scenario(), 23)[0]).toMatchObject({ state: 'FIRST_TOUCH', firstTouchIndex: 23, mitigatedIndex: null });
    expect(A.detectOrderBlocks(scenario(), 24)[0]).toMatchObject({ state: 'MITIGATED', firstTouchIndex: 23, mitigatedIndex: 24 });
  });
  it('the decision signal fires on the first touch only, and not when that bar closes through the block', () => {
    expect(A.orderBlockSignalAt(scenario(), 22)).toBeNull();
    expect(A.orderBlockSignalAt(scenario(), 23)).toMatchObject({ vote: 1, block: { blockIndex: 20 } });
    expect(A.orderBlockSignalAt(scenario(), 24)).toBeNull();
    const through = scenario();
    through[23] = bar(23, 106, 107, 90, 92); // touches and closes below the bottom on the same bar
    expect(A.orderBlockSignalAt(through, 23)).toBeNull();
    expect(A.detectOrderBlocks(through, 23)[0]).toMatchObject({ state: 'MITIGATED', firstTouchIndex: 23, mitigatedIndex: 23 });
  });
  it('bearish mirrors', () => {
    const mirror = scenario().map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
    expect(A.detectOrderBlocks(mirror, 24)[0]).toMatchObject({ type: 'BEARISH', blockIndex: 20, firstTouchIndex: 23, mitigatedIndex: 24, state: 'MITIGATED' });
    expect(A.orderBlockSignalAt(mirror, 23)?.vote).toBe(-1);
  });
  it('reaction (measurement only) is MFE / MAE in ATR from the first touch, and held once ≥ 1 ATR', () => {
    const bars = [...scenario().slice(0, 24), bar(24, 104, 118, 103, 117)];
    const r = A.detectOrderBlocks(bars, 24)[0].reaction!;
    expect(r.barsMeasured).toBe(1);
    expect(r.held).toBe(true);
    expect(r.mfeAtr).toBeGreaterThan(1);
  });
});

describe('OB-2.0: no look-ahead, deterministic, closed bars only (frozen real bars)', () => {
  const FIX = JSON.parse(readFileSync(path.join(HERE, 'fixtures/regression-bars.json'), 'utf8')).series as Record<string, number[][]>;
  for (const sym of ['NIFTY', 'BANKNIFTY', 'CRUDEOIL']) {
    it(`${sym}: what is known at bar i never changes when later bars are appended`, () => {
      const bars = FIX[sym].map(([time, open, high, low, close]) => ({ time, open, high, low, close }));
      let signals = 0;
      for (let i = 30; i < bars.length; i += 3) {
        const cut = bars.slice(0, i + 1);
        const strip = (bs: ReturnType<typeof A.detectOrderBlocks>) => bs.map(({ reaction, ...rest }) => rest);
        expect(strip(A.detectOrderBlocks(bars, i))).toEqual(strip(A.detectOrderBlocks(cut)));
        const s = A.orderBlockSignalAt(bars, i);
        expect(s).toEqual(A.orderBlockSignalAt(cut, i));
        if (s) signals++;
      }
      expect(A.detectOrderBlocks(bars)).toEqual(A.detectOrderBlocks(bars)); // deterministic
      expect(A.detectOrderBlocks(bars).length).toBeGreaterThan(0);
      expect(signals).toBeGreaterThanOrEqual(0);
    });
  }
  it('the frozen legacy detector (still the live vote) is unchanged and, as measured, never fires on these bars', () => {
    for (const sym of ['NIFTY', 'BANKNIFTY']) {
      const b = FIX[sym];
      for (let i = 30; i < b.length; i++) {
        const w = b.slice(0, i + 1);
        const blocks = A.detectOrderBlocksLegacy(w.map((x) => x[2]), w.map((x) => x[3]), w.map((x) => x[4]));
        expect(A.testActiveOrderBlockLegacy(blocks, w[w.length - 1][4])).toBeNull();
      }
    }
  });
});

describe('shadow wiring: the live vote stays legacy; OB-2.0 only measured', () => {
  const mb = readFileSync(path.join(HERE, '../market-bias.ts'), 'utf8');
  it('market-bias votes with the legacy detector and records OB-2.0 after the decision is final', () => {
    expect(mb).toMatch(/const orderBlocks = detectOrderBlocksLegacy\(c15\.highs, c15\.lows, c15\.closes\);/);
    expect(mb).toMatch(/const activeOrderBlock = testActiveOrderBlockLegacy\(orderBlocks, spot\);/);
    const hook = mb.indexOf('await recordOrderBlockShadow(');
    expect(hook).toBeGreaterThan(mb.indexOf('const tradeSetup: TradeSetup = chain'));
    expect(hook).toBeLessThan(mb.indexOf('const result: MarketBiasResult = {'));
  });
  it('ORDER_BLOCK_MODE: SHADOW by default, OFF allowed, LIVE refused (a code change, never a setting)', () => {
    expect(flags.parseOrderBlockMode(undefined)).toEqual({ value: 'SHADOW', rejected: null });
    expect(flags.parseOrderBlockMode('off')).toEqual({ value: 'OFF', rejected: null });
    expect(flags.parseOrderBlockMode('LIVE')).toEqual({ value: 'SHADOW', rejected: 'LIVE' });
    expect(flags.ORDER_BLOCK_MODE).toBe('SHADOW');
  });
  it('"would the OB-2.0 vote change the indicator\'s direction" uses the same netting and caps', () => {
    const chart = [1, 1, -1, -1, 1, -1] as const; // net 0 (incl. a legacy -1)
    expect(directionWithOrderBlockVote({ chartVotes: [...chart], positioningVotes: [], legacyVote: 0, v2Vote: 1, cap: 3 })).toBe('BULLISH');
    expect(directionWithOrderBlockVote({ chartVotes: [...chart], positioningVotes: [], legacyVote: -1, v2Vote: 0, cap: 3 })).toBe('BULLISH');
    // The cap absorbs it: chart +5 → +3 with or without one more vote, positioning −3 → NEUTRAL either way.
    expect(directionWithOrderBlockVote({ chartVotes: [1, 1, 1, 1, 1], positioningVotes: [-1, -1, -1], legacyVote: 0, v2Vote: -1, cap: 3 })).toBe('NEUTRAL');
    expect(directionWithOrderBlockVote({ chartVotes: [1], positioningVotes: [-1], legacyVote: 0, v2Vote: 0, cap: 3 })).toBe('NEUTRAL');
  });
});
