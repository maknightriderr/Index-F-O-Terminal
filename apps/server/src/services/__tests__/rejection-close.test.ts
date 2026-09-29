// ============================================================
// STRUCTURE ENGINE — REJECTION_CLOSE entry rule (pure)
// ============================================================
// rejectionCloseFill: a single closed bar, tested against a zone and
// direction. Pure and single-bar by construction — "no look-ahead" here
// means its answer for a bar depends only on that bar's own OHLC.
// ============================================================

import { describe, it, expect } from 'vitest';
import { rejectionCloseFill, type RejectionCloseZone } from '@fno/analytics';

const FVG: RejectionCloseZone = { near: 100, far: 101, kind: 'FVG' }; // top=101, bottom=100

describe('rejectionCloseFill: bullish', () => {
  it('trades into the zone and closes back above the top, in the upper half — a fill', () => {
    // low dips to 100.5 (inside the zone, below top 101), closes at 101.3
    // (above top), range 100.5..101.4 -> close fraction (101.3-100.5)/0.9=0.89 (upper half).
    const bar = { open: 100.6, high: 101.4, low: 100.5, close: 101.3 };
    const hit = rejectionCloseFill(bar, FVG, 'BULLISH');
    expect(hit).not.toBeNull();
    expect(hit!.entry).toBe(101.3);
  });

  it('never trades into the zone at all — no fill', () => {
    const bar = { open: 101.2, high: 101.5, low: 101.1, close: 101.4 }; // low never reaches 101 (zone top)
    expect(rejectionCloseFill(bar, FVG, 'BULLISH')).toBeNull();
  });

  it('trades into the zone but closes back INSIDE it (not beyond the top) — no fill', () => {
    const bar = { open: 100.8, high: 100.95, low: 100.4, close: 100.7 }; // closes at 100.7, still below top 101
    expect(rejectionCloseFill(bar, FVG, 'BULLISH')).toBeNull();
  });

  it('closes beyond the top but in the LOWER half of its own range — no fill (not decisive enough)', () => {
    // A wide-range bar whose close clears the zone top (101) but only barely,
    // landing in the lower half of the bar's own (much larger) range.
    const bar = { open: 100.5, high: 110.0, low: 100.0, close: 101.05 }; // range 10, close fraction (101.05-100)/10 = 0.105 -> lower half
    expect(rejectionCloseFill(bar, FVG, 'BULLISH')).toBeNull();
  });
});

describe('rejectionCloseFill: bearish (mirror)', () => {
  const zone: RejectionCloseZone = { near: 200, far: 199, kind: 'FVG' }; // top=200, bottom=199
  it('trades into the zone and closes back below the bottom, in the lower half — a fill', () => {
    const bar = { open: 199.4, high: 199.5, low: 198.6, close: 198.7 }; // high 199.5 >= bottom 199, close 198.7 < 199, range 0.9, closeFrac (198.7-198.6)/0.9=0.11 (lower half)
    const hit = rejectionCloseFill(bar, zone, 'BEARISH');
    expect(hit).not.toBeNull();
    expect(hit!.entry).toBe(198.7);
  });
  it('never trades up into the zone — no fill', () => {
    const bar = { open: 198.5, high: 198.9, low: 198.4, close: 198.6 };
    expect(rejectionCloseFill(bar, zone, 'BEARISH')).toBeNull();
  });
});

describe('rejectionCloseFill: candle pattern label reuses the sweep-candle shapes', () => {
  it('a clean hammer-shaped rejection candle is labelled "Hammer at FVG"', () => {
    // Small body near the top of its range, long lower wick, negligible upper wick.
    const bar = { open: 101.2, high: 101.22, low: 100.0, close: 101.22 };
    const hit = rejectionCloseFill(bar, FVG, 'BULLISH');
    expect(hit).not.toBeNull();
    expect(hit!.shape).toBe('HAMMER');
    expect(hit!.label).toBe('Hammer at FVG');
  });
  it('a DISP_50 zone is named "the 50% zone"', () => {
    const zone: RejectionCloseZone = { near: 100, far: 100, kind: 'DISP_50' };
    const bar = { open: 100.2, high: 100.3, low: 99.9, close: 100.25 };
    const hit = rejectionCloseFill(bar, zone, 'BULLISH');
    expect(hit?.label).toMatch(/the 50% zone$/);
  });
});
