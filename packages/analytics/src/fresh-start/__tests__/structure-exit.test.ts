// Dhan engine (master prompt Part 14) exit profile STRUCTURE, and the separate DHAN paper book (owner D4).
import { describe, expect, it } from 'vitest';
import { admitFreshPaper, advanceFreshPosition, freshAccountBook, freshAccountId, freshLastEntryGap, freshTrailingStop, type FreshPaperPosition, type FreshQuote } from '../paper.js';
import type { FreshCandidate } from '../strategies.js';
import { at, candidate, request } from './fixtures.js';

// Long, entry 100, structural stop 95 (R = 5), target 115.
const dhan: FreshCandidate = { ...candidate, strategy: 'DHAN_A_SWEEP_ABSORPTION', exitProfile: 'STRUCTURE' };
const q = (t: number, bid: number): FreshQuote => ({ ...request().quote, eventAt: t, receivedAt: t, bid, ask: bid + 0.5 });
const open = (c: FreshCandidate = dhan): FreshPaperPosition => {
  const r = request(); r.candidate = c;
  const a = admitFreshPaper(r);
  if (!a.ok) throw Error(a.code);
  return { id: 'd1', contract: r.contract, candidate: c, quantity: a.quantity, entry: a.entry, originalRiskCurrency: a.initialRiskCurrency, emergencyStop: a.emergencyStop, currentStop: a.emergencyStop, highBid: 100, openedAt: r.now, lastEventAt: r.now, state: 'OPEN', exitTriggeredAt: null, exitReason: null, exitPrice: null, netPnl: null, maxUnderlyingFavorable: 0 };
};
const step = (p: FreshPaperPosition, t: number, underlying: number, bars: number, close: number | null = null) =>
  advanceFreshPosition(p, { at: t, underlying, underlyingAt: t, quote: q(t, 100), cutoff: at + 14_400_000, barsSinceFill: bars, trail: false, underlyingClose: close == null ? null : { price: close, closedAt: t - 1 } });

describe('STRUCTURE exit profile (Part 14)', () => {
  it('no max-hold and no no-progress exit (the 5-minute strategies rules do not apply)', () => {
    expect(step(open(), at + 60_000, 99, 40).state).toBe('OPEN'); // 40 bars, under water, little progress
    expect(step(open({ ...candidate, strategy: 'NEW_ORB_RETEST_V1' }), at + 60_000, 99, 40)).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'MAX_HOLD' });
  });
  it('structural stop on a 5-minute close; target; no breakeven at +1R', () => {
    expect(step(open(), at + 60_000, 94, 2, 94.5)).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'STRUCTURAL_INVALIDATION' });
    expect(step(open(), at + 60_000, 115, 2)).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'UNDERLYING_TARGET' });
    // +1R reached (105), then back to 99 on a close: still open (the stop is not moved to breakeven).
    const p = step(open(), at + 60_000, 105, 1);
    expect(p.maxUnderlyingFavorable).toBe(5);
    expect(freshTrailingStop(p)).toBeNull();
    expect(step(p, at + 120_000, 99, 2, 99).state).toBe('OPEN');
  });
  it('from +1.5R trails 1R behind the best price, on a 5-minute close', () => {
    const p = step(open(), at + 60_000, 108, 1); // best +8 = 1.6R -> trail at 100 + 8 - 5 = 103
    expect(freshTrailingStop(p)).toBe(103);
    expect(step(p, at + 120_000, 103.5, 2, 103.5).state).toBe('OPEN');
    expect(step(p, at + 120_000, 102.9, 2, 102.9)).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'TRAILING_STOP' });
  });
});

describe('separate paper books', () => {
  it('DHAN_* strategies trade their own account per session', () => {
    expect(freshAccountId(dhan)).toBe(`${dhan.version}:DHAN:${dhan.session}`);
    expect(freshAccountId(candidate)).toBe(`${candidate.version}:${candidate.session}`);
    expect([freshAccountBook(freshAccountId(dhan)), freshAccountBook(freshAccountId(candidate))]).toEqual(['DHAN', 'FRESH']);
  });
});

describe('last entry before the cutoff (second audit)', () => {
  it('default one hour; a DHAN candidate 45 minutes; never under 10 minutes', () => {
    const near = (c: FreshCandidate) => { const r = request(); r.candidate = c; r.cutoff = at + 2_900_000; return admitFreshPaper(r); }; // 48 min left
    expect(near(candidate)).toEqual({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' });
    expect(near({ ...dhan, lastEntryBeforeCutoffMs: 2_700_000 }).ok).toBe(true);
    expect(freshLastEntryGap({ lastEntryBeforeCutoffMs: 60_000 })).toBe(600_000);
    expect(freshLastEntryGap({})).toBe(3_600_000);
  });
});
