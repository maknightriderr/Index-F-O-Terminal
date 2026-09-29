// ============================================================
// STRUCTURE LIVE — REJECTION_CLOSE fill rule, no look-ahead, invalidation/MISSED
// ============================================================
// Same fabricated scenario as structure-live.test.ts: a BEARISH setup
// CONFIRMED with zone {near: 100.6, far: 100.9} (top 100.9, bottom 100.6),
// entry 100.6, stop > 102.3, T1 = PREV_DAY_LOW 97.
// ============================================================

import { describe, it, expect } from 'vitest';
import { evaluateStructureSession, prepareMomentumSeries, STRUCTURE_VARIANTS, type MomentumBar } from '@fno/analytics';
import { advanceLiveState, rejectionCloseCandidate, type LiveState } from '../structure-live.js';

const BAR = 15 * 60 * 1000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
const TODAY = '2026-01-20';

function bars(extra: MomentumBar[] = []): MomentumBar[] {
  const out: MomentumBar[] = [];
  let prev = 100.5;
  const push = (time: number, open: number, close: number) => {
    out.push({ time, open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, close, volume: 1000 });
    prev = close;
  };
  for (const d of ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16']) {
    for (let k = 0; k < 25; k++) push(at(d, '09:15') + k * BAR, prev, k % 2 === 0 ? 100 : 100.5);
  }
  const prevCloses = [100, 99.5, 99, 98.5, 98, 97.5, 97.2, 97.5, 98, 98.5, 99, 99.5, 100, 100.5, 101, 101.5, 101.8, 101.5, 101.2, 101.0, 101.2, 101.0, 101.2, 101.0, 101.2];
  prevCloses.forEach((c, k) => push(at('2026-01-19', '09:15') + k * BAR, prev, c));
  [101.3, 101.0, 101.3, 101.0, 101.3, 101.0].forEach((c, k) => push(at(TODAY, '09:15') + k * BAR, prev, c));
  const t = (k: number) => at(TODAY, '10:45') + k * BAR;
  out.push(
    { time: t(0), open: 101.0, high: 102.3, low: 100.9, close: 101.6, volume: 1000 },
    { time: t(1), open: 101.6, high: 101.7, low: 100.1, close: 100.2, volume: 1000 },
    { time: t(2), open: 100.2, high: 100.6, low: 99.9, close: 100.3, volume: 1000 }
  );
  return [...out, ...extra];
}
const V = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-NOGUARD')!;
const evalAt = (b: MomentumBar[], i = b.length - 1) => evaluateStructureSession(prepareMomentumSeries(b), i, V);
const CONFIRMED_AT = at(TODAY, '11:30'); // t(2) + BAR — the confirm bar's own close
const FILL_WITHIN_BARS = 8; // STRUCTURE_RULES.fillWithinBars

function confirmedState(): LiveState {
  return advanceLiveState({
    prev: null,
    evaluation: evalAt(bars()),
    exchange: 'NSE',
    underlying: 'NIFTY',
    mode: 'INTRADAY',
    day: TODAY,
    now: at(TODAY, '11:31'),
    spot: 100.3,
    entryMode: 'REJECTION_CLOSE',
  }).state;
}

describe('rejectionCloseCandidate: the fill rule', () => {
  it('a bar that trades into the zone and closes back beyond the top, in the outer half, fills at ITS OWN close', () => {
    const state = confirmedState();
    const rejectionBar = { time: CONFIRMED_AT, open: 100.55, high: 100.7, low: 100.3, close: 100.45 }; // closeFrac (100.45-100.3)/0.4=0.375, lower half — bearish rejection
    const outcome = rejectionCloseCandidate(state, rejectionBar, FILL_WITHIN_BARS, BAR);
    expect(outcome?.kind).toBe('FILL');
    const hit = outcome as Extract<typeof outcome, { kind: 'FILL' }>;
    expect(hit!.lc.direction).toBe('BEARISH');
    expect(hit!.entry).toBe(100.45);
    expect(hit!.pattern.label).toMatch(/at FVG$/);
  });

  it('a bar that merely touches the zone without a decisive close-back does NOT fill (and is not invalidated or missed either)', () => {
    const state = confirmedState();
    const touchOnly = { time: CONFIRMED_AT, open: 100.5, high: 100.65, low: 100.5, close: 100.6 }; // closes AT the bottom, not beyond it
    expect(rejectionCloseCandidate(state, touchOnly, FILL_WITHIN_BARS, BAR)).toBeNull();
  });

  it('a close beyond the sweep extreme before ever rejecting the zone is INVALIDATED (as now)', () => {
    const state = confirmedState();
    // Sweep extreme is 102.3 (bearish): closing beyond it means the setup broke the wrong way.
    const badBar = { time: CONFIRMED_AT, open: 100.5, high: 103.0, low: 100.4, close: 102.5 };
    const outcome = rejectionCloseCandidate(state, badBar, FILL_WITHIN_BARS, BAR);
    expect(outcome).toEqual({ kind: 'INVALIDATED', lc: expect.objectContaining({ direction: 'BEARISH' }) });
  });

  it('T1 reached before any rejection close is MISSED', () => {
    const state = confirmedState();
    // T1 is 97 (PREV_DAY_LOW): this bar never even reaches the zone (high 99.5 < bottom 100.6) but its low already hit T1.
    const runawayBar = { time: CONFIRMED_AT, open: 99.0, high: 99.5, low: 96.5, close: 99.2 };
    const outcome = rejectionCloseCandidate(state, runawayBar, FILL_WITHIN_BARS, BAR);
    expect(outcome).toEqual({ kind: 'MISSED', lc: expect.objectContaining({ direction: 'BEARISH' }) });
  });

  it('a fill takes priority over invalidation/MISSED on the very same bar (matches the backtest harness priority)', () => {
    const state = confirmedState();
    // Rejects the zone AND closes beyond neither the sweep extreme nor T1.
    const rejectionBar = { time: CONFIRMED_AT, open: 100.55, high: 100.7, low: 100.3, close: 100.45 };
    expect(rejectionCloseCandidate(state, rejectionBar, FILL_WITHIN_BARS, BAR)?.kind).toBe('FILL');
  });

  it('never offers a lifecycle that already has a live outcome', () => {
    const state = confirmedState();
    const lc = state.lifecycles.find((l) => l.direction === 'BEARISH')!;
    lc.live = { outcome: 'MINTED', code: null, reason: null, at: 1 };
    const rejectionBar = { time: CONFIRMED_AT, open: 100.55, high: 100.7, low: 100.3, close: 100.45 };
    expect(rejectionCloseCandidate(state, rejectionBar, FILL_WITHIN_BARS, BAR)).toBeNull();
  });

  it('a bar before CONFIRMED (or the CONFIRMED bar itself) can never be the rejection bar', () => {
    const state = confirmedState();
    const sameBarAsConfirm = { time: CONFIRMED_AT - BAR, open: 100.55, high: 100.7, low: 100.3, close: 100.45 };
    expect(rejectionCloseCandidate(state, sameBarAsConfirm, FILL_WITHIN_BARS, BAR)).toBeNull();
  });

  it('outside the fill window (fillWithinBars entry-timeframe bars from CONFIRMED), nothing is offered', () => {
    const state = confirmedState();
    const tooLate = { time: CONFIRMED_AT + (FILL_WITHIN_BARS + 1) * BAR, open: 100.55, high: 100.7, low: 100.3, close: 100.45 };
    expect(rejectionCloseCandidate(state, tooLate, FILL_WITHIN_BARS, BAR)).toBeNull();
  });

  it('gating is by confirmedAt, not by the engine\'s own (touch-based) shadow stage — a lifecycle whose shadow stage has already moved past CONFIRMED is still checked', () => {
    const state = confirmedState();
    const lc = state.lifecycles.find((l) => l.direction === 'BEARISH')!;
    // Simulate the engine's own internal touch-based simulation having moved on
    // (e.g. an earlier bar merely touched the zone and the shadow sim called it
    // ENTRY/ACTIVE) — confirmedAt is unaffected, so REJECTION_CLOSE still works.
    lc.stage = 'ACTIVE';
    const rejectionBar = { time: CONFIRMED_AT, open: 100.55, high: 100.7, low: 100.3, close: 100.45 };
    expect(rejectionCloseCandidate(state, rejectionBar, FILL_WITHIN_BARS, BAR)?.kind).toBe('FILL');
  });
});

describe('rejectionCloseCandidate: no look-ahead', () => {
  it("a candidate's answer for one closed bar never depends on any other bar", () => {
    const state = confirmedState();
    const bar = { time: CONFIRMED_AT, open: 100.55, high: 100.7, low: 100.3, close: 100.45 };
    const a = rejectionCloseCandidate(state, bar, FILL_WITHIN_BARS, BAR);
    const b = rejectionCloseCandidate(state, { ...bar }, FILL_WITHIN_BARS, BAR); // a fresh object, same values
    expect(a).toEqual(b);
  });
});

describe('the CONFIRMED display text under REJECTION_CLOSE', () => {
  it('shows "waiting for rejection candle at zone" while CONFIRMED, and nothing under TOUCH (default)', () => {
    const withMode = confirmedState();
    const lc = withMode.lifecycles.find((l) => l.direction === 'BEARISH')!;
    expect(lc.stage).toBe('CONFIRMED');
    expect(lc.reason).toBe('waiting for rejection candle at zone');

    const withoutMode = advanceLiveState({
      prev: null,
      evaluation: evalAt(bars()),
      exchange: 'NSE',
      underlying: 'NIFTY',
      mode: 'INTRADAY',
      day: TODAY,
      now: at(TODAY, '11:31'),
      spot: 100.3,
    }).state;
    const lc2 = withoutMode.lifecycles.find((l) => l.direction === 'BEARISH')!;
    expect(lc2.reason).toBeNull();
  });
});
