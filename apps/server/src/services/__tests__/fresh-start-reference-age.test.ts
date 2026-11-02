import { describe, it, expect, vi } from 'vitest';
import { FreshSharedFeed, FRESH_REFERENCE_MAX_AGE_MS } from '../fresh-start/feed.js';
import type { SubscriptionManager } from '../../lib/subscription-manager.js';

function setup() {
  let emit: (t: any[]) => void = () => {};
  const manager = { onTick: vi.fn((f) => { emit = f; return vi.fn(); }), onRecovering: vi.fn(() => vi.fn()), subscribe: vi.fn(async () => {}), unsubscribe: vi.fn() };
  let now = 10_000;
  const feed = new FreshSharedFeed(manager as unknown as SubscriptionManager, () => now);
  feed.start();
  return { feed, emit: (t: any[]) => emit(t), setNow: (t: number) => (now = t) };
}
const tick = (token: string, at: number, ltp = 100) => ({ token, exchange: 'MCX', exchangeSegment: 'MCX_FO', exchangeTimestamp: at, timestamp: at, ltp });

describe('reference freshness (2 Nov: quiet contracts read as stale under a 2 s limit)', () => {
  it('keeps a quiet reference for up to 5 s while the feed is live, never after', async () => {
    const s = setup();
    await s.feed.reserve([{ token: 'crude', exchange: 'MCX', exchangeSegment: 'MCX_FO' }, { token: 'other', exchange: 'MCX', exchangeSegment: 'MCX_FO' }], 250);
    s.emit([tick('crude', 10_000, 5400)]);
    // 3 s later the crude future has not traded, but another contract just ticked: the last trade still counts.
    s.setNow(13_000); s.emit([tick('other', 13_000)]);
    expect(s.feed.underlying('MCX_FO:crude')).toEqual({ price: 5400, at: 10_000 });
    expect(s.feed.underlyingAt('MCX_FO:crude', 13_000)).toEqual({ price: 5400, at: 10_000 });
    // Older than 5 s: stale even with a live feed.
    s.setNow(10_000 + FRESH_REFERENCE_MAX_AGE_MS + 1); s.emit([tick('other', 10_000 + FRESH_REFERENCE_MAX_AGE_MS + 1)]);
    expect(s.feed.underlying('MCX_FO:crude')).toBeNull();
  });
  it('treats a silent feed as stale after 2 s, so a dropped connection never reads as a quiet market', async () => {
    const s = setup();
    await s.feed.reserve([{ token: 'crude', exchange: 'MCX', exchangeSegment: 'MCX_FO' }], 250);
    s.emit([tick('crude', 10_000)]);
    s.setNow(12_500);
    expect(s.feed.feedAlive()).toBe(false);
    expect(s.feed.underlying('MCX_FO:crude')).toBeNull();
  });
});
