import { describe, expect, it, vi } from 'vitest';
import { FreshEventSource } from '../fresh-start/event-source.js';
import { FreshFreeGlobalEvents } from '../fresh-start/free-global-events.js';
import { FRESH_PAPER_EVENT_POLICY } from '../../config/fresh-event-policy.js';

const now = Date.parse('2026-11-05T15:00:00Z');
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const ev = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, ts: at / 1000, time: iso(at), currency: 'USD', impact: 'high', title: id, status: 'scheduled', moved_from: '', confidence: 'sources_agree', ...extra });
const feed = (events: unknown[]) => ({ server_time: now / 1000, server_time_iso: iso(now), generated_at: iso(now), from: iso(now - 21600000), to: iso(now + 172800000), count: events.length, events });

describe('1.8 recent releases for the event breakout', () => {
  it('lists confirmed releases of the market currencies from the last two hours, never uncertain or day-long ones', async () => {
    const free = new FreshFreeGlobalEvents(vi.fn(async () => ({ status: 200, data: feed([
      ev('JOLTS', now - 40 * 60000),
      ev('China PMI', now - 30 * 60000, { currency: 'CNY' }),
      ev('BoC speech', now - 20 * 60000, { currency: 'CAD' }),
      ev('Tentative', now - 10 * 60000, { status: 'tentative' }),
      ev('US Midterm Elections', now - 50 * 60000),
      ev('Old', now - 3 * 3600000),
      ev('Future', now + 600000),
    ]) })) as any, () => now);
    await free.refresh();
    const source = new FreshEventSource(undefined, vi.fn() as any, () => now, null, undefined, null, null, null, FRESH_PAPER_EVENT_POLICY, free);
    expect(source.releases(now, 'INDEX')).toEqual([now - 40 * 60000]);
    expect(source.releases(now, 'COMMODITY', 'CRUDEOIL')).toEqual([now - 40 * 60000, now - 30 * 60000]);
  });
});
