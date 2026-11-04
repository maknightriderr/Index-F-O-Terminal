import { describe, expect, it } from 'vitest';
import { getSessionWindow } from '@fno/shared';
import type { FreshBar } from '@fno/analytics';
import { freshIstDay, freshVolumeReferences } from '../fresh-start/context.js';

// Twenty NSE sessions of a futures contract: as the next month (first 15 days) it trades 10% of its front-month volume.
const now = Date.parse('2026-11-05T11:00:00+05:30');
function history(levelFor: (dayIndex: number) => number, profile = (slot: number) => (slot < 3 ? 3 : 1)) {
  const byDay = new Map<string, FreshBar[]>(), dates: string[] = [];
  let k = 0;
  for (let d = 40; d >= 1 && dates.length < 20; d--) {
    const day = freshIstDay(now - d * 86400000), s = getSessionWindow('NSE', day);
    if (!s) continue;
    const bars: FreshBar[] = [];
    for (let t = s.open, slot = 0; t + 300000 <= s.close; t += 300000, slot++) bars.push({ time: t, availableAt: t + 300000, open: 1, high: 1, low: 1, close: 1, volume: levelFor(k) * profile(slot) });
    byDay.set(day, bars); dates.push(day); k++;
  }
  return { byDay, dates };
}

describe('level-normalised relative volume (5 Nov audit: futures rollover)', () => {
  it('scales every reference day to the latest session level, so the next-month weeks do not deflate the baseline', () => {
    const { byDay, dates } = history((i) => (i < 15 ? 100 : 1000));
    const r = freshVolumeReferences(byDay, dates, 'NSE');
    const latestTotal = byDay.get(dates[dates.length - 1])!.reduce((n, b) => n + b.volume, 0);
    expect(r.level).toBe(latestTotal);
    // Slot 10 carries 1000 at today's level on every reference day, not a 100/1000 mix with a median of 100.
    for (const v of r.slots[10]) expect(v).toBeCloseTo(1000, 6);
    expect(r.slots[10]).toHaveLength(20);
    for (const v of r.opening) expect(v).toBeCloseTo(9000, 6);
  });
  it('keeps the intraday shape, skips thin days and refuses to invent a level', () => {
    const { byDay, dates } = history(() => 1000);
    const thin = dates[dates.length - 1];
    byDay.set(thin, byDay.get(thin)!.filter((_, i) => i % 2 === 0)); // half the session missing
    const r = freshVolumeReferences(byDay, dates, 'NSE');
    expect(r.slots[0][0] / r.slots[10][0]).toBeCloseTo(3, 6);
    expect(r.slots[10]).toHaveLength(19);
    expect(freshVolumeReferences(new Map(), [], 'NSE')).toMatchObject({ level: null, opening: [] });
  });
});
