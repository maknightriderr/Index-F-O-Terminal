// ============================================================
// EXECUTION QUALITY (Phase 2 — shadow only)
// ============================================================
// This is a PAPER-TRADING system: no order is placed, nothing is filled. The
// live paper entry is the bid-ask MID (buildNakedLong: `entry = round2(mid)`),
// which no buyer actually gets — a marketable buy order lifts the ASK.
//
// This computes what the same paper trade looks like entered at the ask
// instead, against the SAME live stop and target levels, and marks the read
// DEGRADED when there is no reliable two-sided quote to take the ask from (it
// then falls back to LTP, exactly as the live path does).
//
// SHADOW ONLY. The live entry price is not changed. The net R here is the
// live path's own formula — (reward - round-trip cost) / (risk + round-trip
// cost), with the cost from estimateRoundTripCost — evaluated at both the mid
// (live) and the ask (shadow), so the two are directly comparable.
//
// Conservative by construction: estimateRoundTripCost charges the full spread
// on the assumption of a mid-price entry; at an ask entry half of that spread
// is already inside the price. The shadow figure is therefore a lower bound
// on the realistic net R, not a point estimate. Stated here rather than
// "fixed" with a second cost model.
// ============================================================

import { estimateRoundTripCost } from '../trade-setup/index.js';

export type ExecutionQuality = 'NORMAL' | 'DEGRADED';

export interface ExecutionQualityInput {
  bid: number | null | undefined;
  ask: number | null | undefined;
  ltp: number | null | undefined;
  /** The live setup's (mid-price) entry. */
  liveEntry: number;
  stopLoss: number;
  target: number;
  lotSize: number;
}

export interface ExecutionQualityResult {
  shadow: true;
  /** Ask for a long when a reliable two-sided quote exists, else LTP. */
  shadowEntryPrice: number | null;
  executionQuality: ExecutionQuality;
  basis: 'ASK' | 'LTP_FALLBACK' | 'NO_PRICE';
  /** Net R at the shadow entry, same levels. */
  shadowNetR: number | null;
  /** Net R at the live mid entry — buildNakedLong's riskRewardNet, recomputed for comparison. */
  liveNetR: number | null;
  /** shadowNetR - liveNetR. */
  netRDelta: number | null;
  /** Entry slippage vs the live mid, in premium points. */
  entrySlippage: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The live path's net reward:risk formula, at a given entry. */
function netR(entry: number, stopLoss: number, target: number, bid: number, ask: number, lotSize: number): number | null {
  if (!(entry > 0)) return null;
  const cost = estimateRoundTripCost(entry, bid, ask, lotSize).perUnit;
  const risk = entry - stopLoss;
  const denom = risk + cost;
  if (!(denom > 0)) return null;
  return round2((target - entry - cost) / denom);
}

export function assessExecutionQuality(input: ExecutionQualityInput): ExecutionQualityResult {
  const bid = input.bid ?? 0;
  const ask = input.ask ?? 0;
  const ltp = input.ltp ?? 0;
  // "Reliable" = the broker is publishing a two-sided, uncrossed market. No
  // width threshold: the live path's own spread ceiling already refused any
  // setup whose ATM spread was too wide to trade.
  const reliable = bid > 0 && ask > 0 && ask >= bid;

  const shadowEntryPrice = reliable ? ask : ltp > 0 ? ltp : null;
  const basis: ExecutionQualityResult['basis'] = reliable ? 'ASK' : ltp > 0 ? 'LTP_FALLBACK' : 'NO_PRICE';
  const executionQuality: ExecutionQuality = reliable ? 'NORMAL' : 'DEGRADED';

  const liveNetR = netR(input.liveEntry, input.stopLoss, input.target, bid, ask, input.lotSize);
  const shadowNetR = shadowEntryPrice != null ? netR(shadowEntryPrice, input.stopLoss, input.target, bid, ask, input.lotSize) : null;

  return {
    shadow: true,
    shadowEntryPrice: shadowEntryPrice != null ? round2(shadowEntryPrice) : null,
    executionQuality,
    basis,
    shadowNetR,
    liveNetR,
    netRDelta: shadowNetR != null && liveNetR != null ? round2(shadowNetR - liveNetR) : null,
    entrySlippage: shadowEntryPrice != null ? round2(shadowEntryPrice - input.liveEntry) : null,
  };
}
