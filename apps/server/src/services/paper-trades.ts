// ============================================================
// PAPER TRADES — one authoritative, read-only view (display only)
// ============================================================
// The trade records lived in three places (the asset workspace's Trade Setup
// card, the Backtesting list, Alerts). This joins what the system ALREADY
// recorded into one list for the Paper Trades page and the Dashboard panel:
//
//   * the persisted trade row (signals.inputs): entry, stop at the mint, target,
//     outcome, exit, close reason, logic version, source
//   * the open slot in Redis (trade_setup:*): the current stop, position size,
//     health — present only while the monitor is tracking the trade
//   * the monitor's latest observation (trade-marks.ts): premium + when seen
//   * the per-trade cost record (trade_cost_records), where one exists
//
// Nothing here prices a contract, creates, closes or changes a trade, or writes
// anything. R is computed with the SAME definition as the measurement report
// (entry − stop at the mint; net subtracts the ESTIMATED cost in R), so the
// frontend never repeats a trade calculation.
// ============================================================

import { ESTIMATED_ROUND_TRIP_COST_PCT, engineBadge, researchTriggerOf } from '@fno/shared';
import type { PaperTradeStatus, PaperTradeView, PaperTradesResponse, TradeSetupRecord } from '@fno/shared';
import { sql } from '../lib/db.js';
import { redis, scanKeys } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { getTradeSetupHistory } from './backtesting.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { readTradeMarks, type TradeMark } from './trade-marks.js';
import { TRADE_MEASUREMENT_MIGRATION } from './trade-costs.js';
import { BASELINE_CHANGE_AT, MEASUREMENT_RELIABLE_FROM, TRACKING_FIX_DEPLOYED_AT, cohortOf, eligibilityOf, type MeasuredTrade } from './measurement-core.js';

export const PAPER_TRADE_DISCLOSURE = 'Simulated paper trade — no broker order was placed. Costs are estimates, not actual fills.';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/** The open slot's fields this view reads (a subset of the monitor's stored trade). */
export interface OpenSlot {
  signalId?: string;
  stopLoss?: number | null;
  initialStopLoss?: number | null;
  positionSize?: { quantity?: number | null } | null;
  health?: { state: string; score?: number; at: number; reason: string } | null;
}

export interface CostRecordLite {
  spreadSource: 'QUOTE' | 'FALLBACK_ASSUMED' | null;
  totalPerLotInr: number | null;
  costPctOfPlannedGrossProfit: number | null;
}

/** Display name of the engine / trigger family (the recorded `source`); the legacy badge when none was recorded. */
export function strategyLabelOf(source: string | null, legacyBadge: string): string {
  if (!source) return legacyBadge;
  const known: Record<string, string> = { INDICATOR: 'Indicator Engine', S1: 'Structure S1', MOMENTUM_BREAK: 'Momentum Break', OB1: 'Order Block OB1', OF1: 'Order Flow OF1' };
  if (known[source]) return known[source];
  return /^[A-F][0-9]$/.test(source) ? `Paper research · ${source}` : source;
}

const r4 = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10_000) / 10_000);

export function measuredTradeOfRecord(r: TradeSetupRecord): MeasuredTrade {
  return {
    id: r.id,
    symbol: r.symbol,
    exchange: r.exchange,
    family: r.source ?? 'UNKNOWN',
    mintedAt: r.generatedAt,
    mode: r.mode,
    structureType: r.structureType,
    outcome: r.outcome,
    closeReason: r.closeReason ?? null,
    voided: r.voided === true,
    generatedOffSession: r.generatedOffSession,
    entry: r.entry,
    initialStop: r.stopLoss,
    target: r.target,
    exitPrice: r.exitPrice,
    estimatedCostPct: r.estimatedCostPct ?? null,
    cost: null,
  };
}

const EXCLUSION_TEXT: Record<string, string> = {
  VOIDED: 'Voided: the recorded outcome is known to be invalid (excluded from performance).',
  TRACKING_LOST: 'Tracking lost: the real exit is unknown (excluded from performance).',
  OFF_SESSION: 'Minted while the market was closed — priced off frozen quotes (excluded from performance).',
  SPREAD: 'Multi-leg spread: measured against maximum loss, not premium (excluded from the premium-R figures).',
  NO_GEOMETRY: 'Entry, stop or exit missing: R cannot be computed (excluded from performance).',
  OPEN: 'Still open: not part of any closed-trade figure yet.',
};

/** Pure: one trade as the UI shows it. */
export function buildPaperTradeView(
  r: TradeSetupRecord,
  ctx: { now: number; slot?: OpenSlot | null; mark?: TradeMark | null; cost?: CostRecordLite | null }
): PaperTradeView {
  const m = measuredTradeOfRecord(r);
  const eligibility = eligibilityOf(m);
  const isOpen = r.outcome == null;
  const slotTracked = isOpen && ctx.slot != null && ctx.slot.signalId === r.id;

  let status: PaperTradeStatus;
  if (eligibility === 'TRACKING_LOST') status = 'TRACKING_LOST';
  else if (eligibility === 'VOIDED') status = 'VOIDED';
  else if (eligibility === 'OFF_SESSION') status = 'OFF_SESSION';
  else if (eligibility === 'SPREAD') status = 'SPREAD';
  else if (isOpen) status = slotTracked ? 'OPEN_TRACKED' : 'OPEN_UNTRACKED';
  else if (eligibility === 'NO_GEOMETRY') status = 'INCOMPLETE';
  else status = 'CLOSED';

  const entry = r.entry;
  const stop0 = r.stopLoss;
  const risk = entry != null && stop0 != null && entry - stop0 > 0 ? entry - stop0 : null;
  const costPct = r.estimatedCostPct ?? null;
  const costBasis = costPct != null ? ('ESTIMATED_MODEL' as const) : r.structureType === 'SPREAD' ? ('UNAVAILABLE' as const) : ('DEFAULT_ASSUMPTION' as const);
  const effectiveCostPct = costPct ?? (r.structureType === 'SPREAD' ? null : ESTIMATED_ROUND_TRIP_COST_PCT);
  const costR = risk != null && entry != null && effectiveCostPct != null ? r4(((effectiveCostPct / 100) * entry) / risk) : null;

  const premiumRisk = r.structureType === 'NAKED_LONG' ? risk : null;
  const grossR = !isOpen && premiumRisk != null && r.exitPrice != null && entry != null ? r4((r.exitPrice - entry) / premiumRisk) : null;
  const netR = grossR != null && costR != null ? r4(grossR - costR) : null;

  let live: PaperTradeView['live'] = null;
  if (isOpen) {
    const premium = ctx.mark?.premium ?? null;
    const observedAt = ctx.mark?.at ?? null;
    const unrealisedGrossR = premium != null && premiumRisk != null && entry != null ? r4((premium - entry) / premiumRisk) : null;
    const quantity = ctx.slot?.positionSize?.quantity ?? null;
    live = {
      premium,
      observedAt,
      ageSeconds: observedAt != null ? Math.max(0, Math.round((ctx.now - observedAt) / 1000)) : null,
      unrealisedGrossR,
      unrealisedNetR: unrealisedGrossR != null && costR != null ? r4(unrealisedGrossR - costR) : null,
      unrealisedPnlInr: premium != null && entry != null && quantity != null && quantity > 0 ? Math.round((premium - entry) * quantity * 100) / 100 : null,
      quantity: quantity != null && quantity > 0 ? quantity : null,
      health: ctx.slot?.health ? { state: ctx.slot.health.state, at: ctx.slot.health.at, reason: ctx.slot.health.reason } : null,
      slotTracked,
    };
  }

  const badge = engineBadge(r.strategy, researchTriggerOf(r.logicVersion ?? null));
  const exitAt = r.exitTime ?? null;
  return {
    id: r.id,
    symbol: r.symbol,
    exchange: r.exchange,
    mode: r.mode,
    structureType: r.structureType,
    side: r.side,
    strike: r.strike,
    expiry: r.expiry ?? null,
    direction: r.direction,
    family: r.source ?? null,
    strategyLabel: strategyLabelOf(r.source ?? null, badge.label),
    logicVersion: r.logicVersion ?? null,
    mintedAt: r.generatedAt,
    state: r.outcome ?? 'OPEN',
    status,
    includedInPerformance: eligibility === 'ELIGIBLE',
    excludedReason: eligibility === 'ELIGIBLE' ? null : EXCLUSION_TEXT[eligibility] ?? null,
    cohort: cohortOf(r.generatedAt),
    measurementReliable: r.generatedAt >= MEASUREMENT_RELIABLE_FROM,
    entry,
    initialStop: stop0,
    currentStop: isOpen ? ctx.slot?.stopLoss ?? null : null,
    target: r.target,
    plannedRiskReward: r.riskReward > 0 ? r.riskReward : null,
    exitPrice: r.exitPrice,
    exitAt,
    closeReason: r.closeReason ?? null,
    holdMinutes: exitAt != null ? Math.max(0, Math.round((exitAt - r.generatedAt) / 60_000)) : isOpen ? Math.max(0, Math.round((ctx.now - r.generatedAt) / 60_000)) : null,
    grossR,
    netR,
    returnPercent: r.returnPercent,
    estimatedCost: { pct: effectiveCostPct, basis: costBasis, costR, record: ctx.cost ?? null },
    live,
    disclosure: PAPER_TRADE_DISCLOSURE,
  };
}

/** Pure: the response around a list of views. */
/** `recorded` is the number of paper trades in the database (null when unknown); the rows given may be only the newest window of them. */
export function paperTradesResponse(trades: PaperTradeView[], recorded: number | null = null): PaperTradesResponse {
  return {
    trades,
    counts: {
      total: trades.length,
      open: trades.filter((t) => t.state === 'OPEN' && t.status !== 'TRACKING_LOST' && t.status !== 'VOIDED').length,
      openUntracked: trades.filter((t) => t.status === 'OPEN_UNTRACKED').length,
      closed: trades.filter((t) => t.state !== 'OPEN').length,
      excludedFromPerformance: trades.filter((t) => !t.includedInPerformance && t.state !== 'OPEN').length,
      recorded,
      truncated: recorded != null && recorded > trades.length,
    },
    measurementReliableFrom: new Date(MEASUREMENT_RELIABLE_FROM).toISOString(),
    cohortBoundaries: { baselineChangeAt: new Date(BASELINE_CHANGE_AT).toISOString(), trackingFixDeployedAt: new Date(TRACKING_FIX_DEPLOYED_AT).toISOString() },
  };
}

async function readOpenSlots(): Promise<Map<string, OpenSlot>> {
  const out = new Map<string, OpenSlot>();
  try {
    const keys = await scanKeys('trade_setup:*');
    if (!keys.length) return out;
    const raw = await redis.mget(...keys);
    for (const v of raw) {
      if (!v) continue;
      try {
        const s = JSON.parse(v) as OpenSlot & { available?: boolean };
        if (s.available !== false && s.signalId) out.set(s.signalId, s);
      } catch {
        /* an unparsable slot is simply not shown as tracking */
      }
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Paper trades: open slot read failed');
  }
  return out;
}

async function readCostRecords(ids: readonly string[]): Promise<Map<string, CostRecordLite>> {
  const out = new Map<string, CostRecordLite>();
  if (!ids.length || !schemaFileReady(TRADE_MEASUREMENT_MIGRATION)) return out;
  try {
    const rows = await sql<{ signal_id: string; cost: any }[]>`SELECT signal_id, cost FROM trade_cost_records WHERE signal_id = ANY(${ids as string[]})`;
    for (const r of rows) {
      const c = r.cost ?? {};
      out.set(r.signal_id, {
        spreadSource: c.spread?.source === 'QUOTE' || c.spread?.source === 'FALLBACK_ASSUMED' ? c.spread.source : null,
        totalPerLotInr: typeof c.total?.perLotInr === 'number' ? c.total.perLotInr : null,
        costPctOfPlannedGrossProfit: typeof c.costPctOfPlannedGrossProfit === 'number' ? c.costPctOfPlannedGrossProfit : null,
      });
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Paper trades: cost record read failed');
  }
  return out;
}

/** Pure: the newest window plus every still-open trade from the wider history that the window did not reach. */
export function withOpenBeyondWindow<T extends { id: string; outcome: unknown }>(window: T[], wider: readonly T[]): T[] {
  const seen = new Set(window.map((r) => r.id));
  return window.concat(wider.filter((r) => r.outcome == null && !seen.has(r.id)));
}

async function countRecorded(): Promise<number | null> {
  try {
    const rows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM signals WHERE signal_type = 'TRADE_SETUP'`;
    const n = Number(rows[0]?.n);
    return Number.isFinite(n) ? n : null;
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Paper trades: recorded count failed');
    return null;
  }
}

/**
 * The newest `limit` paper trades, joined with their live tracking and cost records, plus every OPEN trade older than that
 * window (an open position must never drop out of view because newer trades pushed it past the limit). Read-only.
 * `counts.recorded` / `counts.truncated` say how many trades exist, so a window is never presented as the whole history.
 */
export async function listPaperTrades(limitRaw?: number, now = Date.now()): Promise<PaperTradesResponse> {
  const limit = Math.min(Math.max(Math.trunc(limitRaw ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  let records = await getTradeSetupHistory(limit);
  if (records.length >= limit && limit < MAX_LIMIT) {
    records = withOpenBeyondWindow(records, await getTradeSetupHistory(MAX_LIMIT));
  }
  const recorded = await countRecorded();
  const openIds = records.filter((r) => r.outcome == null).map((r) => r.id);
  const [slots, marks, costs] = await Promise.all([readOpenSlots(), readTradeMarks(openIds), readCostRecords(records.map((r) => r.id))]);
  return paperTradesResponse(
    records.map((r) => buildPaperTradeView(r, { now, slot: slots.get(r.id) ?? null, mark: marks.get(r.id) ?? null, cost: costs.get(r.id) ?? null })),
    recorded
  );
}
