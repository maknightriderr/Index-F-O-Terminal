// ============================================================
// ORDER FLOW STORE — normalized trades → closed 15m footprints (measurement)
// ============================================================
// The Order Flow Adapter's output: per symbol, the trades of the open bar
// and the footprint of every closed bar (order-flow/index.ts), persisted to
// order_flow_bars. A closed bar with no usable trades is recorded
// UNAVAILABLE with its reason — never as zero volume / zero delta.
// OF1 paper and shadow read this through the explicit price-alignment boundary.
// ============================================================

import { gzipSync } from 'node:zlib';
import { buildFootprint, unavailableFootprint, flowPriceStep, istSession, type VwapSums, FLOW_MAX_UNRECONCILED_SHARE, ORDER_FLOW_VERSION, type DeltaMode, type FlowTrade, type FootprintBar } from '@fno/analytics';
import { isMarketOpen, type Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { tapedInput } from '../lib/io-tape.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { ORDER_FLOW_PRICE_STEP } from '../config/order-flow-flags.js';

export const ORDER_FLOW_MIGRATION = '038_order_blocks_order_flow_of1.sql';
/** Dhan engine v2 (7 Nov): unreconciled volume, tick / step columns and recorded flow events. */
export const ORDER_FLOW_EVENTS_MIGRATION = '052_order_flow_events.sql';
export const FLOW_BAR_MS = 15 * 60_000;
const KEEP_BARS = 400;
/** Stock futures keep fewer closed footprints in memory (~4 sessions; all are persisted). */
const KEEP_BARS_STOCK = 100;

interface SymbolFlow {
  exchange: string;
  instrument: string | null;
  source: string;
  mode: Exclude<DeltaMode, 'UNAVAILABLE'>;
  trades: FlowTrade[];
  /** Volume between packets no observed trade explains (open bar): time and quantity only. */
  unreconciled: Array<{ time: number; qty: number }>;
  kind: 'INDEX' | 'STOCK' | 'COMMODITY' | null;
  tickSize: number | null;
  /** The price-row step, fixed for the contract (ORDER_FLOW_PRICE_STEP, else flowPriceStep at its first trade). */
  priceStep: number | null;
  footprints: Map<number, FootprintBar>;
  /** The newest bar already finalized (written). */
  lastClosed: number | null;
  /** Dhan engine v2: trade-based session VWAP sums of the current contract (reset per IST session / contract). */
  vwap?: { session: string; instrument: string | null; sums: VwapSums; unreconciled: number };
  /** Engine v2 phase 4: the latest observed trade of the current contract. */
  lastTrade?: { price: number; at: number };
}

const flows = new Map<string, SymbolFlow>();
/** Set by the feed: whether it is connected (labels an empty bar's reason). */
let feedConnected = false;
export function setFlowFeedConnected(v: boolean): void {
  feedConnected = v;
}

/** The 15m bar a time falls in. IST is UTC+5:30, so the epoch 15-minute grid is the IST grid (09:15, 09:30, …). */
export const flowBarStart = (t: number) => Math.floor(t / FLOW_BAR_MS) * FLOW_BAR_MS;

export function registerFlowSymbol(symbol: string, args: { exchange: string; instrument: string | null; source: string; mode: Exclude<DeltaMode, 'UNAVAILABLE'>; startedAt: number; kind?: 'INDEX' | 'STOCK' | 'COMMODITY'; tickSize?: number | null }): void {
  const f = flows.get(symbol);
  if (f) {
    if (f.instrument !== args.instrument) {
      // Drop the mixed partial bar instead of attributing old-contract trades
      // to the new contract. Closed footprints retain their own identity.
      f.trades = [];
      f.unreconciled = [];
      f.priceStep = ORDER_FLOW_PRICE_STEP[symbol] ?? null;
      f.lastClosed = flowBarStart(args.startedAt);
      f.lastTrade = undefined;
    }
    f.kind = args.kind ?? f.kind;
    f.tickSize = args.tickSize ?? f.tickSize;
    f.instrument = args.instrument;
    f.source = args.source;
    f.mode = args.mode;
    return;
  }
  // Never backfill: the first bar finalized is the one after the feed started.
  flows.set(symbol, { exchange: args.exchange, instrument: args.instrument, source: args.source, mode: args.mode, trades: [], unreconciled: [], kind: args.kind ?? null, tickSize: args.tickSize ?? null, priceStep: ORDER_FLOW_PRICE_STEP[symbol] ?? null, footprints: new Map(), lastClosed: flowBarStart(args.startedAt) });
}

export function recordFlowTrade(symbol: string, trade: FlowTrade): void {
  const f = flows.get(symbol);
  if (!f || !(trade.qty > 0)) return;
  if (f.priceStep == null) f.priceStep = flowPriceStep(trade.price, f.tickSize);
  f.trades.push(trade);
  if (!f.lastTrade || trade.time >= f.lastTrade.at) f.lastTrade = { price: trade.price, at: trade.time };
  sessionVwap(f, trade.time).sums.pv += trade.price * trade.qty;
  f.vwap!.sums.v += trade.qty;
  f.vwap!.sums.p2v += trade.price * trade.price * trade.qty;
  recordFiveMinute(symbol, f.instrument, trade);
}

function sessionVwap(f: SymbolFlow, time: number): NonNullable<SymbolFlow['vwap']> {
  const session = istSession(time);
  if (!f.vwap || f.vwap.session !== session || f.vwap.instrument !== f.instrument) f.vwap = { session, instrument: f.instrument, sums: { pv: 0, v: 0, p2v: 0 }, unreconciled: 0 };
  return f.vwap;
}

/** Engine v2 read: one contract's state for the session of `now` (closed footprints of that session + VWAP sums). */
export function flowSessionState(symbol: string, now: number): { exchange: string; instrument: string | null; kind: SymbolFlow['kind']; tickSize: number | null; footprints: FootprintBar[]; vwap: { sums: VwapSums; unreconciled: number } | null } | null {
  const f = flows.get(symbol);
  if (!f) return null;
  const session = istSession(now);
  const footprints = [...f.footprints.values()].filter((fp) => istSession(fp.barTime) === session && fp.sourceInstrument === f.instrument).sort((a, b) => a.barTime - b.barTime);
  const v = f.vwap && f.vwap.session === session && f.vwap.instrument === f.instrument ? { sums: { ...f.vwap.sums }, unreconciled: f.vwap.unreconciled } : null;
  return { exchange: f.exchange, instrument: f.instrument, kind: f.kind, tickSize: f.tickSize, footprints, vwap: v };
}

/** Engine v2 setups: every closed footprint in memory of the symbol's CURRENT contract, oldest first. */
export function flowContractBars(symbol: string): { exchange: string; instrument: string | null; kind: SymbolFlow['kind']; tickSize: number | null; lastClosed: number | null; footprints: FootprintBar[] } | null {
  const f = flows.get(symbol);
  if (!f) return null;
  const footprints = [...f.footprints.values()].filter((fp) => fp.sourceInstrument === f.instrument).sort((a, b) => a.barTime - b.barTime);
  return { exchange: f.exchange, instrument: f.instrument, kind: f.kind, tickSize: f.tickSize, lastClosed: f.lastClosed, footprints };
}

/** The latest observed trade of the symbol's current contract, or null. */
export function flowLastTrade(symbol: string): { price: number; at: number } | null {
  return flows.get(symbol)?.lastTrade ?? null;
}

export function flowSymbols(): string[] {
  return [...flows.keys()];
}

/**
 * Volume the feed reported between two packets that no observed trade explains (cumulative volume rose by more than
 * the last trade's quantity). Recorded with its time only: it is never given a price level or an aggressor side.
 */
export function recordFlowUnreconciled(symbol: string, time: number, qty: number): void {
  const f = flows.get(symbol);
  if (!f || !(qty > 0) || !Number.isFinite(time)) return;
  f.unreconciled.push({ time, qty });
  sessionVwap(f, time).unreconciled += qty;
  const s = five.get(symbol), start = Math.floor(time / FLOW_FIVE_MS) * FLOW_FIVE_MS;
  if (!s || s.instrument !== f.instrument) five.set(symbol, { instrument: f.instrument, bars: new Map() });
  const series = five.get(symbol)!;
  let b = series.bars.get(start);
  if (!b) {
    series.bars.set(start, (b = { time: start, buy: 0, sell: 0, unclassified: 0, trades: 0, unreconciled: 0 }));
    if (series.bars.size > KEEP_FIVE) series.bars.delete(Math.min(...series.bars.keys()));
  }
  b.unreconciled = (b.unreconciled ?? 0) + qty;
}

// ---------------- five-minute delta bars (fresh-start order-flow shadow evidence, 5 Nov) ----------------
// The fresh-start strategies decide on five-minute closes, so their order-flow evidence needs five-minute buy / sell
// volume, kept in memory alongside the 15-minute footprints. Sides are INFERRED by the feed (quote rule, then tick
// rule); an unclassified trade stays unclassified. A contract change starts a fresh series (never mixed).

export const FLOW_FIVE_MS = 5 * 60_000;
const KEEP_FIVE = 400;
export interface FlowFiveMinuteBar { time: number; buy: number; sell: number; unclassified: number; trades: number; /** v2: unreconciled volume (no side). */ unreconciled?: number }
const five = new Map<string, { instrument: string | null; bars: Map<number, FlowFiveMinuteBar> }>();

function recordFiveMinute(symbol: string, instrument: string | null, t: FlowTrade): void {
  if (!Number.isFinite(t.time) || !(t.qty > 0)) return;
  let s = five.get(symbol);
  if (!s || s.instrument !== instrument) five.set(symbol, (s = { instrument, bars: new Map() }));
  const start = Math.floor(t.time / FLOW_FIVE_MS) * FLOW_FIVE_MS;
  let b = s.bars.get(start);
  if (!b) {
    s.bars.set(start, (b = { time: start, buy: 0, sell: 0, unclassified: 0, trades: 0, unreconciled: 0 }));
    if (s.bars.size > KEEP_FIVE) s.bars.delete(Math.min(...s.bars.keys()));
  }
  if (t.side === 'BUY') b.buy += t.qty;
  else if (t.side === 'SELL') b.sell += t.qty;
  else b.unclassified += t.qty;
  b.trades++;
}

/** Five-minute buy / sell volume for a flow symbol between two instants (bar start in [from, to)), oldest first. */
export function flowFiveMinuteBars(symbol: string, from: number, to: number): { instrument: string | null; bars: FlowFiveMinuteBar[] } | null {
  const s = five.get(symbol);
  if (!s) return null;
  return { instrument: s.instrument, bars: [...s.bars.values()].filter((b) => b.time >= from && b.time < to).sort((a, b) => a.time - b.time).map((b) => ({ ...b })) };
}

/**
 * Finalize every bar of every registered symbol that has closed by `now`
 * (inside the NSE session). `connected` says whether the feed was up — it
 * only labels an empty bar's reason.
 */
export async function closeFlowBars(now: number, connected: boolean = feedConnected, unavailableReason: string | null = null): Promise<number> {
  let written = 0;
  for (const [symbol, f] of flows) {
    const current = flowBarStart(now);
    for (let bar = (f.lastClosed ?? current - FLOW_BAR_MS) + FLOW_BAR_MS; bar < current; bar += FLOW_BAR_MS) {
      f.lastClosed = bar;
      if (!isMarketOpen(f.exchange as Exchange, bar + 1)) continue;
      const step = ORDER_FLOW_PRICE_STEP[symbol] ?? f.priceStep ?? 5;
      const fp = f.trades.some((t) => t.time >= bar && t.time < bar + FLOW_BAR_MS)
        ? buildFootprint(f.trades, bar, FLOW_BAR_MS, step, f.mode)
        : unavailableFootprint(bar, FLOW_BAR_MS);
      fp.sourceInstrument = f.instrument;
      const unrec = f.unreconciled.filter((u) => u.time >= bar && u.time < bar + FLOW_BAR_MS).reduce((n, u) => n + u.qty, 0);
      applyReconciliation(fp, unrec);
      fp.tickSize = f.tickSize;
      fp.priceStep = fp.deltaMode === 'UNAVAILABLE' ? null : step;
      const inBar = f.trades.filter((t) => t.time >= bar && t.time < bar + FLOW_BAR_MS && t.qty > 0).sort((a, b) => a.time - b.time);
      if (inBar.length) {
        fp.open = inBar[0].price;
        fp.tradeSums = inBar.reduce((a, t) => ({ pv: a.pv + t.price * t.qty, v: a.v + t.qty, p2v: a.p2v + t.price * t.price * t.qty }), { pv: 0, v: 0, p2v: 0 });
      }
      f.footprints.set(bar, fp);
      await persistFootprint(symbol, f, fp, fp.deltaMode === 'UNAVAILABLE' ? unavailableReason ?? (connected ? 'NO_TRADES' : 'FEED_DOWN') : null);
      await persistFlowEvents(symbol, f, bar, unrec);
      written++;
    }
    f.trades = f.trades.filter((t) => t.time >= current);
    f.unreconciled = f.unreconciled.filter((u) => u.time >= current);
    const keep = f.kind === 'STOCK' ? KEEP_BARS_STOCK : KEEP_BARS;
    if (f.footprints.size > keep) for (const k of [...f.footprints.keys()].sort((a, b) => a - b).slice(0, f.footprints.size - keep)) f.footprints.delete(k);
  }
  return written;
}

/**
 * Pure: records a bar's unreconciled volume on its footprint and, above FLOW_MAX_UNRECONCILED_SHARE of the bar's
 * reconciled + unreconciled volume, marks it INCOMPLETE and withholds delta and imbalances (the classified volume no
 * longer represents the bar). Levels, POC and value area stay (they describe the observed trades only).
 */
export function applyReconciliation(fp: FootprintBar, unreconciled: number): FootprintBar {
  fp.unreconciledVolume = unreconciled > 0 ? unreconciled : 0;
  const total = (fp.volume ?? 0) + fp.unreconciledVolume;
  fp.incomplete = total > 0 && fp.unreconciledVolume / total > FLOW_MAX_UNRECONCILED_SHARE;
  if (fp.incomplete) {
    fp.delta = null;
    fp.deltaPct = null;
    fp.buyImbalances = 0;
    fp.sellImbalances = 0;
  }
  return fp;
}

/** Pure: a bar's trade and unreconciled events, as stored in order_flow_events ('gzip-json-v1', before gzip). */
export function encodeFlowEvents(trades: readonly FlowTrade[], unreconciled: ReadonlyArray<{ time: number; qty: number }>, bar: number): Array<[number, number | null, number, number]> {
  const side = (s: FlowTrade['side']) => (s === 'BUY' ? 1 : s === 'SELL' ? -1 : 0);
  const rows: Array<[number, number | null, number, number]> = [
    ...trades.map((t) => [t.time - bar, t.price, t.qty, side(t.side)] as [number, number | null, number, number]),
    ...unreconciled.map((u) => [u.time - bar, null, u.qty, 9] as [number, number | null, number, number]),
  ];
  return rows.sort((a, b) => a[0] - b[0]);
}

async function persistFlowEvents(symbol: string, f: SymbolFlow, bar: number, unrec: number): Promise<void> {
  if (!schemaFileReady(ORDER_FLOW_EVENTS_MIGRATION)) return;
  const trades = f.trades.filter((t) => t.time >= bar && t.time < bar + FLOW_BAR_MS), un = f.unreconciled.filter((u) => u.time >= bar && u.time < bar + FLOW_BAR_MS);
  if (!trades.length && !un.length) return;
  try {
    const events = gzipSync(Buffer.from(JSON.stringify(encodeFlowEvents(trades, un, bar))));
    await sql`INSERT INTO order_flow_events (symbol, exchange, instrument, bar_time, bar_ms, trades, unreconciled_volume, encoding, events, version)
      VALUES (${symbol}, ${f.exchange}, ${f.instrument}, ${new Date(bar)}, ${FLOW_BAR_MS}, ${trades.length}, ${unrec}, 'gzip-json-v1', ${events}, ${ORDER_FLOW_VERSION})
      ON CONFLICT (symbol, exchange, bar_time) DO NOTHING`;
  } catch (err: any) {
    logger.warn({ error: err.message, symbol }, 'Order flow: event recording failed');
  }
}

async function persistFootprint(symbol: string, f: SymbolFlow, fp: FootprintBar, reason: string | null): Promise<void> {
  if (!schemaFileReady(ORDER_FLOW_MIGRATION)) return;
  try {
    if (schemaFileReady(ORDER_FLOW_EVENTS_MIGRATION)) {
      await sql`
      INSERT INTO order_flow_bars (symbol, exchange, instrument, source, bar_time, bar_ms, delta_mode, unavailable_reason, trades, volume, buy_volume, sell_volume,
        unclassified_volume, delta, delta_pct, poc, vah, val, buy_imbalances, sell_imbalances, levels, version, unreconciled_volume, tick_size, price_step)
      VALUES (${symbol}, ${f.exchange}, ${f.instrument}, ${f.source}, ${new Date(fp.barTime)}, ${fp.barMs}, ${fp.deltaMode}, ${reason ?? (fp.incomplete ? 'INCOMPLETE_UNRECONCILED_VOLUME' : null)}, ${fp.trades}, ${fp.volume}, ${fp.buyVolume}, ${fp.sellVolume},
        ${fp.unclassifiedVolume}, ${fp.delta}, ${fp.deltaPct}, ${fp.poc}, ${fp.vah}, ${fp.val}, ${fp.deltaMode === 'UNAVAILABLE' ? null : fp.buyImbalances}, ${fp.deltaMode === 'UNAVAILABLE' ? null : fp.sellImbalances},
        ${fp.levels.length ? sql.json(fp.levels as any) : null}, ${ORDER_FLOW_VERSION}, ${fp.unreconciledVolume ?? null}, ${fp.tickSize ?? null}, ${fp.priceStep ?? null})
      ON CONFLICT (symbol, exchange, bar_time) DO NOTHING
    `;
      return;
    }
    await sql`
      INSERT INTO order_flow_bars (symbol, exchange, instrument, source, bar_time, bar_ms, delta_mode, unavailable_reason, trades, volume, buy_volume, sell_volume,
        unclassified_volume, delta, delta_pct, poc, vah, val, buy_imbalances, sell_imbalances, levels, version)
      VALUES (${symbol}, ${f.exchange}, ${f.instrument}, ${f.source}, ${new Date(fp.barTime)}, ${fp.barMs}, ${fp.deltaMode}, ${reason}, ${fp.trades}, ${fp.volume}, ${fp.buyVolume}, ${fp.sellVolume},
        ${fp.unclassifiedVolume}, ${fp.delta}, ${fp.deltaPct}, ${fp.poc}, ${fp.vah}, ${fp.val}, ${fp.deltaMode === 'UNAVAILABLE' ? null : fp.buyImbalances}, ${fp.deltaMode === 'UNAVAILABLE' ? null : fp.sellImbalances},
        ${fp.levels.length ? sql.json(fp.levels as any) : null}, ${ORDER_FLOW_VERSION})
      ON CONFLICT (symbol, exchange, bar_time) DO NOTHING
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, symbol }, 'Order flow: footprint write failed');
  }
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Footprints of the given bars: in-process first, then order_flow_bars. Taped as one input (a replay reads the recording). */
export function footprintsFor(symbol: string, barTimes: readonly number[]): Promise<Map<number, FootprintBar>> {
  return tapedInput('orderFlowFootprints', [symbol, barTimes[0] ?? null, barTimes[barTimes.length - 1] ?? null, barTimes.length], async () => {
    const out = new Map<number, FootprintBar>();
    // A bar that closed moments ago may not be finalized by the feed's timer yet.
    await closeFlowBars(Date.now());
    const f = flows.get(symbol);
    const missing: number[] = [];
    for (const t of barTimes) {
      const fp = f?.footprints.get(t);
      if (fp) out.set(t, fp);
      else missing.push(t);
    }
    if (missing.length && schemaFileReady(ORDER_FLOW_MIGRATION)) {
      const rows = await sql<any[]>`
        SELECT instrument, bar_time, bar_ms, delta_mode, trades, volume, buy_volume, sell_volume, unclassified_volume, delta, delta_pct, poc, vah, val, buy_imbalances, sell_imbalances, levels
        FROM order_flow_bars WHERE symbol = ${symbol} AND bar_time >= ${new Date(Math.min(...missing))} AND bar_time <= ${new Date(Math.max(...missing))}
      `;
      for (const r of rows) {
        const t = new Date(r.bar_time).getTime();
        if (!missing.includes(t)) continue;
        const levels = (r.levels ?? []) as FootprintBar['levels'];
        out.set(t, {
          sourceInstrument: r.instrument ?? null,
          barTime: t, barMs: Number(r.bar_ms), deltaMode: r.delta_mode, trades: Number(r.trades), volume: num(r.volume), buyVolume: num(r.buy_volume), sellVolume: num(r.sell_volume),
          unclassifiedVolume: num(r.unclassified_volume), delta: num(r.delta), deltaPct: num(r.delta_pct), levels, poc: num(r.poc), vah: num(r.vah), val: num(r.val),
          buyImbalances: Number(r.buy_imbalances ?? 0), sellImbalances: Number(r.sell_imbalances ?? 0),
          high: levels.length ? Math.max(...levels.map((l) => l.price)) : null, low: levels.length ? Math.min(...levels.map((l) => l.price)) : null, close: null,
        });
      }
    }
    return out;
  });
}

/** For diagnostics and tests. */
export function flowStoreStatus(): Array<{ symbol: string; instrument: string | null; mode: string; openTrades: number; bars: number; lastClosed: number | null }> {
  return [...flows].map(([symbol, f]) => ({ symbol, instrument: f.instrument, mode: f.mode, openTrades: f.trades.length, bars: f.footprints.size, lastClosed: f.lastClosed }));
}

/** Tests only. */
export function resetFlowStore(): void {
  five.clear();
  flows.clear();
}
