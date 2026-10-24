// ============================================================
// OB1 TIMEFRAME TEST: 15m order blocks vs 1H order blocks with a 15m entry
// (pre-registered, research only, read-only; user request 2026-10-25)
// ============================================================
// Question: for an intraday option trader, does OB1 do better when the order
// block is found on 1-hour bars (entered on the 15m first touch) than with
// today's 15-minute blocks? Everything below was fixed BEFORE any result was
// looked at; nothing is tuned afterwards.
//
//   ARM 15m (control, = live OB1, OB-2.0): blocks from detectOrderBlocks on
//     closed 15m bars; the decision is the first 15m bar to touch a FRESH
//     block, not closing beyond its far edge (orderBlockSignalAt's rule, the
//     newest displacement winning). Blocks older than 10 calendar days are
//     ignored: live only reads 10 days of 15m bars (market-bias.ts from15m).
//   ARM 1H (the hypothesis): the SAME OB-2.0 rule (ATR(14), displacement
//     within 3 bars, body >= 1 ATR, close in the outer 30%, beyond the block)
//     on closed 1-hour bars, built from the 15m bars per session hour from
//     the session open (NSE 09:15, 10:15, ... 15:15; MCX 09:00, ...; the last
//     hour may be short), as broker 1H candles are. A block exists once its
//     displacement HOUR has closed. The decision is the first 15m bar after
//     that to touch it, not closing beyond its far edge. Blocks older than 30
//     calendar days are ignored (live reads 30 days of 1H bars).
//
// Both arms then go through the SAME live code: buildCandidate (entry = the
// decision bar's close, stop = the far edge -/+ 0.1 ATR(15m), T1 / T2 = the
// nearest untaken opposite pools, the 1.5R floor -> TRADE / LOW_RR /
// NO_TARGET), the live session guards (no decision in the first 5 minutes,
// no new entry in the last 60), masked sessions (thin data / futures roll)
// skipped, one trade at a time per symbol, and multipath's grading (gradePath
// to T1 or the stop, stop first when both share a bar, forced exit at the
// session's last bar). Costs are the sweep-close report's modelled option cost.
//
// Simplifications, the same for both arms (so the comparison is fair, and the
// absolute numbers are not the live paper ledger's): the exit is T1 / stop /
// session end only (no T2, trail or close-basis mitigation exit), and each
// arm is measured on its own (no slot arbitration with other families).
//
// LOOK-AHEAD CONTRACT: a decision at 15m bar i reads 15m bars <= i only (a 1H
// bar is used only once all its 15m bars are <= i). ob-timeframe-lookahead
// .test.ts truncates the series at i and checks the same signal comes out.
// ============================================================

import {
  buildCandidate,
  buildSeriesContext,
  detectOrderBlocks,
  runSessionEvents,
  type MarketEvent,
  type MomentumSeries,
  type OrderBlockV2,
  type TriggerCandidate,
  type TriggerDefinition,
  type TriggerFamily,
} from '@fno/analytics';
import { getSessionWindow, type Exchange } from '@fno/shared';
import type { LoadedSymbol } from '../backtest/harness.js';
import { decisionAllowed, gradeTrigger, type GradedCandidate, type MultiPathRun } from './multipath.js';

export type ObArm = '15m' | '1H';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
/** The live lookback each arm's bars come from (market-bias.ts from15m / from1h, INTRADAY). */
export const OB_MAX_AGE_DAYS: Record<ObArm, number> = { '15m': 10, '1H': 30 };

/** One OB signal at a 15m decision bar, in 15m indices. */
export interface ObSignal {
  arm: ObArm;
  decisionIndex: number;
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  /** First 15m bar of the block candle (the 15m block itself, or its hour's first 15m bar). */
  blockStartIndex: number;
  blockTime: number;
  /** The block candle's ATR(14) on its own timeframe. */
  blockAtr: number;
}

export interface HourBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  firstSub: number;
  lastSub: number;
}

/** 1H bars from the 15m series: each session hour counted from the session open (the last one may be short). */
export function hourlyBars(series: MomentumSeries, exchange: Exchange): HourBar[] {
  const out: HourBar[] = [];
  const bars = series.bars;
  for (let s = 0; s < series.sessionStarts.length; s++) {
    const w = getSessionWindow(exchange, series.sessionDates[s]);
    if (!w) continue;
    const end = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : bars.length) - 1;
    let cur: HourBar | null = null;
    let curKey = -1;
    for (let k = series.sessionStarts[s]; k <= end; k++) {
      const key = Math.floor((bars[k].time - w.open) / HOUR_MS);
      if (key !== curKey) {
        if (cur) out.push(cur);
        curKey = key;
        cur = { time: w.open + key * HOUR_MS, open: bars[k].open, high: bars[k].high, low: bars[k].low, close: bars[k].close, firstSub: k, lastSub: k };
      } else if (cur) {
        cur.high = Math.max(cur.high, bars[k].high);
        cur.low = Math.min(cur.low, bars[k].low);
        cur.close = bars[k].close;
        cur.lastSub = k;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** The touch / no-close-beyond rule on one 15m bar. */
const touches = (b: { low: number; high: number }, type: 'BULLISH' | 'BEARISH', top: number, bottom: number) => (type === 'BULLISH' ? b.low <= top : b.high >= bottom);
const closesBeyond = (b: { close: number }, type: 'BULLISH' | 'BEARISH', top: number, bottom: number) => (type === 'BULLISH' ? b.close < bottom : b.close > top);

/**
 * Every signal of one arm over the whole series, keyed by 15m decision index.
 * One detection pass over the full history; equivalent to orderBlockSignalAt
 * per bar for the 15m arm (OB-2.0 detection and ATR read only bars <= the
 * displacement; the parity test holds this), plus the live lookback age.
 */
export function obSignals(series: MomentumSeries, exchange: Exchange, arm: ObArm): Map<number, ObSignal> {
  const bars = series.bars;
  const maxAge = OB_MAX_AGE_DAYS[arm] * DAY_MS;
  // Candidates at each decision index, with the displacement ordinal (newest wins, the first found on ties).
  const at = new Map<number, Array<{ sig: ObSignal; disp: number }>>();
  const push = (i: number, sig: ObSignal, disp: number) => {
    if (bars[i].time - sig.blockTime > maxAge) return;
    const list = at.get(i) ?? [];
    list.push({ sig, disp });
    at.set(i, list);
  };

  if (arm === '15m') {
    for (const b of detectOrderBlocks(bars)) {
      const i = b.firstTouchIndex;
      if (i == null || b.mitigatedIndex === i) continue;
      push(i, sigOf('15m', i, b, b.blockIndex, bars[b.blockIndex].time), b.displacementIndex);
    }
  } else {
    const hours = hourlyBars(series, exchange);
    for (const b of detectOrderBlocks(hours)) {
      const from = hours[b.displacementIndex].lastSub + 1;
      for (let i = from; i < bars.length; i++) {
        if (!touches(bars[i], b.type, b.top, b.bottom)) continue;
        if (!closesBeyond(bars[i], b.type, b.top, b.bottom)) push(i, sigOf('1H', i, b, hours[b.blockIndex].firstSub, hours[b.blockIndex].time), b.displacementIndex);
        break; // only the first touch is a decision; the block is no longer FRESH after it
      }
    }
  }

  const out = new Map<number, ObSignal>();
  for (const [i, list] of at) out.set(i, list.reduce((a, b) => (b.disp > a.disp ? b : a)).sig);
  return out;
}

function sigOf(arm: ObArm, i: number, b: OrderBlockV2, blockStartIndex: number, blockTime: number): ObSignal {
  return { arm, decisionIndex: i, type: b.type, top: b.top, bottom: b.bottom, blockStartIndex, blockTime, blockAtr: b.atr };
}

const def = (triggerId: string) => ({ triggerId, family: 'ORDER_BLOCK' as unknown as TriggerFamily }) as TriggerDefinition;

/** The live OB1 candidate build (order-flow-candidates.ts) for one signal. */
function candidateOf(ctx: ReturnType<typeof buildSeriesContext>, log: ReturnType<typeof runSessionEvents>, sig: ObSignal, triggerId: string): TriggerCandidate | null {
  const level = sig.type === 'BULLISH' ? sig.top : sig.bottom;
  const anchor = { id: `ORDER_BLOCK:${sig.arm}:${sig.type}:${sig.blockTime}`, type: 'RECLAIM', barIndex: sig.blockStartIndex, time: sig.blockTime, availableAt: sig.blockTime + BAR_MS, direction: sig.type, price: level } as unknown as MarketEvent;
  const hit = { direction: sig.type, anchor, events: [], stopRef: sig.type === 'BULLISH' ? sig.bottom : sig.top };
  return buildCandidate(ctx, log, def(triggerId), hit as any, sig.decisionIndex);
}

export interface ObArmRun {
  arm: ObArm;
  symbol: string;
  run: MultiPathRun;
  signals: Map<number, ObSignal>;
  trades: GradedCandidate[];
  rejected: GradedCandidate[];
  /** Signals that were not a decision (session guard, masked session, no ATR yet). */
  skipped: { guard: number; masked: number; noCandidate: number };
}

export const armTriggerId = (arm: ObArm) => (arm === '15m' ? 'OB1_15M' : 'OB1_1H');

/** One arm over one symbol's history, graded one trade at a time. */
export function runObArm(symbol: string, loaded: LoadedSymbol, exchange: Exchange, arm: ObArm): ObArmRun {
  const { series, masked } = loaded;
  const ctx = buildSeriesContext(series);
  const signals = obSignals(series, exchange, arm);
  const triggerId = armTriggerId(arm);
  const candidates: TriggerCandidate[] = [];
  const skipped = { guard: 0, masked: 0, noCandidate: 0 };
  const bySession = new Map<number, ObSignal[]>();
  for (const sig of signals.values()) {
    const s = series.sessionIdx[sig.decisionIndex];
    bySession.set(s, [...(bySession.get(s) ?? []), sig]);
  }
  for (const [s, sigs] of [...bySession].sort((a, b) => a[0] - b[0])) {
    const session = series.sessionDates[s];
    if (masked.has(session)) {
      skipped.masked += sigs.length;
      continue;
    }
    if (ctx.atrAt(series.sessionStarts[s]) == null) {
      skipped.noCandidate += sigs.length;
      continue;
    }
    const log = runSessionEvents(ctx, s);
    for (const sig of sigs.sort((a, b) => a.decisionIndex - b.decisionIndex)) {
      if (!decisionAllowed(exchange, session, series.bars[sig.decisionIndex].time, ctx.barMs)) {
        skipped.guard++;
        continue;
      }
      const c = candidateOf(ctx, log, sig, triggerId);
      if (c) candidates.push(c);
      else skipped.noCandidate++;
    }
  }
  const run: MultiPathRun = { symbol, exchange, ctx, logs: new Map(), coverage: new Map(), candidates, parents: [], majorMoves: [] };
  const { trades, rejected } = gradeTrigger(run, triggerId);
  return { arm, symbol, run, signals, trades, rejected, skipped };
}
