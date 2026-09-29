// ============================================================
// MOMENTUM-BREAK — live wiring (pure parts)
// ============================================================
// The decisions the live engine makes around a momentum-break trigger, kept
// out of market-bias.ts so they can be tested without Redis or Postgres:
//
//   - turning broker candles into the detector's closed 15m bars;
//   - the trigger's refusal chain: the SAFETY gates only (risk-off, feed,
//     session/opening/closing, post-loss cooldown on the trigger's quality,
//     reliability, concurrency) plus TRIGGER_QUALITY. The consensus-only
//     gates (LOW_SETUP_QUALITY, POOR_LOCATION, INSUFFICIENT_ROOM,
//     POSITIONING_CONFLICT) are not in it — the target rule already decides
//     location;
//   - the premium stop handed to buildTradeSetup through its unprotected
//     slPremiumPct argument: max(0.15, |Δ|·stop distance / mid);
//   - what to do with the one shared sticky slot.
//
// Families share the slot `trade_setup:{ex}:{u}:{mode}`. The trigger
// families are MOMENTUM_BREAK and (structure round) STRUCTURE:
//   empty                                  → mint the trigger
//   same-direction setup (any family)      → nothing
//   opposite-direction setup               → close it TRIGGER_REVERSAL, then mint
//   a held trigger trade                   → exempt from the consensus
//                                            BIAS_REVERSED exit; it closes on
//                                            stop, target, session end, or its
//                                            family's own close-based exit:
//                                            LEVEL_RECLAIMED (momentum — a closed
//                                            15m bar back through the broken
//                                            level) or SWEEP_RECLAIMED (structure
//                                            — a closed bar back beyond the
//                                            sweep extreme)
// ============================================================

import {
  closedBarsAt,
  isLevelReclaimed,
  type MomentumBar,
  type MomentumBreakSignal,
  type MomentumLevelKind,
} from '@fno/analytics';
import { getSessionWindow, type Exchange, type NoTradeCode, type OHLCV, type OptionChainStrike } from '@fno/shared';
import type { GateDiagnostic } from './gate-diagnostics.js';

export const MOMENTUM_BREAK_STRATEGY = 'MOMENTUM_BREAK';
/** The structure family's strategy name on the setup (structure-live.ts owns the rest of it). */
export const STRUCTURE_STRATEGY = 'STRUCTURE';
/** The families that act on a trigger rather than on the consensus read. */
export const TRIGGER_STRATEGIES: readonly string[] = [MOMENTUM_BREAK_STRATEGY, STRUCTURE_STRATEGY];
/** The protected MIN_SL_PREMIUM_PCT, restated for the trigger's premium-stop floor (not a new number). */
const TRIGGER_MIN_SL_PREMIUM_PCT = 0.15;
const BAR_MS = 15 * 60 * 1000;

/** What a trigger trade carries in the slot, so LEVEL_RECLAIMED can be judged on later polls. */
export interface StoredMomentumBreak {
  direction: 'BULLISH' | 'BEARISH';
  levelKind: MomentumLevelKind;
  levelPrice: number;
  /** Trigger bar OPEN time (epoch ms). */
  barTime: number;
  entry: number;
  stop: number;
  target: number;
  targetKind: MomentumLevelKind;
  quality: number;
  variantId: string;
}

export function storedMomentumBreak(signal: MomentumBreakSignal): StoredMomentumBreak {
  return {
    direction: signal.direction,
    levelKind: signal.levelKind,
    levelPrice: signal.levelPrice,
    barTime: signal.barTime,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    targetKind: signal.targetKind,
    quality: signal.quality,
    variantId: signal.variantId,
  };
}

/**
 * Broker candles → the detector's bars: parsed, ascending, inside the
 * exchange session window, and CLOSED at `now` (the newest bar is still
 * forming and is never judged).
 */
export function toClosedMomentumBars(candles: readonly OHLCV[], exchange: Exchange, now: number): MomentumBar[] {
  const windows = new Map<string, ReturnType<typeof getSessionWindow>>();
  const bars = candles
    .map((c) => ({ time: Date.parse(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }))
    .filter((b) => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time)
    .filter((b, i, arr) => i === 0 || arr[i - 1].time !== b.time)
    .filter((b) => {
      const date = new Date(b.time + 330 * 60000).toISOString().slice(0, 10);
      if (!windows.has(date)) windows.set(date, getSessionWindow(exchange, date));
      const w = windows.get(date);
      return w != null && b.time >= w.open && b.time < w.close;
    });
  return closedBarsAt(bars, now, BAR_MS);
}

/**
 * Longer history merged under the fresh 15m candles: the fresh series wins
 * wherever both have a bar (it is the newer read of the same bar).
 */
export function mergeCandleHistory(older: readonly OHLCV[], fresh: readonly OHLCV[]): OHLCV[] {
  const byTs = new Map<number, OHLCV>();
  for (const c of older) byTs.set(Date.parse(c.timestamp), c);
  for (const c of fresh) byTs.set(Date.parse(c.timestamp), c);
  return [...byTs.entries()].filter(([t]) => Number.isFinite(t)).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

/** A trigger is only acted on while its bar is the newest closed bar. */
export function isFreshTrigger(signal: MomentumBreakSignal, now: number): boolean {
  const closedAt = signal.barTime + BAR_MS;
  return now >= closedAt && now < closedAt + BAR_MS;
}

// ---------------- premium stop ----------------

/**
 * The trigger's stop in premium terms, through buildTradeSetup's ordinary
 * slPremiumPct argument: the ATM leg's |Δ| × the underlying stop distance,
 * as a share of its mid, floored at the protected 15%. Null when the ATM leg
 * has no usable quote/delta (the builder then refuses NO_QUOTE itself).
 */
export function triggerSlPremiumPct(
  strikes: readonly OptionChainStrike[],
  atmStrike: number,
  direction: 'BULLISH' | 'BEARISH',
  stopDistancePoints: number
): { slPremiumPct: number; delta: number; mid: number } | null {
  const atm = strikes.find((s) => s.strike === atmStrike);
  const leg = direction === 'BULLISH' ? atm?.call : atm?.put;
  if (!leg || !(leg.ltp > 0) || !Number.isFinite(leg.delta) || Math.abs(leg.delta) > 1 || leg.delta === 0) return null;
  const mid = leg.bid > 0 && leg.ask > 0 ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const delta = Math.abs(leg.delta);
  return { slPremiumPct: Math.max(TRIGGER_MIN_SL_PREMIUM_PCT, (delta * Math.abs(stopDistancePoints)) / mid), delta, mid };
}

// ---------------- refusal chain ----------------

export interface TriggerGateRefusal {
  code: NoTradeCode;
  reason: string;
}

/**
 * The safety gates, in the live chain's own order, with the consensus-only
 * gates left out. Pure composition: each input is the result the live code
 * already computed (null = passed).
 */
export function safetyRefusal(g: {
  riskOff: string | null;
  feedBlock: string | null;
  session: TriggerGateRefusal | null;
  cooldown: TriggerGateRefusal | null;
  reliability: string | null;
  concurrency: TriggerGateRefusal | null;
}): TriggerGateRefusal | null {
  return (
    (g.riskOff ? { code: 'RISK_OFF', reason: g.riskOff } : null) ??
    (g.feedBlock ? { code: 'NO_QUOTE', reason: g.feedBlock } : null) ??
    g.session ??
    g.cooldown ??
    (g.reliability ? { code: 'RELIABILITY_FILTER', reason: g.reliability } : null) ??
    g.concurrency
  );
}

/** TRIGGER_QUALITY — the rule itself: a qualifying trigger on the newest closed bar, with price still on the right side of it. */
export function triggerQualityRefusal(signal: MomentumBreakSignal | null, now: number, spot: number | null): TriggerGateRefusal | null {
  if (!signal) return { code: 'TRIGGER_QUALITY', reason: 'No momentum-break trigger on the latest closed 15m bar.' };
  if (!isFreshTrigger(signal, now)) {
    return { code: 'TRIGGER_QUALITY', reason: `The trigger bar closed at ${new Date(signal.barTime + BAR_MS).toISOString()} — no longer the newest closed bar.` };
  }
  if (spot != null && Number.isFinite(spot)) {
    const sign = signal.direction === 'BULLISH' ? 1 : -1;
    if (isLevelReclaimed(signal.direction, signal.levelPrice, spot)) {
      return { code: 'TRIGGER_QUALITY', reason: `Price (${spot}) is already back through the broken ${signal.levelKind} at ${signal.levelPrice}.` };
    }
    if (sign * (signal.target - spot) <= 0) {
      return { code: 'TRIGGER_QUALITY', reason: `Price (${spot}) has already reached the ${signal.targetKind} target at ${signal.target}.` };
    }
  }
  return null;
}

/** The trigger's whole chain: safety first (the live chain's order), then the rule. */
export function triggerRefusal(
  safety: Parameters<typeof safetyRefusal>[0],
  signal: MomentumBreakSignal | null,
  now: number,
  spot: number | null
): TriggerGateRefusal | null {
  return safetyRefusal(safety) ?? triggerQualityRefusal(signal, now, spot);
}

/** The TRIGGER_QUALITY row for the gate diagnostics. */
export function triggerQualityDiagnostic(
  signal: MomentumBreakSignal | null,
  refusal: TriggerGateRefusal | null,
  at: number
): GateDiagnostic {
  const own = refusal?.code === 'TRIGGER_QUALITY' ? refusal : null;
  return {
    gate: 'TRIGGER_QUALITY',
    status: own ? 'FAIL' : 'PASS',
    reason: own?.reason ?? null,
    threshold: signal ? { variant: signal.variantId, minQuality: 70, family: MOMENTUM_BREAK_STRATEGY } : null,
    input_values: signal
      ? {
          direction: signal.direction,
          levelKind: signal.levelKind,
          levelPrice: signal.levelPrice,
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          quality: signal.quality,
          volMult: signal.volMult,
          rangeMult: signal.rangeMult,
          closeLocation: signal.closeLocation,
          // Consensus-only gates are not part of this family's chain.
          notEnforced: ['LOW_SETUP_QUALITY', 'POOR_LOCATION', 'INSUFFICIENT_ROOM', 'POSITIONING_CONFLICT'],
        }
      : {},
    timestamp: at,
    was_deciding_gate: own != null,
  };
}

// ---------------- the shared slot ----------------

export type SlotAction =
  | { kind: 'CONSENSUS_FLOW' }
  | { kind: 'HOLD_TRIGGER' }
  | { kind: 'CLOSE'; reason: 'LEVEL_RECLAIMED' | 'SWEEP_RECLAIMED' | 'TRIGGER_REVERSAL' };

/** What a structure trade carries in the slot, so SWEEP_RECLAIMED can be judged on later polls. */
export interface SlotStructureView {
  direction: 'BULLISH' | 'BEARISH';
  sweepExtreme: number;
  /** When the limit filled (epoch ms). Only bars closing after it can reclaim. */
  fillAt: number;
}

export interface SlotView {
  direction: string;
  strategy?: string | null;
  momentumBreak?: StoredMomentumBreak | null;
  structure?: SlotStructureView | null;
}

/** A trigger trade: a MOMENTUM_BREAK or STRUCTURE setup carrying its own trigger record. */
export function isTriggerTrade(stored: SlotView): boolean {
  return (
    (stored.strategy === MOMENTUM_BREAK_STRATEGY && stored.momentumBreak != null) ||
    (stored.strategy === STRUCTURE_STRATEGY && stored.structure != null)
  );
}

/** A fresh trigger from any family this poll: only its direction matters to the slot. */
export interface FamilyTrigger {
  family: 'MOMENTUM_BREAK' | 'STRUCTURE';
  direction: 'BULLISH' | 'BEARISH';
}

/**
 * What the slot does this poll, for a live same-day setup whose premium stop
 * and target were NOT hit (those are checked first, unconditionally).
 *
 *   trigger trade + closed bar back through its level → CLOSE LEVEL_RECLAIMED
 *   any setup + a fresh trigger the other way         → CLOSE TRIGGER_REVERSAL
 *   trigger trade otherwise                           → HOLD (no BIAS_REVERSED)
 *   consensus setup otherwise                         → the consensus logic, unchanged
 */
export function triggerSlotAction(args: {
  stored: SlotView;
  trigger: MomentumBreakSignal | null;
  /** Newest closed 15m bar, when the caller has one. */
  lastClosedBar: { time: number; close: number } | null;
  /** Fresh triggers from the other families this poll (structure fills). Absent = momentum only, exactly as before. */
  others?: readonly FamilyTrigger[];
}): SlotAction {
  const { stored, trigger, lastClosedBar } = args;
  const mb = stored.strategy === MOMENTUM_BREAK_STRATEGY && stored.momentumBreak != null ? stored.momentumBreak : null;
  if (mb && lastClosedBar && lastClosedBar.time > mb.barTime && isLevelReclaimed(mb.direction, mb.levelPrice, lastClosedBar.close)) {
    return { kind: 'CLOSE', reason: 'LEVEL_RECLAIMED' };
  }
  const st = stored.strategy === STRUCTURE_STRATEGY && stored.structure != null ? stored.structure : null;
  if (st && lastClosedBar && lastClosedBar.time + BAR_MS > st.fillAt && isSweepReclaimed(st.direction, st.sweepExtreme, lastClosedBar.close)) {
    return { kind: 'CLOSE', reason: 'SWEEP_RECLAIMED' };
  }
  const opposite = [...(trigger ? [trigger.direction] : []), ...(args.others ?? []).map((o) => o.direction)].some((d) => d !== stored.direction);
  if (opposite && (stored.direction === 'BULLISH' || stored.direction === 'BEARISH')) {
    return { kind: 'CLOSE', reason: 'TRIGGER_REVERSAL' };
  }
  return mb || st ? { kind: 'HOLD_TRIGGER' } : { kind: 'CONSENSUS_FLOW' };
}

/** A structure trade is wrong once a 15m bar closes back beyond the sweep extreme. */
export function isSweepReclaimed(direction: 'BULLISH' | 'BEARISH', sweepExtreme: number, close: number): boolean {
  return direction === 'BEARISH' ? close > sweepExtreme : close < sweepExtreme;
}
