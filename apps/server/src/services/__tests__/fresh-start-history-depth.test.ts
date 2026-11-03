import { describe, expect, it } from 'vitest';
import { getSessionWindow } from '@fno/shared';
import { FRESH_MIN_VOLUME_SESSIONS } from '@fno/analytics';
import { FRESH_HISTORY_SEED_DAYS } from '../fresh-start/worker.js';
import { buildFreshReferenceContext, freshIstDay } from '../fresh-start/context.js';

// 2–3 Nov 2026: a 12-day seed held ~8 sessions, so relative volume (needs 15) never existed and no setup qualified.
const now = Date.parse('2026-11-03T06:00:00Z');

describe('fresh-start history depth covers relative volume', () => {
  it('seeds enough sessions on NSE and MCX for the rvol and opening-volume references', () => {
    for (const ex of ['NSE', 'MCX'] as const) {
      let sessions = 0;
      for (let d = 1; d <= FRESH_HISTORY_SEED_DAYS; d++) if (getSessionWindow(ex, freshIstDay(now - d * 86400000))) sessions++;
      expect(sessions, ex).toBeGreaterThanOrEqual(FRESH_MIN_VOLUME_SESSIONS + 3);
    }
  });
  it('turns a full seed into ≥15 volume references per five-minute slot', () => {
    const bars = [];
    for (let d = FRESH_HISTORY_SEED_DAYS; d >= 1; d--) {
      const s = getSessionWindow('NSE', freshIstDay(now - d * 86400000));
      if (!s) continue;
      for (let t = s.open; t + 300000 <= s.close; t += 300000) bars.push({ time: t, availableAt: t + 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    }
    const c = buildFreshReferenceContext({ now, instrument: 'NSE_FO:1', sourceEpoch: 'e', bars5: bars, bars1: [], eventClear: true, referenceVerified: true, exchange: 'NSE' })!;
    expect(c.rvolReferences[0].length).toBeGreaterThanOrEqual(FRESH_MIN_VOLUME_SESSIONS);
    expect(c.openingVolumeReferences.length).toBeGreaterThanOrEqual(FRESH_MIN_VOLUME_SESSIONS);
  });
});
