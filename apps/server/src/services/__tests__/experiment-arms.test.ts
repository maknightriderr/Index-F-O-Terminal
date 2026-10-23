import { describe, it, expect } from 'vitest';
import {
  ARMS,
  RETIRED_ARMS,
  armFor,
  armCooldownCode,
  armEntryDecision,
  fillBlocker,
  officialNetR,
  onDecisionRead,
  onQuote,
  onSessionEnd,
  openPosition,
  plannedTargetR,
  simNetR,
  type ExpCandidate,
  type ExpQuote,
} from '../experiment-arms.js';

const T0 = Date.UTC(2026, 9, 26, 5, 0); // 10:30 IST
const arm = (id: string) => ARMS.find((a) => a.id === id)!;
const q = (o: Partial<ExpQuote> = {}, at = T0): ExpQuote => ({ ltp: 100, bid: 99.5, ask: 100.5, bidQty: 1000, askQty: 1000, exchangeAt: at - 1000, receivedAt: at, feedState: null, source: 'CHAIN', ...o });
const cand = (o: Partial<ExpCandidate> = {}): ExpCandidate => ({
  at: T0, candidateId: 'IND:NSE:TCS:INTRADAY:BULLISH:2026-10-26', symbol: 'TCS', exchange: 'NSE', mode: 'INTRADAY', direction: 'BULLISH', confidence: 70,
  side: 'CE', strike: 2400, expiry: '2026-10-27', token: '43210', lotSize: 175, entry: 100, stop: 70, target: 120, costPct: 2.5, statutoryPct: 0.15,
  brokeragePerLotInr: 47.2, minutesSinceOpen: 120, behindLevel: 2380, atr: 10, quote: q(), ...o,
});

describe('arm entry rules: the same candidate, each arm its own decision', () => {
  it('A refuses a target under 0.5R; B refuses NSE/BSE 240+ min after the open; C both; R0 and V2 take', () => {
    const low = cand({ target: 110 }); // 10 / 30 = 0.33R
    const late = cand({ minutesSinceOpen: 250 });
    expect(plannedTargetR(low)).toBeCloseTo(0.333, 3);
    expect(armEntryDecision(arm('A'), low, false, [], T0, '2026-10-26')).toEqual({ take: false, code: 'TARGET_BELOW_0_5R' });
    expect(armEntryDecision(arm('B'), late, false, [], T0, '2026-10-26')).toEqual({ take: false, code: 'LATE_NSE_BSE_ENTRY' });
    expect(armEntryDecision(arm('B'), cand({ exchange: 'MCX', minutesSinceOpen: 600 }), false, [], T0, '2026-10-26').take).toBe(true);
    expect(armEntryDecision(arm('C'), late, false, [], T0, '2026-10-26').code).toBe('LATE_NSE_BSE_ENTRY');
    for (const id of ['R0', 'V2']) expect(armEntryDecision(arm(id), low, false, [], T0, '2026-10-26').take).toBe(true);
  });
  it('positional is out of scope; an arm-held slot refuses only that arm', () => {
    expect(armEntryDecision(arm('R0'), cand({ mode: 'POSITIONAL' }), false, [], T0, '2026-10-26').code).toBe('NOT_IN_SCOPE_POSITIONAL');
    expect(armEntryDecision(arm('R0'), cand(), true, [], T0, '2026-10-26').code).toBe('ARM_SLOT_HELD');
    expect(armEntryDecision(arm('A'), cand(), false, [], T0, '2026-10-26').take).toBe(true);
  });
  it("cooldowns come from the arm's OWN stop-outs (the baseline's rules, not its state)", () => {
    const loss = { at: T0 - 5 * 60_000, day: '2026-10-26', exchange: 'NSE', symbol: 'INFY', mode: 'INTRADAY', direction: 'BEARISH', positionId: 'x' };
    expect(armCooldownCode([loss], cand(), T0, '2026-10-26')).toBe('POST_LOSS_COOLDOWN'); // 15-min settle, any symbol
    const older = { ...loss, at: T0 - 30 * 60_000 };
    expect(armCooldownCode([older], cand({ confidence: 70 }), T0, '2026-10-26')).toBe('POST_LOSS_COOLDOWN'); // day bar 80
    expect(armCooldownCode([older], cand({ confidence: 85 }), T0, '2026-10-26')).toBeNull();
    const same = { ...older, symbol: 'TCS', direction: 'BULLISH' };
    expect(armCooldownCode([same], cand({ confidence: 85 }), T0, '2026-10-26')).toBe('SAME_SYMBOL_SIDE');
    expect(armCooldownCode([same, { ...same, at: T0 - 90 * 60_000 }], cand({ confidence: 85 }), T0, '2026-10-26')).toBe('DIRECTION_LOCKED');
    expect(armCooldownCode([], cand(), T0, '2026-10-26')).toBeNull();
  });
});

describe('simulated execution: estimates need a fresh two-sided book with the size', () => {
  it('quantity, age and depth requirements', () => {
    expect(fillBlocker(q(), 'BUY', 175, T0)).toBeNull();
    expect(fillBlocker(q({ askQty: 100 }), 'BUY', 175, T0)).toBe('SIZE_INSUFFICIENT');
    expect(fillBlocker(q({ askQty: null }), 'BUY', 175, T0)).toBe('SIZE_UNKNOWN');
    expect(fillBlocker(q({ exchangeAt: T0 - 61_000 }), 'BUY', 175, T0)).toBe('STALE_QUOTE');
    expect(fillBlocker(q({ exchangeAt: null, receivedAt: T0 - 16_000 }), 'BUY', 175, T0)).toBe('STALE_QUOTE_AGE_UNKNOWN');
    expect(fillBlocker(q({ bid: null }), 'SELL', 175, T0)).toBe('ONE_SIDED_OR_NO_QUOTE');
    expect(fillBlocker(q({ feedState: 'DATA_GAP' }), 'SELL', 175, T0)).toBe('FEED_NOT_FRESH');
  });
  it('an entry the book cannot support is NOT_OPENED for the simulation (the official ledger still opens)', () => {
    const p = openPosition(arm('R0'), cand({ quote: q({ askQty: null }) }), 'p1', T0);
    expect(p.official.status).toBe('OPEN');
    expect(p.sim).toMatchObject({ status: 'NOT_OPENED', entryPrice: null, reason: 'ENTRY_UNAVAILABLE:SIZE_UNKNOWN' });
  });
});

describe('the official target closes on LTP; the simulated target cannot fill — the simulation keeps observing', () => {
  it('stays OPEN after the official TARGET, then exits on its own valid rule', () => {
    const p = openPosition(arm('R0'), cand(), 'p2', T0);
    expect(p.sim).toMatchObject({ status: 'OPEN', entryPrice: 100.5 });
    // LTP prints the target, but the best bid is below it: official books the limit (FILL-1.0), the simulation cannot.
    let ev = onQuote(p, q({ ltp: 120.5, bid: 119.6, ask: 120.6 }, T0 + 60_000), T0 + 60_000);
    expect(ev).toContain('OFFICIAL_TARGET');
    expect(p.official).toMatchObject({ status: 'CLOSED', exitPrice: 120, reason: 'TARGET' });
    expect(p.sim.status).toBe('OPEN');
    // Trailing moved the stop to breakeven at +1R? (+20 < 30: no) — price falls back through the original stop.
    ev = onQuote(p, q({ ltp: 69, bid: 68.5, ask: 69.5, bidQty: 50 }, T0 + 120_000), T0 + 120_000);
    expect(ev).toContain('SIM_STOP_TRIGGERED');
    expect(p.sim.status).toBe('EXIT_PENDING'); // the bid lacks the size: no fill yet
    ev = onQuote(p, q({ ltp: 68, bid: 67.5, ask: 68.5 }, T0 + 180_000), T0 + 180_000);
    expect(p.sim).toMatchObject({ status: 'CLOSED', exitPrice: 67.5, exitBasis: 'MARKETABLE_BID', reason: 'STOP_LOSS' });
    expect(p.official.netR).toBeCloseTo(officialNetR(p, 120), 6);
    expect(p.sim.netR).toBeCloseTo(simNetR(p, 67.5)!, 6);
  });
  it('a resting limit fills only when the BID reaches the target, with the size', () => {
    const p = openPosition(arm('R0'), cand(), 'p3', T0);
    onQuote(p, q({ ltp: 121, bid: 120.1, ask: 121, bidQty: 100 }, T0 + 60_000), T0 + 60_000);
    expect(p.sim.status).toBe('OPEN'); // bid >= target but only 100 of 175
    onQuote(p, q({ ltp: 121, bid: 120.2, ask: 121 }, T0 + 90_000), T0 + 90_000);
    expect(p.sim).toMatchObject({ status: 'CLOSED', exitPrice: 120, exitBasis: 'RESTING_LIMIT_BID_REACHED', reason: 'TARGET' });
    // simulated R: (120 - 100.5 ask - fees) / 30; official R: (20% - 2.5%) / 30%
    expect(p.sim.netR!).toBeCloseTo((120 - 100.5 - (100 * 0.15) / 100 - 47.2 / 175) / 30, 6);
  });
  it('at the session end an unfilled exit is UNRESOLVED, never a fill from an old quote', () => {
    const close = T0 + 5 * 3600_000;
    const p = openPosition(arm('R0'), cand(), 'p4', T0);
    onQuote(p, q({ ltp: 101, bid: 100.6, ask: 101.4 }, close - 30 * 60_000), close - 30 * 60_000); // last quote 30 min before the close
    const ev = onSessionEnd(p, close);
    expect(ev).toEqual(['OFFICIAL_SESSION_ENDED', 'SIM_UNRESOLVED']);
    expect(p.official).toMatchObject({ status: 'CLOSED', exitPrice: 101, reason: 'SESSION_ENDED' });
    expect(p.sim).toMatchObject({ status: 'UNRESOLVED', netR: null, lastValidBid: 100.6 });
    const p2 = openPosition(arm('R0'), cand(), 'p5', T0);
    onQuote(p2, q({ ltp: 101, bid: 100.6, ask: 101.4 }, close - 3 * 60_000), close - 3 * 60_000); // inside the final 10 minutes
    expect(onSessionEnd(p2, close)).toEqual(['OFFICIAL_SESSION_ENDED', 'SIM_EXIT_FILLED']);
    expect(p2.sim).toMatchObject({ status: 'CLOSED', exitPrice: 100.6, reason: 'SESSION_ENDED' });
  });
});

describe('exits on later reads', () => {
  const read = (o: object) => ({ at: T0 + 30 * 60_000, direction: 'BULLISH', confidence: 70, minConfidence: 60, confirmMs: 300_000, lastClosedBar: null, ...o });
  it('V2 exits when a closed 15m bar closes beyond the structural level behind (+0.25 ATR); R0 does not', () => {
    const bar = { close: 2377, closeAt: T0 + 30 * 60_000 }; // level 2380 - 0.25 x 10 = 2377.5 -> broken
    const v2 = openPosition(arm('V2'), cand(), 'v', T0);
    const r0 = openPosition(arm('R0'), cand(), 'r', T0);
    expect(onDecisionRead(v2, arm('V2'), read({ lastClosedBar: bar }))).toContain('OFFICIAL_STRUCTURE_INVALIDATED');
    expect(v2.official.reason).toBe('STRUCTURE_INVALIDATED');
    expect(onDecisionRead(r0, arm('R0'), read({ lastClosedBar: bar }))).toEqual([]);
    const notYet = openPosition(arm('V2'), cand(), 'w', T0);
    expect(onDecisionRead(notYet, arm('V2'), read({ lastClosedBar: { close: 2378, closeAt: T0 + 30 * 60_000 } }))).toEqual([]);
    const beforeEntry = openPosition(arm('V2'), cand(), 'z', T0);
    expect(onDecisionRead(beforeEntry, arm('V2'), read({ lastClosedBar: { close: 2300, closeAt: T0 - 60_000 } }))).toEqual([]);
  });
  it('a bias reversal needs two confident opposite reads across the confirm window', () => {
    const p = openPosition(arm('R0'), cand(), 'b', T0);
    expect(onDecisionRead(p, arm('R0'), read({ at: T0 + 60_000, direction: 'BEARISH', confidence: 75 }))).toEqual([]);
    expect(onDecisionRead(p, arm('R0'), read({ at: T0 + 120_000, direction: 'BEARISH', confidence: 75 }))).toEqual([]); // inside 5 min
    expect(onDecisionRead(p, arm('R0'), read({ at: T0 + 400_000, direction: 'BEARISH', confidence: 75 }))).toContain('OFFICIAL_BIAS_REVERSED');
  });
  it('trailing: breakeven at +1R, entry + 1R at +2R; never loosens', () => {
    const p = openPosition(arm('R0'), cand({ target: 200 }), 't', T0);
    onQuote(p, q({ ltp: 131, bid: 130.5, ask: 131.5 }), T0 + 1);
    expect(p.stop).toBe(100);
    onQuote(p, q({ ltp: 161, bid: 160.5, ask: 161.5 }), T0 + 2);
    expect(p.stop).toBe(130);
    onQuote(p, q({ ltp: 140, bid: 139.5, ask: 140.5 }), T0 + 3);
    expect(p.stop).toBe(130);
  });
});

describe('EXP-3.0 trigger capture arms (A3R, OF1R)', () => {
  const read = (o: object) => ({ at: T0 + 30 * 60_000, direction: 'BEARISH', confidence: 90, minConfidence: 60, confirmMs: 0, lastClosedBar: null, ...o });
  it('the Indicator arms are unchanged: same versions, bias-reversal exit, no structural exit', () => {
    expect(ARMS.filter((a) => a.source === 'INDICATOR').map((a) => a.version)).toEqual(['R0-REPLICA-1.0', 'A-TARGET-0.5R-1.0', 'B-NO-LATE-NSE-1.0', 'C-A-AND-B-1.0', 'IND-V2-INVALIDATION-1.0']);
    expect(ARMS.filter((a) => a.source === 'INDICATOR').every((a) => a.biasReversalExit && !a.structureExit)).toBe(true);
    expect(ARMS.filter((a) => a.source !== 'INDICATOR').map((a) => [a.id, a.version, a.kind, a.source])).toEqual([['A3R', 'A3-R0-1.1', 'CONTROL_REPLICA', 'A3'], ['OF1R', 'OF1-R0-1.1', 'CONTROL_REPLICA', 'OF1']]);
    expect(ARMS.filter((a) => a.source === 'INDICATOR').every((a) => !a.triggerReversalExit)).toBe(true); // EXP-2.0 arms as activated
  });
  it('SWEEP_RECLAIMED: a bar closing after entry back beyond the sweep extreme exits a trigger arm; a bias read never does', () => {
    const p = openPosition(arm('A3R'), cand({ sweepExtreme: 2385, triggerId: 'A3' }), 's1', T0);
    expect(onDecisionRead(p, arm('A3R'), read({ lastClosedBar: null }))).toEqual([]); // confident opposite read: no BIAS_REVERSED
    expect(onDecisionRead(p, arm('A3R'), read({ at: T0 + 400_000, lastClosedBar: null }))).toEqual([]);
    expect(onDecisionRead(p, arm('A3R'), read({ lastClosedBar: { close: 2386, closeAt: T0 + 30 * 60_000 } }))).toEqual([]);
    expect(onDecisionRead(p, arm('A3R'), read({ lastClosedBar: { close: 2384, closeAt: T0 + 45 * 60_000 } }))).toContain('OFFICIAL_SWEEP_RECLAIMED');
    expect(p.official.reason).toBe('SWEEP_RECLAIMED');
    const bear = openPosition(arm('OF1R'), cand({ direction: 'BEARISH', side: 'PE', sweepExtreme: 2420, triggerId: 'OF1' }), 's2', T0);
    expect(onDecisionRead(bear, arm('OF1R'), read({ lastClosedBar: { close: 2421, closeAt: T0 + 15 * 60_000 } }))).toContain('OFFICIAL_SWEEP_RECLAIMED');
    const before = openPosition(arm('A3R'), cand({ sweepExtreme: 2385 }), 's3', T0);
    expect(onDecisionRead(before, arm('A3R'), read({ lastClosedBar: { close: 2300, closeAt: T0 - 60_000 } }))).toEqual([]);
  });
});

describe('EXP-3.1: TRIGGER_REVERSAL on the trigger arms (production triggerSlotAction)', () => {
  const read = (o: object = {}) => ({ at: T0 + 30 * 60_000, direction: 'NEUTRAL', confidence: 0, minConfidence: 60, confirmMs: 0, lastClosedBar: null, ...o });
  it('a fresh trigger the other way closes a held A3R / OF1R trade; one the same way does not', () => {
    const p = openPosition(arm('A3R'), cand({ sweepExtreme: 2385, triggerId: 'A3' }), 't1', T0);
    expect(onDecisionRead(p, arm('A3R'), read({ freshTriggers: [{ direction: 'BULLISH' }] }))).toEqual([]);
    expect(onDecisionRead(p, arm('A3R'), read({ freshTriggers: [{ direction: 'BEARISH' }] }))).toContain('OFFICIAL_TRIGGER_REVERSAL');
    expect(p.official.reason).toBe('TRIGGER_REVERSAL');
    const bear = openPosition(arm('OF1R'), cand({ direction: 'BEARISH', side: 'PE', sweepExtreme: 2420, triggerId: 'OF1' }), 't2', T0);
    expect(onDecisionRead(bear, arm('OF1R'), read({ freshTriggers: [{ direction: 'BULLISH' }] }))).toContain('OFFICIAL_TRIGGER_REVERSAL');
  });
  it('SWEEP_RECLAIMED is judged first, as in production', () => {
    const p = openPosition(arm('A3R'), cand({ sweepExtreme: 2385 }), 't3', T0);
    onDecisionRead(p, arm('A3R'), read({ lastClosedBar: { close: 2384, closeAt: T0 + 15 * 60_000 }, freshTriggers: [{ direction: 'BEARISH' }] }));
    expect(p.official.reason).toBe('SWEEP_RECLAIMED');
  });
  it('the Indicator arms and the retired 1.0 trigger arms keep their rules: no TRIGGER_REVERSAL', () => {
    for (const a of [...ARMS.filter((x) => x.source === 'INDICATOR'), ...RETIRED_ARMS]) {
      const p = openPosition(a, cand({ sweepExtreme: 2385 }), 'r-' + a.id, T0);
      expect(onDecisionRead(p, a, read({ freshTriggers: [{ direction: 'BEARISH' }] }))).not.toContain('OFFICIAL_TRIGGER_REVERSAL');
    }
  });
  it('a position resolves to the version it was opened under', () => {
    expect(armFor('A3R', 'A3-R0-1.0')?.triggerReversalExit).toBe(false);
    expect(armFor('A3R', 'A3-R0-1.1')?.triggerReversalExit).toBe(true);
    expect(armFor('R0', 'R0-REPLICA-1.0')?.biasReversalExit).toBe(true);
    expect(armFor('A3R', 'A3-R0-9.9')).toBeNull();
    expect(RETIRED_ARMS.map((a) => a.version)).toEqual(['A3-R0-1.0', 'OF1-R0-1.0']);
  });
});
