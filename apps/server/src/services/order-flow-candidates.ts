// ============================================================
// OB1 / OF1 — paper candidate sources (user decision 2026-10-09)
// ============================================================
// The repaired order block (OB-2.0) and Order Flow Confirmation (OF1-1.0)
// hand the slot ordinary trigger candidates, built and qualified EXACTLY like
// every trigger family's:
//   * buildCandidate (event engine) — entry = the decision bar's close, the
//     stop = the rule's reference ± 0.1 ATR, T1 / T2 = the nearest untaken
//     opposite pools, the R:R bucket, entry timing and move potential;
//   * the router's own session window and option-cost check
//     (validateCandidateRisk, costOnChain);
// then they join the trigger families' paper candidates, so the existing
// chain (safety gates, option selection, stops, targets, costs, exits) and
// the existing slot arbitration decide — nothing is bypassed or changed.
//
//   OB1  the OB-2.0 decision signal at the newest closed bar (a fresh block
//        first touched on that bar and not mitigated by its close). Stop
//        reference = the block's far edge. Parent = the block.
//   OF1  each OF1 candidate at the newest closed bar. Stop reference = the
//        bar's extreme beyond the level (the rule's own). Parent = the level
//        on that session and direction.
// Stage PAPER_RESEARCH while enabled (ORDER_BLOCK_MODE=PAPER / OF1_TRADING),
// SHADOW otherwise. Paper only — nothing here can reach a broker.
// ============================================================

import { ENTRY_CONFIRMATION_VERSION } from './entry-confirmation-rules.js';
import {
  buildCandidate,
  buildSeriesContext,
  evaluateOf1,
  orderBlockSignalAt,
  prepareMomentumSeries,
  runSessionEvents,
  type FootprintBar,
  type MarketEvent,
  type MomentumBar,
  type TriggerCandidate,
  type TriggerDefinition,
  type TriggerFamily,
} from '@fno/analytics';
import { getSessionWindow, type Exchange, type OptionChain } from '@fno/shared';
import { costOnChain, routedLifecycleId, validateCandidateRisk, type RoutedCandidate } from './trigger-router.js';
import { FNO_VALIDATION_PARAMS, STRUCTURE_PARAMS, type LiveTriggerStage } from '../config/trading-flags.js';
import { OB1_TRADING, OF1_TRADING } from '../config/order-flow-flags.js';

const BAR_MS_15M = 15 * 60 * 1000;
/** The router's settle after the open (trigger-router.ts SETTLE_MS). */
const SETTLE_MS = 5 * 60 * 1000;

/** Not one of the event engine's registry families; only labels the candidate. */
type OrderFlowFamily = 'ORDER_BLOCK' | 'ORDER_FLOW';
const def = (triggerId: 'OB1' | 'OF1', family: OrderFlowFamily) => ({ triggerId, family: family as unknown as TriggerFamily }) as TriggerDefinition;

const event = (id: string, barIndex: number, price: number, time: number, direction: 'BULLISH' | 'BEARISH'): MarketEvent =>
  ({ id, type: 'RECLAIM', barIndex, time, availableAt: time + BAR_MS_15M, direction, price }) as unknown as MarketEvent;

export interface OrderFlowPaperArgs {
  underlying: string;
  exchange: Exchange;
  /** Closed 15m bars (the same window the trigger families read). */
  bars: readonly MomentumBar[];
  chain: OptionChain | null;
  /** Footprints by bar open time (OF1 only; empty = no order-flow data). */
  footprints: ReadonlyMap<number, FootprintBar>;
  ob1: boolean;
  of1: boolean;
}

// ============================================================
// OF1 PAPER RULES 1.3 (owner, 27 Nov): fix the logic directly in paper, no shadow
// ============================================================
// 12-26 Nov, 16 OF1 paper trades: 1 target, net -6.95R. 8 ended SWEEP_RECLAIMED within 14-60 min: the stop sat only
// 0.1 ATR beyond the decision bar's extreme and the reclaim exit 0.1 ATR inside it, so ordinary noise closed them.
// Counter-trend entries averaged -0.73R (8) vs -0.17R with the trend (3). The 2,266 graded OF1 shadow candidates
// averaged +0.04R on the underlying before costs. Three changes, OF1 only (OB1 and every other family unchanged):
//   TREND   bullish only above a rising 15m EMA20 (bearish mirrors): no buying support in a falling market
//   STOP    the stop reference moves STOP_EXTRA_ATR further beyond the extreme (the reclaim exit moves with it)
//   REWARD  T1 at least MIN_R_TO_T1 of the wider risk, else no trade
// ============================================================
export const OF1_PAPER_RULES = Object.freeze({ version: 'OF1-PAPER-1.3', emaPeriod: 20, slopeBars: 3, stopExtraAtr: 0.25, minRToT1: 1.2 });

/** Pure: the 15m EMA of closes at every bar up to i (seeded with the first close). */
function emaAt(bars: readonly MomentumBar[], i: number, period: number): number[] {
  const k = 2 / (period + 1), out: number[] = [];
  for (let j = 0; j <= i; j++) out.push(j === 0 ? bars[0].close : bars[j].close * k + out[j - 1] * (1 - k));
  return out;
}

/** Pure: OF1 1.3 trend alignment at bar i — bullish needs close above a rising EMA20, bearish below a falling one. */
export function of1TrendAligned(bars: readonly MomentumBar[], i: number, direction: 'BULLISH' | 'BEARISH'): boolean {
  const R = OF1_PAPER_RULES;
  if (i < R.emaPeriod + R.slopeBars) return false;
  const e = emaAt(bars, i, R.emaPeriod), now = e[i], before = e[i - R.slopeBars], close = bars[i].close;
  return direction === 'BULLISH' ? close > now && now > before : close < now && now < before;
}

/** Pure: the OB1 / OF1 candidates of the newest closed bar, routed like the families'. */
export function orderFlowPaperCandidates(a: OrderFlowPaperArgs): RoutedCandidate[] {
  if ((!a.ob1 && !a.of1) || a.bars.length < 20) return [];
  const series = prepareMomentumSeries([...a.bars]);
  const s = series.sessionStarts.length - 1;
  if (s < 0) return [];
  const ctx = buildSeriesContext(series);
  const i = ctx.sessionEnd(s);
  if (i !== series.bars.length - 1) return [];
  const log = runSessionEvents(ctx, s);
  const bars = series.bars;
  const window = getSessionWindow(a.exchange, series.sessionDates[s]);
  if (!window) return [];
  const out: RoutedCandidate[] = [];

  const route = (c: TriggerCandidate, stage: LiveTriggerStage, parentId: string): RoutedCandidate => {
    const sessionOk = c.decisionTime - window.open >= SETTLE_MS && window.close - (c.decisionTime + BAR_MS_15M) >= STRUCTURE_PARAMS.STRUCTURE_CLOSING_GUARD_MIN * 60 * 1000;
    const cost = costOnChain(c, a.chain);
    const risk = validateCandidateRisk(c, { sessionOk, costPct: cost?.costPctOfPremium != null ? Math.round(cost.costPctOfPremium * 100) / 100 : null, maxCostPct: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM });
    return { candidate: c, stage, risk, cost, lifecycleId: routedLifecycleId(a.exchange, a.underlying, c), parentId, anchorKeys: [parentId] };
  };

  if (a.ob1) {
    const sig = orderBlockSignalAt(bars, i);
    if (sig) {
      const b = sig.block;
      const dir = b.type;
      const level = dir === 'BULLISH' ? b.top : b.bottom;
      const blockTime = bars[b.blockIndex].time;
      const hit = { direction: dir, anchor: event(`ORDER_BLOCK:${dir}:${blockTime}`, b.blockIndex, level, blockTime, dir), events: [], stopRef: dir === 'BULLISH' ? b.bottom : b.top };
      const c = buildCandidate(ctx, log, def('OB1', 'ORDER_BLOCK'), hit as any, i);
      if (c) out.push({ ...route(c, 'PAPER_RESEARCH', `OB1:${a.exchange}:${a.underlying}:${blockTime}:${dir}`), entryEvidence: { version: ENTRY_CONFIRMATION_VERSION, source: 'OB1', sourceVersion: 'OB-2.0', direction: dir, decisionTime: bars[i].time, blockTop: b.top, blockBottom: b.bottom, close: bars[i].close } });
    }
  }

  if (a.of1 && a.footprints.size > 0) {
    for (const o of evaluateOf1(bars, i, a.footprints, undefined, true)) {
      const bar = bars[i];
      // OF1 1.3: with the 15m trend only.
      if (!of1TrendAligned(bars, i, o.direction)) continue;
      const atr = ctx.atrAt(i);
      if (atr == null) continue;
      const extra = OF1_PAPER_RULES.stopExtraAtr * atr;
      const stopRef = o.direction === 'BULLISH' ? Math.min(bar.low, o.location.price) - extra : Math.max(bar.high, o.location.price) + extra;
      const hit = { direction: o.direction, anchor: event(`OF1:${o.location.kind}:${o.direction}:${bar.time}`, i, o.location.price, bar.time, o.direction), events: [], stopRef };
      const c = buildCandidate(ctx, log, def('OF1', 'ORDER_FLOW'), hit as any, i);
      // OF1 1.3: T1 must pay at least MIN_R_TO_T1 of the wider risk.
      if (!c || c.rToT1 == null || c.rToT1 < OF1_PAPER_RULES.minRToT1) continue;
      out.push({ ...route(c, 'PAPER_RESEARCH', `OF1:${a.exchange}:${a.underlying}:${series.sessionDates[s]}:${o.direction}:${o.location.kind}:${Math.round(o.location.price * 100) / 100}`), entryEvidence: { version: ENTRY_CONFIRMATION_VERSION, source: 'OF1', sourceVersion: o.version, direction: o.direction, decisionTime: bar.time, found: [...o.evidence], alignment: 'ALIGNED', flowBasis: o.flowBasis } });
    }
  }
  return out;
}

/** The live switches. */
export const orderFlowSourcesOn = () => ({ ob1: OB1_TRADING, of1: OF1_TRADING });
