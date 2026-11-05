import { describe, expect, it } from 'vitest';
import { getSessionWindow } from '@fno/shared';
import type { FreshBar } from '@fno/analytics';
import { buildFreshReferenceContext, freshIstDay, freshVolumeReferences } from '../fresh-start/context.js';

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

describe('benchmark volume shape for a contract with too little own history (5 Nov: FINNIFTY SESSIONS_1)', () => {
  // Twenty NSE sessions of bars ending on the day before `now`, plus today's session up to 11:00.
  function bars(levelFor: (dayIndex: number) => number, days = 20) {
    const out: FreshBar[] = [];
    let k = 0;
    for (let d = 40; d >= 1 && k < days; d--) {
      const day = freshIstDay(now - d * 86400000), s = getSessionWindow('NSE', day);
      if (!s) continue;
      for (let t = s.open, slot = 0; t + 300000 <= s.close; t += 300000, slot++) out.push({ time: t, availableAt: t + 300000, open: 100, high: 101, low: 99, close: 100, volume: levelFor(k) * (slot < 3 ? 3 : 1) });
      k++;
    }
    const s = getSessionWindow('NSE', freshIstDay(now))!;
    for (let t = s.open; t + 300000 <= now; t += 300000) out.push({ time: t, availableAt: t + 300000, open: 100, high: 101, low: 99, close: 100, volume: 50 });
    return out;
  }
  const ctx = (own: FreshBar[], volumeBenchmark?: FreshBar[]) => buildFreshReferenceContext({ now, instrument: 'NSE_FO:fin', sourceEpoch: 'e', bars5: own, bars1: [], eventClear: true, referenceVerified: true, ...(volumeBenchmark ? { volumeBenchmark } : {}) })!;
  it('borrows the benchmark shape scaled to the contract\'s own latest session total', () => {
    const own = bars(() => 200, 2), bench = bars(() => 5000);
    const plain = ctx(own);
    expect(plain.rvolReferences[10]).toHaveLength(2); // too few for rvol (needs 15)
    expect(plain.volumeShape).toBeUndefined();
    const c = ctx(own, bench);
    expect(c.volumeShape).toBe('BENCHMARK');
    expect(c.rvolReferences[10]).toHaveLength(20);
    // Own level: 200 x (3 x 3 + 72 x 1) = 16,200 a day; slot 10 holds 1/81 of the day → 200, not the benchmark's 5,000.
    for (const v of c.rvolReferences[10]) expect(v).toBeCloseTo(200, 6);
  });
  it('borrows per slot: a thin contract with 20 covered days but volume in few sessions of a slot (5 Nov FINNIFTY)', () => {
    // Every day covered (quiet gaps filled with zero volume), but slot 10 traded on only 5 of 20 days.
    const own = bars(() => 200).map((b) => { const s = getSessionWindow('NSE', freshIstDay(b.time))!, slot = (b.time - s.open) / 300000, day = Math.floor(b.time / 86400000); return slot === 10 && day % 4 !== 0 && b.time < getSessionWindow('NSE', freshIstDay(now))!.open ? { ...b, volume: 0 } : b; });
    const c = ctx(own, bars(() => 5000));
    expect(c.volumeShape).toBe('BENCHMARK');
    expect(c.rvolReferences[10].filter((x) => x > 0).length).toBeGreaterThanOrEqual(15);
    expect(c.rvolReferences[11]).toEqual(ctx(own).rvolReferences[11]); // a slot with enough own sessions keeps its own
  });
  it('keeps its own references when it has enough sessions, and never borrows without an own level', () => {
    expect(ctx(bars(() => 200), bars(() => 5000)).volumeShape).toBeUndefined();
    const noOwn = ctx(bars(() => 0, 20), bars(() => 5000));
    expect(noOwn.volumeShape).toBeUndefined();
  });
});
