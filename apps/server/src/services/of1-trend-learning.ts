// ============================================================
// Legacy engine — learning from counter-trend outcomes, per strategy (owner, 12 Nov)
// ============================================================
// 12 Nov 19:45 IST: OF1 bought a CRUDEOIL put while the regime was WEAK_BULL_TREND; it never moved in favour (MFE
// 0.05R) and stopped out at -1.12R, while the with-trend call the same evening made +2.36R. One trade proves nothing,
// so the owner chose to learn from the data: every closed OF1 paper trade since the 12 Nov reinstatement is classed
// WITH_TREND / COUNTER_TREND / NO_TREND from the regime recorded on its signal (signals.market_regime), and once at
// least OF1_COUNTER_TREND_MIN_TRADES counter-trend trades have closed with a negative average net R, new
// counter-trend OF1 entries are refused. With-trend and no-trend entries are never affected. The rule lifts itself
// if later counter-trend outcomes turn the average positive (it is re-read every OF1_LEARNING_REFRESH_MS).
// 13 Nov (owner): the same rule for every legacy strategy (OB1, OF1, INDICATOR, S1, the A2-F3 families, ...), each
// judged on its own closed trades only; applied at the slot's final check, so a refused candidate yields to the next.
// ============================================================

import type { BiasDirection, MarketRegime } from '@fno/shared';
import { logger } from '../lib/logger.js';
import { listPaperTrades } from './paper-trades.js';
import { getTradeSetupHistory } from './backtesting.js';

export const OF1_COUNTER_TREND_MIN_TRADES = 10;
export const OF1_LEARNING_REFRESH_MS = 15 * 60_000;
/** Only trades minted under the reinstated engine count (older OF1 history used other rules). */
export const OF1_LEARNING_VERSION_MARK = '+reinstate-all.1';

export type TrendAlignment = 'WITH_TREND' | 'COUNTER_TREND' | 'NO_TREND';

/** The trend side a regime names, or null when it names no trend. */
export function regimeTrendSide(regime: MarketRegime | string | null | undefined): 'BULLISH' | 'BEARISH' | null {
  if (regime === 'STRONG_BULL_TREND' || regime === 'WEAK_BULL_TREND') return 'BULLISH';
  if (regime === 'STRONG_BEAR_TREND' || regime === 'WEAK_BEAR_TREND') return 'BEARISH';
  return null;
}

export function trendAlignment(direction: BiasDirection | string | null | undefined, regime: MarketRegime | string | null | undefined): TrendAlignment {
  const side = regimeTrendSide(regime);
  if (!side || (direction !== 'BULLISH' && direction !== 'BEARISH')) return 'NO_TREND';
  return direction === side ? 'WITH_TREND' : 'COUNTER_TREND';
}

export interface Of1Outcome { family: string | null; direction: string | null; regime: string | null; netR: number | null; logicVersion: string | null; /** WIN / LOSS / EXPIRED (recorded only). */ state?: string | null }
/**
 * 13 Nov (owner): the second lesson. On 13 Nov five of seven closed legacy trades ended EXPIRED (the time limit, not
 * the stop) at a loss: the market did not move and the premium decayed. A strategy whose trades ENTERED in a quiet
 * regime (QUIET_REGIMES) have closed OF1_COUNTER_TREND_MIN_TRADES times with a negative average net R no longer enters
 * in a quiet regime. The regime at entry is the cause the rule acts on; how many of those trades expired is recorded.
 */
export const QUIET_REGIMES: ReadonlySet<string> = new Set(['RANGE_BOUND', 'LOW_VOLATILITY']);
export interface Of1Learning { counterTrend: { trades: number; avgNetR: number | null }; withTrend: { trades: number; avgNetR: number | null }; blockCounterTrend: boolean; quiet?: { trades: number; avgNetR: number | null; expired: number }; blockQuiet?: boolean; at: number }

/** Pure: the learned state from one strategy's closed trades (OF1 by default). */
export function learnOf1(outcomes: readonly Of1Outcome[], at = Date.now(), family = 'OF1'): Of1Learning {
  const of1 = outcomes.filter((o) => o.family === family && o.netR != null && Number.isFinite(o.netR) && (o.logicVersion ?? '').includes(OF1_LEARNING_VERSION_MARK));
  const group = (a: TrendAlignment) => {
    const xs = of1.filter((o) => trendAlignment(o.direction, o.regime) === a).map((o) => o.netR!);
    return { trades: xs.length, avgNetR: xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10000) / 10000 : null };
  };
  const counterTrend = group('COUNTER_TREND'), withTrend = group('WITH_TREND');
  const q = of1.filter((o) => o.regime != null && QUIET_REGIMES.has(o.regime));
  const quiet = { trades: q.length, avgNetR: q.length ? Math.round((q.reduce((s, o) => s + o.netR!, 0) / q.length) * 10000) / 10000 : null, expired: q.filter((o) => o.state === 'EXPIRED').length };
  return { counterTrend, withTrend, blockCounterTrend: counterTrend.trades >= OF1_COUNTER_TREND_MIN_TRADES && (counterTrend.avgNetR ?? 0) < 0, quiet, blockQuiet: quiet.trades >= OF1_COUNTER_TREND_MIN_TRADES && (quiet.avgNetR ?? 0) < 0, at };
}

/** Pure: the learned state of every strategy that has closed trades. */
export function learnByFamily(outcomes: readonly Of1Outcome[], at = Date.now()): Record<string, Of1Learning> {
  const families = [...new Set(outcomes.map((o) => o.family).filter((f): f is string => !!f))];
  return Object.fromEntries(families.map((f) => [f, learnOf1(outcomes, at, f)]));
}

let all: { at: number; byFamily: Record<string, Of1Learning> } | null = null;
let refreshingAll: Promise<void> | null = null;

/** Every strategy's learned state (null until the first read); refreshed in the background like of1Learning. */
export function familyLearning(load: () => Promise<Of1Outcome[]> = loadFamilyOutcomes, now = Date.now()): Record<string, Of1Learning> | null {
  if ((!all || now - all.at >= OF1_LEARNING_REFRESH_MS) && !refreshingAll) {
    refreshingAll = load()
      .then((rows) => {
        const before = all?.byFamily ?? {};
        const byFamily = learnByFamily(rows, now);
        all = { at: now, byFamily };
        const blocked = Object.entries(byFamily).flatMap(([f, l]) => [...(l.blockCounterTrend ? [`${f}:COUNTER_TREND`] : []), ...(l.blockQuiet ? [`${f}:QUIET_MARKET`] : [])]);
        const changed = Object.entries(byFamily).filter(([f, l]) => (before[f]?.blockCounterTrend ?? false) !== l.blockCounterTrend || (before[f]?.blockQuiet ?? false) !== (l.blockQuiet ?? false)).map(([f]) => f);
        logger.info({ event: 'strategyLearning', blocked, changed, byFamily: Object.fromEntries(Object.entries(byFamily).map(([f, l]) => [f, { counter: l.counterTrend, with: l.withTrend, block: l.blockCounterTrend, quiet: l.quiet, blockQuiet: l.blockQuiet }])) }, 'Strategy learning: counter-trend vs with-trend outcomes per strategy (counter-trend refused once 10 closed with a negative average)');
      })
      .catch((err: any) => logger.warn({ event: 'strategyLearning', error: err?.message }, 'Strategy learning: outcomes unavailable (the last state stays)'))
      .finally(() => { refreshingAll = null; });
  }
  return all?.byFamily ?? null;
}

/** The final-check refusal for a candidate its strategy has learned not to take (counter-trend), else null. */
export function learnedRefusal(source: string, direction: string, regime: MarketRegime | string | null | undefined, learned: Record<string, Of1Learning> | null): { code: string; reason: string } | null {
  const l = learned?.[source];
  if (l?.blockQuiet && regime != null && QUIET_REGIMES.has(regime)) return { code: 'LEARNED_QUIET_MARKET', reason: `${source} has closed ${l.quiet!.trades} trades entered in a quiet market (${l.quiet!.expired} of them expired) at an average ${l.quiet!.avgNetR}R net; it no longer enters in a ${regime} regime.` };
  if (!l?.blockCounterTrend || trendAlignment(direction, regime) !== 'COUNTER_TREND') return null;
  return { code: 'LEARNED_COUNTER_TREND', reason: `${source} has closed ${l.counterTrend.trades} counter-trend trades at an average ${l.counterTrend.avgNetR}R net; it no longer trades against the ${regime} regime.` };
}

let state: Of1Learning | null = null;
let refreshing: Promise<void> | null = null;

/** The current learned state (null until the first read). Refreshes in the background when older than the period. */
export function of1Learning(load: () => Promise<Of1Outcome[]>, now = Date.now()): Of1Learning | null {
  if ((!state || now - state.at >= OF1_LEARNING_REFRESH_MS) && !refreshing) {
    refreshing = load()
      .then((rows) => {
        const before = state?.blockCounterTrend ?? null;
        state = learnOf1(rows, now);
        logger.info({ event: 'of1Learning', ...state, changed: before != null && before !== state.blockCounterTrend }, 'OF1 learning: counter-trend vs with-trend outcomes (counter-trend entries refused once 10 have closed with a negative average)');
      })
      .catch((err: any) => logger.warn({ event: 'of1Learning', error: err?.message }, 'OF1 learning: outcomes unavailable (the last state stays)'))
      .finally(() => { refreshing = null; });
  }
  return state;
}

/**
 * Closed OF1 outcomes: net R from the paper-trade view, regime from the signal row. The one place a realized outcome
 * feeds an entry decision, by the owner's explicit choice (12 Nov); the decision code itself never reads net R.
 */
export async function loadOf1Outcomes(): Promise<Of1Outcome[]> {
  return (await loadFamilyOutcomes()).filter((o) => o.family === 'OF1');
}
/** Closed outcomes of every legacy strategy (family = the recorded source). */
export async function loadFamilyOutcomes(): Promise<Of1Outcome[]> {
  const [view, history] = await Promise.all([listPaperTrades(2000), getTradeSetupHistory(2000)]);
  const regime = new Map(history.map((r) => [r.id, r.regime ?? null]));
  return view.trades.filter((t) => t.netR != null).map((t) => ({ family: t.family, direction: t.direction, regime: regime.get(t.id) ?? null, netR: t.netR, logicVersion: t.logicVersion ?? null, state: t.state ?? null }));
}

/** Tests only. */
export function resetOf1Learning(s: Of1Learning | null = null): void { state = s; refreshing = null; all = null; refreshingAll = null; }
