import { describe, expect, it, vi } from 'vitest';
import { FreshFreeGlobalEvents, FREE_GLOBAL_UNCERTAIN_WINDOW_MS, FREE_GLOBAL_UNCERTAIN_DATA_WINDOW_MS } from '../fresh-start/free-global-events.js';

// 3 Nov 2026, 09:30 IST. A tentative USD event reported for 20:00 IST used to block the whole IST day.
const now = Date.parse('2026-11-03T04:00:00Z');
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const ev = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, ts: at / 1000, time: iso(at), currency: 'USD', impact: 'high', title: id, status: 'scheduled', moved_from: '', confidence: 'sources_agree', ...extra });
const feed = (events: unknown[]) => ({ server_time: now / 1000, server_time_iso: iso(now), generated_at: iso(now), from: iso(now - 21600000), to: iso(now + 172800000), count: events.length, events });
async function source(events: unknown[]) {
  const s = new FreshFreeGlobalEvents(vi.fn(async () => ({ status: 200, data: feed(events) })) as any, () => now);
  await s.refresh();
  return s;
}

describe('free global events: uncertain time blocks a window, not the whole day (3 Nov)', () => {
  const evening = Date.parse('2026-11-03T14:30:00Z'); // 20:00 IST
  it('leaves the NSE session open when the uncertain event is hours away', async () => {
    const s = await source([ev('US election', evening, { status: 'tentative', confidence: 'single_source' })]);
    expect(s.blockers(now)).toEqual([]);
    expect(s.evidence(now)!.uncertainDays).toEqual(['2026-11-03']); // still recorded as evidence
  });
  it('blocks within ±30 min of an uncertain data release (owner, 10 Nov), ±2 h of an uncertain speech, ±15 min of a confirmed one', async () => {
    const s = await source([ev('tentative', now + FREE_GLOBAL_UNCERTAIN_DATA_WINDOW_MS - 60000, { status: 'tentative' }), ev('confirmed', now + 30 * 60000)]);
    expect(s.blockers(now)).toEqual(['FREE_GLOBAL_EVENT_TIME_UNCERTAIN']);
    expect(s.blocking(now).map((e) => e.id)).toEqual(['tentative']);
    expect((await source([ev('tentative', now + FREE_GLOBAL_UNCERTAIN_DATA_WINDOW_MS + 60000, { status: 'tentative' })])).blockers(now)).toEqual([]);
    expect((await source([ev('talk', now + FREE_GLOBAL_UNCERTAIN_WINDOW_MS - 60000, { status: 'tentative', title: "Fed's Chair speech" })])).blockers(now)).toEqual(['FREE_GLOBAL_EVENT_TIME_UNCERTAIN']);
    const c = await source([ev('confirmed', now + 10 * 60000)]);
    expect(c.blockers(now)).toEqual(['FREE_GLOBAL_RELEASE_BLACKOUT']);
  });
  it('never blocks on a day-long non-release listed with a placeholder time (US Midterm Elections, 3 Nov)', async () => {
    const s = await source([ev('election', now + 30 * 60000, { title: 'US Midterm Elections', confidence: 'single_source' }), ev('holiday', now, { title: 'Bank Holiday' })]);
    expect(s.blockers(now)).toEqual([]);
    expect(s.evidence(now)!.events).toHaveLength(2);
  });
  it('blocks a market only for its own currencies (BoC speech, CAD, 3 Nov 21:30 IST)', async () => {
    const s = await source([ev('BoC speech', now + 5 * 60000, { currency: 'CAD' }), ev('China PMI', now + 600000, { currency: 'CNY' })]);
    expect(s.blockers(now, 'INDEX')).toEqual([]);
    expect(s.blockers(now, 'COMMODITY')).toEqual(['FREE_GLOBAL_RELEASE_BLACKOUT']);
    expect(s.blocking(now, 'COMMODITY').map((e) => e.currency)).toEqual(['CNY']);
    const usd = await source([ev('JOLTS', now + 600000)]);
    expect(usd.blockers(now, 'INDEX')).toEqual(['FREE_GLOBAL_RELEASE_BLACKOUT']);
    expect(usd.blockers(now, 'COMMODITY')).toEqual(['FREE_GLOBAL_RELEASE_BLACKOUT']);
  });
  it('treats disputed sources as uncertain and checks both the old and new time of a moved release', async () => {
    const s = await source([ev('disputed', now + 25 * 60000, { confidence: 'sources_disagree' })]);
    expect(s.blockers(now)).toEqual(['FREE_GLOBAL_EVENT_TIME_UNCERTAIN']);
    const m = await source([ev('moved', now + 5 * 3600000, { status: 'moved', moved_from: iso(now + 5 * 60000) })]);
    expect(m.blockers(now)).toEqual(['FREE_GLOBAL_RELEASE_BLACKOUT']);
  });
});
