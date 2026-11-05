import { describe, it, expect, vi } from 'vitest';
import { FreshSharedFeed, FRESH_REFERENCE_MAX_AGE_MS, FRESH_QUIET_SIGNAL_MAX_AGE_MS, FRESH_TICK_MAX_LAG_MS } from '../fresh-start/feed.js';
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
  it('reads a quiet index future as its live spot plus the basis at its last trade, up to 60 s (5 Nov: NIFTYNXT50)', async () => {
    const s = setup();
    const fut = (at: number, ltp: number) => ({ token: 'nxt-fut', exchange: 'NSE', exchangeSegment: 'NSE_FO', exchangeTimestamp: at, timestamp: at, ltp });
    const spot = (at: number, ltp: number) => ({ token: 'nxt', exchange: 'NSE', exchangeSegment: 'NSE_CM', exchangeTimestamp: at, timestamp: at, ltp });
    await s.feed.reserve([{ token: 'nxt-fut', exchange: 'NSE', exchangeSegment: 'NSE_FO' }, { token: 'nxt', exchange: 'NSE', exchangeSegment: 'NSE_CM' }], 250);
    s.feed.pairReference('NSE_FO:nxt-fut', 'NSE_CM:nxt');
    s.emit([spot(10_000, 70_000)]); s.setNow(10_500); s.emit([fut(10_500, 70_250)]); // basis +250
    // 20 s later the future has not traded; the spot has moved to 70,100.
    s.setNow(30_500); s.emit([spot(30_500, 70_100)]);
    expect(s.feed.underlying('NSE_FO:nxt-fut')).toEqual({ price: 70_350, at: 30_500 });
    expect(s.feed.underlyingAt('NSE_FO:nxt-fut', 30_500)).toEqual({ price: 70_350, at: 30_500 });
    // A fresh futures trade is still read directly.
    s.setNow(31_000); s.emit([fut(31_000, 70_400)]);
    expect(s.feed.underlying('NSE_FO:nxt-fut')).toEqual({ price: 70_400, at: 31_000 });
    // Past 60 s without a futures trade: stale, however live the spot.
    const late = 31_000 + FRESH_QUIET_SIGNAL_MAX_AGE_MS + 1;
    s.setNow(late); s.emit([spot(late, 70_200)]);
    expect(s.feed.underlying('NSE_FO:nxt-fut')).toBeNull();
  });
  it('never invents a quiet-signal price without a paired spot, or with a stale spot', async () => {
    const s = setup();
    const fut = (at: number, ltp: number) => ({ token: 'f', exchange: 'NSE', exchangeSegment: 'NSE_FO', exchangeTimestamp: at, timestamp: at, ltp });
    await s.feed.reserve([{ token: 'f', exchange: 'NSE', exchangeSegment: 'NSE_FO' }, { token: 's', exchange: 'NSE', exchangeSegment: 'NSE_CM' }], 250);
    s.emit([fut(10_000, 100)]); s.setNow(20_000); s.emit([{ ...fut(20_000, 1), token: 's', exchangeSegment: 'NSE_CM' }]);
    expect(s.feed.underlying('NSE_FO:f')).toBeNull(); // not paired
    s.feed.pairReference('NSE_FO:f', 'NSE_CM:s');
    expect(s.feed.underlying('NSE_FO:f')).toBeNull(); // paired, but no basis was ever measured (spot and future 10 s apart)
  });
  it('keeps a 3 s late MCX tick as the last trade, drops one > 10 s late, reads a small clock lead as receive time (5 Nov)', async () => {
    const s = setup();
    await s.feed.reserve([{ token: 'crude', exchange: 'MCX', exchangeSegment: 'MCX_FO' }], 250);
    // Exchange time 10,000, received at 13,000: 3 s late. It used to be dropped (> 2 s) and the future read as stale.
    s.setNow(13_000); s.emit([{ ...tick('crude', 10_000, 5400), timestamp: 13_000 }]);
    expect(s.feed.underlying('MCX_FO:crude')).toEqual({ price: 5400, at: 10_000 });
    // A book on a late tick is still not a usable quote (2-second book freshness).
    s.emit([{ ...tick('crude', 10_500, 5401), timestamp: 13_000, bid: 5400, ask: 5401, bidQty: 100, askQty: 100 }]);
    expect(s.feed.quote('MCX_FO:crude', 1)).toBeNull();
    // > 10 s late: dropped.
    s.setNow(30_000); s.emit([{ ...tick('crude', 30_000 - FRESH_TICK_MAX_LAG_MS - 1, 5390), timestamp: 30_000 }]);
    expect(s.feed.tickLagStats()['MCX_FO']).toMatchObject({ ticks: 3, late: 2, dropped: 1 });
    // Exchange time 500 ms ahead of receipt: clock skew, read as the receive time.
    s.setNow(31_000); s.emit([{ ...tick('crude', 31_500, 5395), timestamp: 31_000 }]);
    expect(s.feed.underlying('MCX_FO:crude')).toEqual({ price: 5395, at: 31_000 });
  });
});
