// Expiry gamma (owner, 8 Nov): a premium-defined exit — 30% premium stop, 15:15 time exit, entries until 15:00, the
// expiry-day contract, |delta| 0.55-0.85 — and NOTHING else changes for every other candidate.
import { describe, expect, it } from 'vitest';
import { admitFreshPaper, advanceFreshPosition, type FreshPaperPosition, type FreshQuote } from '../paper.js';
import type { FreshCandidate } from '../strategies.js';
import { at, candidate, request } from './fixtures.js';

const pe = { stopFraction: 0.3, exitAt: at + 3_600_000, entryUntil: at + 1_800_000, minAbsDelta: 0.55, maxAbsDelta: 0.85, expiryDay: '2026-10-30' };
const gamma: FreshCandidate = { ...candidate, strategy: 'DHAN_EXPIRY_GAMMA', premiumExit: pe };
const req = (c: FreshCandidate = gamma) => { const r = request(); r.candidate = c; r.contract = { ...r.contract, expiryTradableSessions: c.premiumExit ? 0 : 3, delta: 0.7 }; return r; };
const q = (t: number, bid: number): FreshQuote => ({ ...request().quote, eventAt: t, receivedAt: t, bid, ask: bid + 0.5 });

describe('premium-defined exit admission', () => {
  it('risks 30% of the entry premium (stop at 70%), sizes on it, and needs no modeled payoff', () => {
    const a = admitFreshPaper(req());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.entry).toBe(101);
    expect(a.emergencyStop).toBe(71); // ceil(101 x 0.70 / 0.5) x 0.5 = 71
    expect(a.initialRiskPerUnit).toBeCloseTo((101 - 70.5) + 1, 6); // stop minus one exit tick, plus fees per unit
  });
  it('trades only the expiry-day contract, only index options, inside its delta band and entry window', () => {
    const r = req(); r.contract.expiryTradableSessions = 1;
    expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'EXPIRY_INELIGIBLE' });
    const s = req(); (s.contract as { market: string }).market = 'NSE_STOCK_OPTIONS';
    expect(admitFreshPaper(s)).toEqual({ ok: false, code: 'EXPIRY_INELIGIBLE' });
    const d = req(); d.contract.delta = 0.5;
    expect(admitFreshPaper(d)).toEqual({ ok: false, code: 'INVALID_CONTRACT' });
    const late = req({ ...gamma, premiumExit: { ...pe, entryUntil: at + 200 } });
    expect(admitFreshPaper(late)).toEqual({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' });
    // Within one hour of the cutoff a normal candidate is refused; the gamma one is not (its window ends at entryUntil).
    const near = req(); near.cutoff = at + 3_000_000;
    expect(admitFreshPaper(near).ok).toBe(true);
    const normal = request(); normal.cutoff = at + 3_000_000;
    expect(admitFreshPaper(normal)).toEqual({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' });
  });
  it('leaves every other candidate unchanged: 0DTE refused, delta 0.7 refused, 25% emergency stop', () => {
    const r = request(); r.contract = { ...r.contract, expiryTradableSessions: 0 };
    expect(admitFreshPaper(r)).toEqual({ ok: false, code: 'EXPIRY_INELIGIBLE' });
    const d = request(); d.contract = { ...d.contract, delta: 0.7 };
    expect(admitFreshPaper(d)).toEqual({ ok: false, code: 'INVALID_CONTRACT' });
    const a = admitFreshPaper(request());
    expect(a.ok && a.emergencyStop).toBe(76);
  });
});

describe('premium-defined exit monitoring', () => {
  const open = (): FreshPaperPosition => {
    const r = req(), a = admitFreshPaper(r);
    if (!a.ok) throw Error(a.code);
    return { id: 'g1', contract: r.contract, candidate: gamma, quantity: a.quantity, entry: a.entry, originalRiskCurrency: a.initialRiskCurrency, emergencyStop: a.emergencyStop, currentStop: a.emergencyStop, highBid: 100, openedAt: r.now, lastEventAt: r.now, state: 'OPEN', exitTriggeredAt: null, exitReason: null, exitPrice: null, netPnl: null, maxUnderlyingFavorable: 0 };
  };
  const step = (p: FreshPaperPosition, t: number, bid: number, underlying = 100, bars = 1) => advanceFreshPosition(p, { at: t, underlying, underlyingAt: t, quote: q(t, bid), cutoff: at + 14_400_000, barsSinceFill: bars, trail: true });
  it('exits on the 30% premium stop', () => {
    expect(step(open(), at + 60_000, 71)).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'PREMIUM_STOP' });
    expect(step(open(), at + 60_000, 72).state).toBe('OPEN');
  });
  it('ignores the underlying (model levels) and max-hold / no-progress, and never trails', () => {
    // Underlying far below the candidate's model stop (95) and past its model target (115): no exit.
    expect(step(open(), at + 60_000, 90, 80, 40).state).toBe('OPEN');
    expect(step(open(), at + 60_000, 120, 130, 40).state).toBe('OPEN');
    const p = step(open(), at + 60_000, 200);
    expect(p.currentStop).toBe(71); // a 2R+ bid does not ratchet the stop
  });
  it('closes at the time exit (15:15)', () => {
    expect(step(open(), pe.exitAt, 110)).toMatchObject({ state: 'EXIT_PENDING', exitReason: 'TIME_EXIT' });
  });
});
