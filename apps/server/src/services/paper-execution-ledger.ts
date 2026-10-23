// ============================================================
// PAPER EXECUTION LEDGER (LEDGER-1.0, 2026-10-23) — measurement only
// ============================================================
// The official paper result records ONE price per side, under a fixed policy:
//   entry  = the option's mid at the decision (trade-setup/index.ts),
//   target = a resting limit filled AT the target once the observed LTP
//            reaches it — min(LTP, target) (market-bias.ts exitValueForPriceHit),
//   others = the observed LTP when the exit fired (stop, session end, reversal…).
// The quote that triggered an exit was never kept, so an exit at the target
// could not be told apart from an executable one. This ledger keeps, beside
// (never instead of) the official price:
//   - the observed quote: bid, ask, LTP, top-of-book quantities, underlying,
//     exchange / last-trade / receipt times and the quote's age;
//   - the order type, the official fill policy and its version, the original
//     stop, the current stop and the target;
//   - a SIMULATED quote-based fill, explicitly an estimate, not a fill:
//     entry at the ask, a market exit at the bid, a target only when the BID
//     reached the target (an LTP touch alone never fills a limit; queue
//     position is unknown either way). A missing, one-sided or stale quote
//     gives no simulated price, only its quality.
// Spread is embedded in a simulated price, so reporting must not deduct the
// spread again; fees and any extra slippage / latency allowance are separate
// assumptions applied in reporting, never here.
// MARK rows: at most one per minute per open trade, from quotes the monitor
// already receives (tick feed, 90 s chain sweep) — no extra broker polling.
// Nothing here is read by any decision. Every write is fire-and-forget.
// ============================================================

import type { Exchange, OptionChain, TradingMode } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { bookUnit } from './book-units.js';

export const LEDGER_MIGRATION = '044_paper_execution_ledger.sql';
// 1.1 (2026-10-23): MCX top-of-book sizes are compared in units (book lots x lot size); 1.0 compared lots with units.
export const LEDGER_VERSION = 'LEDGER-1.1';


/** The official policy as implemented today (documentation of existing behaviour, not a change). */
export const OFFICIAL_FILL_POLICY_VERSION = 'FILL-1.0';
/** An exchange quote older than this is STALE: no simulated price. */
export const MAX_QUOTE_AGE_MS = 60_000;
export const MARK_EVERY_MS = 60_000;

export type LedgerEvent = 'ENTRY' | 'EXIT' | 'MARK';
export type OrderType = 'ENTRY_MARKETABLE' | 'LIMIT_TARGET' | 'STOP_MARKET' | 'MARKET_EXIT' | 'NONE';
export type QuoteQuality =
  | 'OK'
  | 'NO_QUOTE'
  | 'ONE_SIDED'
  | 'STALE'
  | 'AGE_UNKNOWN'
  | 'SIZE_INSUFFICIENT'
  | 'SIZE_UNKNOWN'
  | 'LIMIT_NOT_EXECUTABLE'
  | 'NOT_APPLICABLE';

export interface QuoteObservation {
  source: 'CHAIN' | 'TICK' | 'BACKFILL';
  token: string | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  underlying: number | null;
  /** When the exchange published the quote (epoch ms), when the broker said. */
  exchangeAt: number | null;
  lastTradeAt: number | null;
  /** When this server received it (epoch ms). */
  receivedAt: number;
  /** Tick feed freshness state, when the observation is a tick. */
  feedState: string | null;
}

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Pure: the observation of one leg of a chain (null leg → an observation with no prices). */
export function observeChainLeg(chain: OptionChain | null, strike: number | null | undefined, side: 'CE' | 'PE' | null | undefined, expiry: string | null | undefined, at: number): QuoteObservation {
  const sameContract = chain && strike != null && side && (!expiry || chain.expiry === expiry);
  const row = sameContract ? chain!.strikes.find((s) => s.strike === strike) : undefined;
  const leg: any = row ? (side === 'CE' ? row.call : row.put) : undefined;
  return {
    source: 'CHAIN',
    token: leg?.token ?? null,
    ltp: pos(leg?.ltp),
    bid: pos(leg?.bid),
    ask: pos(leg?.ask),
    bidQty: nonNeg(leg?.bidQty),
    askQty: nonNeg(leg?.askQty),
    underlying: pos(chain?.spotPrice),
    exchangeAt: pos(leg?.exchangeTimestamp),
    lastTradeAt: pos(leg?.lastTradeTimestamp),
    receivedAt: pos(leg?.timestamp) ?? at,
    feedState: null,
  };
}

/** Pure: the observation of one tick. */
export function observeTick(tick: { token: string; ltp: number; bid?: number; ask?: number; bidQty?: number; askQty?: number; timestamp: number; exchangeTimestamp?: number }, feedState: string | null): QuoteObservation {
  return {
    source: 'TICK',
    token: tick.token,
    ltp: pos(tick.ltp),
    bid: pos(tick.bid),
    ask: pos(tick.ask),
    bidQty: nonNeg(tick.bidQty),
    askQty: nonNeg(tick.askQty),
    underlying: null,
    exchangeAt: pos(tick.exchangeTimestamp),
    lastTradeAt: null,
    receivedAt: tick.timestamp,
    feedState,
  };
}

export function quoteAgeMs(o: QuoteObservation): number | null {
  return o.exchangeAt != null ? Math.max(0, o.receivedAt - o.exchangeAt) : null;
}

/** Pure: the order an exit is, by its recorded close reason. */
export function orderTypeOf(closeReason: string): OrderType {
  if (closeReason === 'TARGET') return 'LIMIT_TARGET';
  if (closeReason === 'STOP_LOSS' || closeReason === 'TRAILING_STOP' || closeReason === 'BREAKEVEN_STOP') return 'STOP_MARKET';
  return 'MARKET_EXIT';
}

/** Pure: the OFFICIAL price policy behind the recorded paper price (what the trade row holds). */
export function officialFillPolicy(event: LedgerEvent, orderType: OrderType): string {
  if (event === 'ENTRY') return 'MID_AT_DECISION';
  if (event === 'MARK') return 'NONE';
  return orderType === 'LIMIT_TARGET' ? 'TARGET_LIMIT_MIN_LTP_TARGET' : 'OBSERVED_LTP';
}

export interface SimulatedFill {
  price: number | null;
  basis: 'ASK' | 'BID' | 'TARGET_LIMIT_BID_REACHED' | 'NONE';
  quality: QuoteQuality;
}

function bookQuality(o: QuoteObservation, side: 'BUY' | 'SELL', quantity: number | null, unit = 1): QuoteQuality | null {
  if (o.bid == null && o.ask == null) return 'NO_QUOTE';
  if (o.bid == null || o.ask == null || o.ask < o.bid) return 'ONE_SIDED';
  const age = quoteAgeMs(o);
  if (age != null && age > MAX_QUOTE_AGE_MS) return 'STALE';
  if (o.feedState != null && o.feedState !== 'DATA_FRESH') return 'STALE';
  const top = side === 'BUY' ? o.askQty : o.bidQty;
  if (quantity != null && quantity > 0 && top != null && top * unit < quantity) return 'SIZE_INSUFFICIENT';
  return null;
}

/**
 * Pure: the quote-based estimate for an entry (buy at the ask) or an exit
 * (sell at the bid; a target limit only when the bid reached the target).
 * The price is withheld whenever the book cannot support it.
 */
export function simulateFill(o: QuoteObservation, event: LedgerEvent, orderType: OrderType, target: number | null, quantity: number | null, unit = 1): SimulatedFill {
  if (event === 'MARK') return { price: null, basis: 'NONE', quality: 'NOT_APPLICABLE' };
  const side = event === 'ENTRY' ? 'BUY' : 'SELL';
  const bad = bookQuality(o, side, quantity, unit);
  if (bad === 'NO_QUOTE' || bad === 'ONE_SIDED' || bad === 'STALE') return { price: null, basis: 'NONE', quality: bad };
  // Size: insufficient top-of-book quantity keeps the estimate but labels it; unknown size is labelled too.
  const sized: QuoteQuality = bad ?? (quantity != null && (side === 'BUY' ? o.askQty : o.bidQty) == null ? 'SIZE_UNKNOWN' : 'OK');
  const finalQ: QuoteQuality = sized === 'OK' && quoteAgeMs(o) == null ? 'AGE_UNKNOWN' : sized;
  if (event === 'ENTRY') return { price: o.ask, basis: 'ASK', quality: finalQ };
  if (orderType === 'LIMIT_TARGET') {
    if (target == null) return { price: null, basis: 'NONE', quality: 'NO_QUOTE' };
    // An LTP at the target is a trade print; a resting sell fills only if a buyer bids that much.
    return o.bid! >= target ? { price: target, basis: 'TARGET_LIMIT_BID_REACHED', quality: finalQ } : { price: null, basis: 'NONE', quality: 'LIMIT_NOT_EXECUTABLE' };
  }
  return { price: o.bid, basis: 'BID', quality: finalQ };
}

export interface LedgerTrade {
  signalId: string;
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  entry: number | null;
  initialStop: number | null;
  currentStop: number | null;
  target: number | null;
  quantity: number | null;
  lotSize: number | null;
  riskBudgetInr: number | null;
  capitalInr: number | null;
}

export interface LedgerRow {
  event: LedgerEvent;
  trade: LedgerTrade;
  quote: QuoteObservation;
  closeReason: string | null;
  /** The official paper price written to the trade row (entry, or exit). Null for a MARK. */
  assignedFill: number | null;
}

/** Pure: the row as written (exported for tests). */
export function ledgerRecord(r: LedgerRow) {
  const orderType: OrderType = r.event === 'ENTRY' ? 'ENTRY_MARKETABLE' : r.event === 'EXIT' ? orderTypeOf(r.closeReason ?? '') : 'NONE';
  const sim = simulateFill(r.quote, r.event, orderType, r.trade.target, r.trade.quantity, bookUnit(r.trade.exchange, r.trade.lotSize));
  return {
    signalId: r.trade.signalId,
    event: r.event,
    observedAt: new Date(r.quote.receivedAt),
    exchangeAt: r.quote.exchangeAt != null ? new Date(r.quote.exchangeAt) : null,
    lastTradeAt: r.quote.lastTradeAt != null ? new Date(r.quote.lastTradeAt) : null,
    quoteAgeMs: quoteAgeMs(r.quote),
    quoteSource: r.quote.source,
    feedState: r.quote.feedState,
    symbol: r.trade.symbol,
    exchange: r.trade.exchange,
    mode: r.trade.mode,
    token: r.quote.token,
    ltp: r.quote.ltp,
    bid: r.quote.bid,
    ask: r.quote.ask,
    bidQty: r.quote.bidQty,
    askQty: r.quote.askQty,
    underlying: r.quote.underlying,
    orderType,
    closeReason: r.closeReason,
    originalEntry: r.trade.entry,
    originalStop: r.trade.initialStop,
    currentStop: r.trade.currentStop,
    target: r.trade.target,
    assignedFill: r.assignedFill,
    fillPolicy: officialFillPolicy(r.event, orderType),
    fillPolicyVersion: OFFICIAL_FILL_POLICY_VERSION,
    simFill: sim.price,
    simBasis: sim.basis,
    simQuality: sim.quality,
    paperQuantity: r.trade.quantity,
    lotSize: r.trade.lotSize,
    riskBudgetInr: r.trade.riskBudgetInr,
    capitalInr: r.trade.capitalInr,
    ledgerVersion: LEDGER_VERSION,
  };
}

async function write(r: LedgerRow): Promise<void> {
  if (!schemaFileReady(LEDGER_MIGRATION)) return;
  const x = ledgerRecord(r);
  await sql`
    INSERT INTO paper_execution_observations (signal_id, event, observed_at, exchange_at, last_trade_at, quote_age_ms, quote_source, feed_state,
      symbol, exchange, mode, token, ltp, bid, ask, bid_qty, ask_qty, underlying, order_type, close_reason, original_entry, original_stop, current_stop,
      target, assigned_fill, fill_policy, fill_policy_version, sim_fill, sim_basis, sim_quality, paper_quantity, lot_size, risk_budget_inr, capital_inr, ledger_version)
    VALUES (${x.signalId}, ${x.event}, ${x.observedAt}, ${x.exchangeAt}, ${x.lastTradeAt}, ${x.quoteAgeMs}, ${x.quoteSource}, ${x.feedState},
      ${x.symbol}, ${x.exchange}, ${x.mode}, ${x.token}, ${x.ltp}, ${x.bid}, ${x.ask}, ${x.bidQty}, ${x.askQty}, ${x.underlying}, ${x.orderType}, ${x.closeReason},
      ${x.originalEntry}, ${x.originalStop}, ${x.currentStop}, ${x.target}, ${x.assignedFill}, ${x.fillPolicy}, ${x.fillPolicyVersion}, ${x.simFill}, ${x.simBasis},
      ${x.simQuality}, ${x.paperQuantity}, ${x.lotSize}, ${x.riskBudgetInr}, ${x.capitalInr}, ${x.ledgerVersion})
    ON CONFLICT (signal_id, event, observed_at) DO NOTHING
  `;
}

/** Fire-and-forget: a ledger failure never touches the trade. */
export function recordLedger(r: LedgerRow): void {
  void write(r).catch((err: any) => logger.warn({ error: err?.message, signalId: r.trade.signalId, event: r.event }, 'Paper execution ledger: write failed (measurement only)'));
}

const lastMarkAt = new Map<string, number>();
/** A MARK at most once a minute per open trade, from a quote the monitor already has. */
export function recordMark(trade: LedgerTrade, quote: QuoteObservation): boolean {
  const last = lastMarkAt.get(trade.signalId);
  if (last != null && quote.receivedAt - last < MARK_EVERY_MS) return false;
  lastMarkAt.set(trade.signalId, quote.receivedAt);
  if (lastMarkAt.size > 2_000) for (const k of [...lastMarkAt.keys()].slice(0, 1_000)) lastMarkAt.delete(k);
  recordLedger({ event: 'MARK', trade, quote, closeReason: null, assignedFill: null });
  return true;
}

/** Tests only. */
export function resetLedgerThrottle(): void {
  lastMarkAt.clear();
}

/** The ledger's view of a stored setup. */
export function ledgerTradeOf(
  s: { signalId?: string; entry?: number | null; initialStopLoss?: number | null; stopLoss?: number | null; target?: number | null; positionSize?: { quantity?: number; lotSize?: number; riskAmount?: number; capital?: number } | null },
  symbol: string,
  exchange: Exchange,
  mode: TradingMode
): LedgerTrade | null {
  if (!s.signalId) return null;
  return {
    signalId: s.signalId,
    symbol,
    exchange,
    mode,
    entry: s.entry ?? null,
    initialStop: s.initialStopLoss ?? s.stopLoss ?? null,
    currentStop: s.stopLoss ?? null,
    target: s.target ?? null,
    quantity: s.positionSize?.quantity ?? null,
    lotSize: s.positionSize?.lotSize ?? null,
    riskBudgetInr: s.positionSize?.riskAmount ?? null,
    capitalInr: s.positionSize?.capital ?? null,
  };
}
