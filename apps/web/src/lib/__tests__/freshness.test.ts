import { describe, expect, it } from 'vitest';
import { FRESH_WITHIN_MS, classifyFreshness } from '../freshness';

const now = 1_000_000_000;
const base = { now, freshWithinMs: FRESH_WITHIN_MS.quote };

describe('classifyFreshness', () => {
  it('FRESH when observed inside the window in session', () => {
    expect(classifyFreshness({ ...base, observedAt: now - 10_000, sessionOpen: true }).state).toBe('FRESH');
  });
  it('STALE when in session and older than the window, transport unknown or up', () => {
    expect(classifyFreshness({ ...base, observedAt: now - 5 * 60_000, sessionOpen: true }).state).toBe('STALE');
    expect(classifyFreshness({ ...base, observedAt: now - 5 * 60_000, sessionOpen: true, transportConnected: true }).state).toBe('STALE');
  });
  it('DISCONNECTED when old and the transport is down', () => {
    expect(classifyFreshness({ ...base, observedAt: now - 5 * 60_000, sessionOpen: true, transportConnected: false }).state).toBe('DISCONNECTED');
  });
  it('a connected socket does not make an old value fresh', () => {
    expect(classifyFreshness({ ...base, observedAt: now - 60 * 60_000, sessionOpen: true, transportConnected: true }).state).not.toBe('FRESH');
  });
  it('UNAVAILABLE when never observed', () => {
    expect(classifyFreshness({ ...base, observedAt: null, sessionOpen: true }).state).toBe('UNAVAILABLE');
    expect(classifyFreshness({ ...base, observedAt: 0, sessionOpen: true }).state).toBe('UNAVAILABLE');
  });
  it('MARKET_CLOSED outside the session, even for a recent value, and says it is not live', () => {
    const r = classifyFreshness({ ...base, observedAt: now - 1000, sessionOpen: false });
    expect(r.state).toBe('MARKET_CLOSED');
    expect(r.detail).toMatch(/not a live update/);
  });
  it('a closed market is not a feed failure even when the transport is down', () => {
    expect(classifyFreshness({ ...base, observedAt: now - 3_600_000, sessionOpen: false, transportConnected: false }).state).toBe('MARKET_CLOSED');
  });
});
