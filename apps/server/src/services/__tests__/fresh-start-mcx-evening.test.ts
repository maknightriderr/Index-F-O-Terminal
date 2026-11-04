import { describe, expect, it } from 'vitest';
import { getSessionWindow } from '@fno/shared';
import { buildFreshReferenceContext, freshIstDay, freshMcxEveningAnchor } from '../fresh-start/context.js';

describe('MCX evening opening anchor (1.7)', () => {
  it('is 09:00 New York: 19:30 IST in US winter, 18:30 IST in US summer', () => {
    expect(freshMcxEveningAnchor('2026-11-05')).toBe(Date.parse('2026-11-05T19:30:00+05:30'));
    expect(freshMcxEveningAnchor('2026-07-15')).toBe(Date.parse('2026-07-15T18:30:00+05:30'));
  });
  it('adds the evening anchor with its own volume references to MCX contexts only', () => {
    const now = Date.parse('2026-11-05T20:00:00+05:30');
    const bars = [];
    for (let d = 35; d >= 1; d--) {
      const s = getSessionWindow('MCX', freshIstDay(now - d * 86400000));
      if (!s) continue;
      for (let t = s.open; t + 300000 <= s.close; t += 300000) bars.push({ time: t, availableAt: t + 300000, open: 1, high: 1, low: 1, close: 1, volume: 10 });
    }
    const mcx = buildFreshReferenceContext({ now, instrument: 'MCX_FO:1', sourceEpoch: 'e', bars5: bars, bars1: [], eventClear: true, referenceVerified: true, exchange: 'MCX' })!;
    expect(mcx.openingAnchors!.map((a) => a.at)).toEqual([mcx.sessionOpen, Date.parse('2026-11-05T19:30:00+05:30')]);
    expect(mcx.openingAnchors![1].volumeReferences.length).toBeGreaterThanOrEqual(15);
    // Level-normalised (5 Nov): ~30 = three 10-lot bars, scaled to the latest session's total (its close varies with US DST).
    expect(mcx.openingAnchors![1].volumeReferences[0]).toBeGreaterThan(28);
    expect(mcx.openingAnchors![1].volumeReferences[0]).toBeLessThan(32);
    const nse = buildFreshReferenceContext({ now: Date.parse('2026-11-05T11:00:00+05:30'), instrument: 'NSE_FO:1', sourceEpoch: 'e', bars5: [], bars1: [], eventClear: true, referenceVerified: true, exchange: 'NSE' })!;
    expect(nse.openingAnchors!.map((a) => a.at)).toEqual([nse.sessionOpen]);
  });
});
