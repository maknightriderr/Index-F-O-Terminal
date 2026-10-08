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
      if (c) out.push(route(c, 'PAPER_RESEARCH', `OB1:${a.exchange}:${a.underlying}:${blockTime}:${dir}`));
    }
  }

  if (a.of1 && a.footprints.size > 0) {
    for (const o of evaluateOf1(bars, i, a.footprints)) {
      const bar = bars[i];
      const stopRef = o.direction === 'BULLISH' ? Math.min(bar.low, o.location.price) : Math.max(bar.high, o.location.price);
      const hit = { direction: o.direction, anchor: event(`OF1:${o.location.kind}:${o.direction}:${bar.time}`, i, o.location.price, bar.time, o.direction), events: [], stopRef };
      const c = buildCandidate(ctx, log, def('OF1', 'ORDER_FLOW'), hit as any, i);
      if (c) out.push(route(c, 'PAPER_RESEARCH', `OF1:${a.exchange}:${a.underlying}:${series.sessionDates[s]}:${o.direction}:${o.location.kind}:${Math.round(o.location.price * 100) / 100}`));
    }
  }
  return out;
}

/** The live switches. */
export const orderFlowSourcesOn = () => ({ ob1: OB1_TRADING, of1: OF1_TRADING });
