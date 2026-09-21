import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * THE DECISION CLOCK
 *
 * The audit for the event-driven-replay work found the real obstacle to
 * live/backtest parity, and it is not a missing backtester: the decision
 * engine reads the wall clock directly in 25 places. `filterToday` asks
 * what today is, `loadBiasCandles` asks what time it is to build its
 * `from`/`to` window, the cooldown keys are named after today's date, the
 * IV-rank query says `NOW() - INTERVAL '365 days'`. Every one of those is
 * correct in production and meaningless at a historical timestamp, so the
 * engine simply cannot be *asked* what it would have decided at 11:45 on
 * 3 September — there is no way to tell it that it is 11:45 on 3
 * September.
 *
 * This module is that way. `decisionNow()` returns the current decision
 * time, which in production is `Date.now()` and inside
 * `withDecisionTime(t, fn)` is `t`. The engine calls it instead of the
 * clock. Because the store is an AsyncLocalStorage, an entire async
 * decision — every await inside it — sees the same frozen instant without
 * any parameter threading, and nothing about the production path changes:
 * with no store set, this is `Date.now()` and one map lookup.
 *
 * A second job falls out of it for free. A replay that *believes* it is at
 * time T can still be handed a candle series that runs past T, and that is
 * precisely the look-ahead the spec forbids. `assertNoFutureData` compares
 * the data it is given against the decision time and throws rather than
 * silently scoring on tomorrow's bars. In production the decision time is
 * now, so nothing can be in the future and the check is free; in replay it
 * is the tripwire.
 */

interface DecisionContext {
  /** The instant the engine believes it is deciding at, in epoch ms. */
  at: number;
  /**
   * Replay mode. Production leaves this false. When true,
   * `assertNoFutureData` throws on a violation instead of only warning,
   * because a replay that quietly reads future data produces a number that
   * looks like evidence and is not.
   */
  replay: boolean;
  /** Set by assertNoFutureData; lets a replay report what it rejected. */
  violations: string[];
}

const storage = new AsyncLocalStorage<DecisionContext>();

/**
 * The instant the current decision is being made at. `Date.now()` in
 * production; the replay timestamp inside `withDecisionTime`.
 *
 * Use this anywhere a decision depends on "when is it" — session gating,
 * date-keyed cooldowns, elapsed-time arithmetic, candle windows. Do NOT
 * use it for things that are genuinely about the present moment regardless
 * of what is being decided: a cache TTL, a log line's timestamp, a
 * latency measurement. Those want the real clock.
 */
export function decisionNow(): number {
  return storage.getStore()?.at ?? Date.now();
}

/** The same instant as a Date, for the IST date-string formatting this codebase does everywhere. */
export function decisionDate(): Date {
  return new Date(decisionNow());
}

/** The IST calendar date of the current decision, `YYYY-MM-DD`. */
export function decisionIstDate(): string {
  return decisionDate().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** True while a replay is in progress. Production is always false. */
export function isReplay(): boolean {
  return storage.getStore()?.replay ?? false;
}

/**
 * Run `fn` as though it were `at`. Every `decisionNow()` inside it — across
 * awaits, in nested calls, in other modules — returns `at`.
 */
export function withDecisionTime<T>(at: number, fn: () => Promise<T>, options: { replay?: boolean } = {}): Promise<T> {
  return storage.run({ at, replay: options.replay ?? false, violations: [] }, fn);
}

/**
 * Run a replay decision at `at` and hand back both its result and any
 * look-ahead violations recorded during it. A replay that returns
 * violations is not a result; it is a bug report.
 */
export async function runReplayDecision<T>(
  at: number,
  fn: () => Promise<T>
): Promise<{ result: T; violations: string[] }> {
  const context: DecisionContext = { at, replay: true, violations: [] };
  const result = await storage.run(context, fn);
  return { result, violations: context.violations };
}

/**
 * Assert that a series carries nothing from after the decision instant.
 *
 * `timestamps` are bar OPEN times, which is how this feed labels them: the
 * bar called 11:45 is the one that opens at 11:45 and is still forming at
 * 11:52. That forming bar is legitimately present in a decision made at
 * 11:52, and it passes this check without needing any tolerance, because
 * its open time is in the past. A bar whose open time is in the future has
 * not started trading yet, and there is no reading of that which is not
 * look-ahead — so the tolerance is zero, and an earlier version of this
 * function that allowed one interval of slack was simply wrong: it let the
 * next bar through, which is exactly the case it existed to catch.
 *
 * `toleranceMs` remains only for a feed that labels bars by CLOSE time, where
 * the newest bar's label genuinely is in the future. No caller uses it today.
 */
export function assertNoFutureData(label: string, timestamps: readonly number[], toleranceMs = 0): void {
  const context = storage.getStore();
  const at = context?.at ?? Date.now();
  let worst = 0;
  for (const ts of timestamps) {
    if (ts > at + toleranceMs && ts - at > worst) worst = ts - at;
  }
  if (worst === 0) return;
  const message = `${label}: data from ${Math.round(worst / 1000)}s after the decision instant (${new Date(at).toISOString()})`;
  if (context?.replay) {
    context.violations.push(message);
    throw new LookAheadError(message);
  }
  // Production: a future bar here means the feed is ahead of us, which is
  // worth knowing about but is not a reason to refuse to trade.
  futureDataInProduction.push({ label, at, aheadMs: worst });
  if (futureDataInProduction.length > 200) futureDataInProduction.shift();
}

export class LookAheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookAheadError';
  }
}

/**
 * Production sightings of feed data stamped ahead of the decision instant.
 * Not a correctness problem in live trading — it means the broker's clock
 * or ours drifted — but if this fills up, the replay tolerance is wrong.
 */
export const futureDataInProduction: { label: string; at: number; aheadMs: number }[] = [];

/**
 * The last bar in a series that had actually completed by the decision
 * instant, or null if none had.
 *
 * This is the other half of the parity problem, and it is not look-ahead:
 * live, the newest bar is still forming, and a detector run over it reads a
 * high/low that is not final yet — so a Supertrend can flip and unflip, and
 * a replay over completed bars will never reproduce that flip. Features
 * that must be stable across live and replay take their series through
 * here; features that are deliberately about the live moment (spot, the
 * running session VWAP) do not, and say so in the lineage registry.
 */
export function lastCompletedIndex(timestamps: readonly number[], intervalMs: number, at = decisionNow()): number {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] + intervalMs <= at) return i;
  }
  return -1;
}

/** Interval length in ms for the candle intervals the bias engine fetches. */
export const INTERVAL_MS: Record<string, number> = {
  ONE_MINUTE: 60_000,
  FIVE_MINUTE: 5 * 60_000,
  FIFTEEN_MINUTE: 15 * 60_000,
  ONE_HOUR: 60 * 60_000,
  ONE_DAY: 24 * 60 * 60_000,
};
