// ============================================================
// OF1 LIVE — Order Flow Confirmation, SHADOW ONLY (2026-10-09)
// ============================================================
// Once per closed 15m bar for the order-flow symbols (NIFTY, BANKNIFTY), OF1
// (packages/analytics order-flow/of1.ts) is evaluated on the closed bars and
// the Dhan footprints, independently of every other family. Each candidate is
// recorded with its location, order-flow evidence and delta mode, the option
// plan the existing option builder would make for it (read-only), its cost,
// and whether it would trade if live. It never reaches the paper-trade slot:
// OF1_TRADING is false and there is no code path from here to a mint.
// The candidate that actually won the slot and the hypothetical outcome
// (MFE / MAE) are filled in after the session (forward-validation.ts).
// ============================================================

import { buildTradeSetup, evaluateOf1, OF1_VERSION, type Of1Bar, type Of1Candidate } from '@fno/analytics';
import type { OptionChain } from '@fno/shared';
import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { footprintsFor, ORDER_FLOW_MIGRATION } from './order-flow-store.js';
import { OF1_ENABLED, ORDER_FLOW_SYMBOLS } from '../config/order-flow-flags.js';

/** Pure: the hypothetical option plan and whether OF1 would trade if it were live. */
export function of1TradeVerdict(
  c: Of1Candidate,
  chain: OptionChain | null,
  gates: { session: string | null; riskOff: string | null },
  sessionHours: number
): { plan: Record<string, unknown> | null; costPct: number | null; expectedMove: number | null; wouldTrade: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (gates.riskOff) reasons.push(`RISK_OFF: ${gates.riskOff}`);
  if (gates.session) reasons.push(`SESSION: ${gates.session}`);
  if (!c.target) reasons.push('NO_TARGET: no opposite level at least 0.5 ATR away');
  const expectedMove = c.target ? Math.abs(c.target.price - c.entry) : null;
  let plan: Record<string, unknown> | null = null;
  let costPct: number | null = null;
  if (!chain) reasons.push('NO_CHAIN');
  else if (expectedMove != null) {
    // The existing option builder, called read-only with OF1's own move and stop.
    const stopPoints = Math.abs(c.entry - c.stop);
    const atm = chain.strikes.find((s) => s.strike === chain.atmStrike);
    const leg = c.direction === 'BULLISH' ? atm?.call : atm?.put;
    const mid = leg && leg.bid > 0 && leg.ask > 0 ? (leg.bid + leg.ask) / 2 : leg?.ltp ?? null;
    const slPct = mid && leg?.delta ? Math.max(0.15, (Math.abs(leg.delta) * stopPoints) / mid) : undefined;
    const s = buildTradeSetup(chain.strikes, chain.atmStrike, c.direction, 80, expectedMove, slPct, null, chain.dte, chain.lotSize, c.atr, {
      rrGate: false,
      confidenceGate: false,
      spot: chain.spotPrice,
      tickSize: 0.05,
      realisticPayoff: { sessionHours },
    });
    costPct = s.estimatedCostPct ?? null;
    plan = { available: s.available, code: s.noTradeCode ?? null, side: s.side ?? null, strike: s.strike ?? null, expiry: chain.expiry, entry: s.entry ?? null, stopLoss: s.stopLoss ?? null, target: s.target ?? null, riskReward: s.riskReward ?? null };
    if (!s.available) reasons.push(`OPTION: ${s.noTradeCode ?? 'refused'}`);
  }
  return { plan, costPct, expectedMove, wouldTrade: reasons.length === 0, reasons };
}

export async function recordOf1Shadow(a: {
  underlying: string;
  exchange: string;
  mode: string;
  bars: readonly Of1Bar[];
  chain: OptionChain | null;
  gates: { session: string | null; riskOff: string | null };
  sessionHours: number;
}): Promise<number> {
  if (!OF1_ENABLED || a.mode !== 'INTRADAY' || !ORDER_FLOW_SYMBOLS.includes(a.underlying) || a.bars.length < 20 || !schemaFileReady(ORDER_FLOW_MIGRATION)) return 0;
  const i = a.bars.length - 1;
  const decisionBar = a.bars[i].time;
  const first = await redis.set(`of1_eval:${a.exchange}:${a.underlying}:${decisionBar}`, '1', 'EX', 36 * 60 * 60, 'NX');
  if (first !== 'OK') return 0;
  try {
    // Today's and the previous session's bars carry the footprints OF1 reads.
    const recent = a.bars.slice(-60).map((b) => b.time);
    const fps = await footprintsFor(a.underlying, recent);
    const candidates = evaluateOf1(a.bars, i, fps);
    for (const c of candidates) {
      const v = of1TradeVerdict(c, a.chain, a.gates, a.sessionHours);
      await sql`
        INSERT INTO of1_candidates (symbol, exchange, mode, decision_bar_time, direction, strategy_version, subtype, location_kind, location_price, atr, entry, stop, target, target_kind,
          expected_move, delta_mode, delta, delta_pct, poc, vah, val, imbalances, absorption, evidence, price_confirmation, option_plan, cost_pct, would_trade_if_live, would_not_trade_reason)
        VALUES (${a.underlying}, ${a.exchange}, ${a.mode}, ${new Date(decisionBar)}, ${c.direction}, ${OF1_VERSION}, ${c.subtype}, ${c.location.kind}, ${c.location.price}, ${c.atr}, ${c.entry}, ${c.stop},
          ${c.target?.price ?? null}, ${c.target?.kind ?? null}, ${v.expectedMove}, ${c.deltaMode}, ${c.delta}, ${c.deltaPct}, ${c.poc}, ${c.vah}, ${c.val}, ${c.imbalances}, ${c.absorption},
          ${sql.json({ found: c.evidence, measurable: c.measurable } as any)}, ${c.priceConfirmation}, ${v.plan ? sql.json(v.plan as any) : null}, ${v.costPct}, ${v.wouldTrade}, ${v.reasons.length ? v.reasons.join('; ') : null})
        ON CONFLICT (symbol, exchange, mode, decision_bar_time, direction) DO NOTHING
      `;
    }
    return candidates.length;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying: a.underlying }, 'OF1 shadow: evaluation failed');
    return 0;
  }
}
