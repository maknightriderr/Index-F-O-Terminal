// ============================================================
// TRADE COSTS — the estimated cost of one paper trade, by component (2026-10-09)
// ============================================================
// The builder (estimateRoundTripCost, analytics) reduces a trade's cost to one
// number — `estimatedCostPct`. This writes the same number out in its parts,
// once, at the mint, so a later review can ask what the spread, the slippage
// allowance, the statutory charges and the brokerage each came to, in ₹, in %
// of premium, in R and as a share of the planned gross profit.
//
// EVERY figure here is a MODEL. Paper fills have no actual spread, slippage or
// charges, so `basis` is ESTIMATED_MODEL on every record, each component says
// where it came from, and `actual` is null with the reason. A modelled cost is
// never presented as an actual fill.
//
// Measurement only: nothing in the decision path reads this; the builder's own
// cost (and so every gate, stop, target and ranking) is unchanged. The
// reconciliation field proves the parts add up to that same number.
// ============================================================

import { TRADING_COST_MODEL } from '@fno/shared';
import type { OptionChain, TradeSetup } from '@fno/shared';
import { sql } from '../lib/db.js';
import { insertOnce } from '../lib/insert-once.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { schemaFileReady } from './ensure-capture-schema.js';

export const TRADE_MEASUREMENT_MIGRATION = '040_trade_measurement.sql';
export const COST_RECORD_VERSION = 'COST-1.0';
export const COST_BASIS = 'ESTIMATED_MODEL' as const;

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CostPart {
  /** ₹ per option unit (one share / barrel / gram of the contract). */
  perUnit: number;
  /** As % of the entry premium. */
  pctOfEntry: number;
}

export interface TradeCostRecord {
  version: string;
  basis: typeof COST_BASIS;
  /** What the quote and sizing inputs were. */
  inputs: { entry: number; stopLoss: number; target: number; bid: number | null; ask: number | null; lotSize: number | null };
  /** QUOTE = the leg's own two-sided quote at the mint; FALLBACK_ASSUMED = the model's default spread (no usable quote). */
  spread: CostPart & { source: 'QUOTE' | 'FALLBACK_ASSUMED'; assumedPct: number | null };
  slippage: CostPart & { assumedPct: number };
  statutory: CostPart & { assumedPct: number };
  brokerage: CostPart & { orders: number; perOrderInr: number; perLotInr: number };
  gstOnBrokerage: CostPart & { gstPct: number; perLotInr: number };
  /** Nothing else is configured in TRADING_COST_MODEL; listed so an addition is visible. */
  otherConfigured: Array<{ name: string; perUnit: number }>;
  total: CostPart & { perLotInr: number | null };
  /** Total cost as a multiple of the trade's planned risk (entry − initial stop); null without a positive risk. */
  costR: number | null;
  /** Total cost as % of the planned gross profit (target − entry); null without a positive gain. */
  costPctOfPlannedGrossProfit: number | null;
  plannedRiskPerUnit: number | null;
  plannedGrossProfitPerUnit: number | null;
  /** The builder's own figure (TradeSetup.estimatedCostPct) and whether these parts add up to it. */
  reconciliation: { setupEstimatedCostPct: number | null; sumOfPartsPct: number; matchesSetup: boolean | null };
  /** No actual fills exist for a paper trade. */
  actual: null;
  actualNote: string;
}

export interface CostInput {
  entry: number;
  stopLoss: number;
  target: number;
  bid: number | null;
  ask: number | null;
  lotSize: number | null;
  /** TradeSetup.estimatedCostPct, for the reconciliation. */
  setupEstimatedCostPct?: number | null;
}

/** Pure: the cost of one trade in its parts. Same arithmetic as estimateRoundTripCost (analytics), written out component by component. */
export function buildCostRecord(i: CostInput): TradeCostRecord | null {
  const { entry, stopLoss, target } = i;
  if (!(entry > 0)) return null;
  const quoted = i.bid != null && i.ask != null && i.bid > 0 && i.ask > i.bid;
  const spreadPerUnit = quoted ? i.ask! - i.bid! : entry * (TRADING_COST_MODEL.fallbackSpreadPct / 100);
  const lot = i.lotSize != null && i.lotSize > 0 ? i.lotSize : null;
  const brokerageOrders = 2;
  const brokerageInr = brokerageOrders * TRADING_COST_MODEL.brokeragePerOrder;
  const gstInr = brokerageInr * (TRADING_COST_MODEL.gstPct / 100);
  const part = (perUnit: number): CostPart => ({ perUnit: r4(perUnit), pctOfEntry: r4((perUnit / entry) * 100) });

  const slippage = entry * (TRADING_COST_MODEL.slippagePct / 100);
  const statutory = entry * (TRADING_COST_MODEL.statutoryPct / 100);
  const brokeragePerUnit = lot ? brokerageInr / lot : 0;
  const gstPerUnit = lot ? gstInr / lot : 0;
  const totalPerUnit = spreadPerUnit + slippage + statutory + brokeragePerUnit + gstPerUnit;

  const risk = entry - stopLoss;
  const gain = target - entry;
  const sumPct = r2((totalPerUnit / entry) * 100);
  const setupPct = i.setupEstimatedCostPct ?? null;
  return {
    version: COST_RECORD_VERSION,
    basis: COST_BASIS,
    inputs: { entry, stopLoss, target, bid: i.bid, ask: i.ask, lotSize: lot },
    spread: { ...part(spreadPerUnit), source: quoted ? 'QUOTE' : 'FALLBACK_ASSUMED', assumedPct: quoted ? null : TRADING_COST_MODEL.fallbackSpreadPct },
    slippage: { ...part(slippage), assumedPct: TRADING_COST_MODEL.slippagePct },
    statutory: { ...part(statutory), assumedPct: TRADING_COST_MODEL.statutoryPct },
    brokerage: { ...part(brokeragePerUnit), orders: brokerageOrders, perOrderInr: TRADING_COST_MODEL.brokeragePerOrder, perLotInr: brokerageInr },
    gstOnBrokerage: { ...part(gstPerUnit), gstPct: TRADING_COST_MODEL.gstPct, perLotInr: r2(gstInr) },
    otherConfigured: [],
    total: { ...part(totalPerUnit), perLotInr: lot ? r2(totalPerUnit * lot) : null },
    costR: risk > 0 ? r4(totalPerUnit / risk) : null,
    costPctOfPlannedGrossProfit: gain > 0 ? r2((totalPerUnit / gain) * 100) : null,
    plannedRiskPerUnit: risk > 0 ? r4(risk) : null,
    plannedGrossProfitPerUnit: gain > 0 ? r4(gain) : null,
    reconciliation: { setupEstimatedCostPct: setupPct, sumOfPartsPct: sumPct, matchesSetup: setupPct == null ? null : Math.abs(setupPct - sumPct) <= 0.011 },
    actual: null,
    actualNote: 'Paper trade: there is no actual fill, spread paid, slippage or charge — every figure above is the cost MODEL applied to the quote at the mint.',
  };
}

/** Pure: the leg a setup was built on, in the chain it was built from. */
export function legOfSetup(chain: Pick<OptionChain, 'strikes'>, setup: Pick<TradeSetup, 'strike' | 'side'>) {
  if (setup.strike == null || !setup.side) return null;
  const row = chain.strikes.find((s) => s.strike === setup.strike);
  if (!row) return null;
  return (setup.side === 'CE' ? row.call : row.put) ?? null;
}

/** Pure: the record for a minted naked-long setup and the chain it was priced from. Null for anything it cannot describe. */
export function costRecordForSetup(setup: TradeSetup, chain: Pick<OptionChain, 'strikes' | 'lotSize'>): TradeCostRecord | null {
  if (!setup.available || (setup.structureType ?? 'NAKED_LONG') !== 'NAKED_LONG') return null;
  if (setup.entry == null || setup.stopLoss == null || setup.target == null) return null;
  const leg = legOfSetup(chain, setup);
  return buildCostRecord({
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    target: setup.target,
    bid: leg ? Number(leg.bid) : null,
    ask: leg ? Number(leg.ask) : null,
    lotSize: setup.positionSize?.lotSize ?? chain.lotSize ?? null,
    setupEstimatedCostPct: setup.estimatedCostPct ?? null,
  });
}

export const PENDING_COST_RECORDS_KEY = 'pending_cost_records';

interface CostWrite {
  signalId: string;
  symbol: string;
  exchange: string;
  mode: string;
  source: string;
  mintedAt: number;
  record: TradeCostRecord;
}

async function insertCostRecord(args: CostWrite): Promise<void> {
  await insertOnce(sql`
      INSERT INTO trade_cost_records (signal_id, symbol, exchange, mode, source, minted_at, cost_version, basis, cost)
      VALUES (${args.signalId}, ${args.symbol}, ${args.exchange}, ${args.mode}, ${args.source}, ${new Date(args.mintedAt)},
        ${args.record.version}, ${args.record.basis}, ${sql.json(args.record as any)})
    `);
}

/**
 * Writes the record once. Never throws: a measurement write must not fail a mint. A refused
 * write is logged and queued in Redis; drainPendingCostRecords retries it from the monitor sweep.
 */
export async function persistTradeCostRecord(args: CostWrite): Promise<void> {
  if (!schemaFileReady(TRADE_MEASUREMENT_MIGRATION)) return;
  try {
    await insertCostRecord(args);
  } catch (err: any) {
    logger.warn({ error: err.message, signalId: args.signalId }, 'Trade cost record: write failed — queued for retry');
    await redis.rpush(PENDING_COST_RECORDS_KEY, JSON.stringify(args)).catch((e: any) => logger.error({ error: e.message, signalId: args.signalId }, 'Trade cost record: could not be queued either'));
  }
}

/** Retries queued cost records (idempotent: an already-stored record counts as written). Stops at the first refusal. Never throws. */
export async function drainPendingCostRecords(): Promise<{ written: number; remaining: number }> {
  if (!schemaFileReady(TRADE_MEASUREMENT_MIGRATION)) return { written: 0, remaining: 0 };
  let written = 0;
  let items: string[] = [];
  try {
    items = await redis.lrange(PENDING_COST_RECORDS_KEY, 0, -1);
    for (const item of items) {
      let args: CostWrite;
      try {
        args = JSON.parse(item);
      } catch {
        await redis.lrem(PENDING_COST_RECORDS_KEY, 1, item);
        continue;
      }
      try {
        await insertCostRecord(args);
      } catch (err: any) {
        logger.warn({ error: err.message, signalId: args.signalId }, 'Trade cost record: retry refused — kept queued');
        break;
      }
      await redis.lrem(PENDING_COST_RECORDS_KEY, 1, item);
      written++;
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Trade cost record: retry pass failed');
  }
  return { written, remaining: Math.max(0, items.length - written) };
}

/** Fire-and-forget entry point for the mint path. */
export function recordTradeCosts(args: {
  signalId: string;
  symbol: string;
  exchange: string;
  mode: string;
  source: string;
  mintedAt: number;
  setup: TradeSetup;
  chain: Pick<OptionChain, 'strikes' | 'lotSize'>;
}): void {
  try {
    const record = costRecordForSetup(args.setup, args.chain);
    if (!record) return;
    void persistTradeCostRecord({ signalId: args.signalId, symbol: args.symbol, exchange: args.exchange, mode: args.mode, source: args.source, mintedAt: args.mintedAt, record });
  } catch (err: any) {
    logger.warn({ error: err.message, signalId: args.signalId }, 'Trade cost record: could not be built');
  }
}
