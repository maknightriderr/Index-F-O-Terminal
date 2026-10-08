// ============================================================
// ORDER FLOW STORE — normalized trades → closed 15m footprints (measurement)
// ============================================================
// The Order Flow Adapter's output: per symbol, the trades of the open bar
// and the footprint of every closed bar (order-flow/index.ts), persisted to
// order_flow_bars. A closed bar with no usable trades is recorded
// UNAVAILABLE with its reason — never as zero volume / zero delta.
// Nothing in the decision path reads this; OF1 (shadow) does.
// ============================================================

import { buildFootprint, unavailableFootprint, ORDER_FLOW_VERSION, type DeltaMode, type FlowTrade, type FootprintBar } from '@fno/analytics';
import { isMarketOpen, type Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { tapedInput } from '../lib/io-tape.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { ORDER_FLOW_PRICE_STEP } from '../config/order-flow-flags.js';

export const ORDER_FLOW_MIGRATION = '038_order_blocks_order_flow_of1.sql';
export const FLOW_BAR_MS = 15 * 60_000;
const KEEP_BARS = 400;

interface SymbolFlow {
  exchange: string;
  instrument: string | null;
  source: string;
  mode: Exclude<DeltaMode, 'UNAVAILABLE'>;
  trades: FlowTrade[];
  footprints: Map<number, FootprintBar>;
  /** The newest bar already finalized (written). */
  lastClosed: number | null;
}

const flows = new Map<string, SymbolFlow>();
/** Set by the feed: whether it is connected (labels an empty bar's reason). */
let feedConnected = false;
export function setFlowFeedConnected(v: boolean): void {
  feedConnected = v;
}

/** The 15m bar a time falls in. IST is UTC+5:30, so the epoch 15-minute grid is the IST grid (09:15, 09:30, …). */
export const flowBarStart = (t: number) => Math.floor(t / FLOW_BAR_MS) * FLOW_BAR_MS;

export function registerFlowSymbol(symbol: string, args: { exchange: string; instrument: string | null; source: string; mode: Exclude<DeltaMode, 'UNAVAILABLE'>; startedAt: number }): void {
  const f = flows.get(symbol);
  if (f) {
    f.instrument = args.instrument;
    f.source = args.source;
    f.mode = args.mode;
    return;
  }
  // Never backfill: the first bar finalized is the one after the feed started.
  flows.set(symbol, { exchange: args.exchange, instrument: args.instrument, source: args.source, mode: args.mode, trades: [], footprints: new Map(), lastClosed: flowBarStart(args.startedAt) });
}

export function recordFlowTrade(symbol: string, trade: FlowTrade): void {
  const f = flows.get(symbol);
  if (!f || !(trade.qty > 0)) return;
  f.trades.push(trade);
}

/**
 * Finalize every bar of every registered symbol that has closed by `now`
 * (inside the NSE session). `connected` says whether the feed was up — it
 * only labels an empty bar's reason.
 */
export async function closeFlowBars(now: number, connected: boolean = feedConnected): Promise<number> {
  let written = 0;
  for (const [symbol, f] of flows) {
    const current = flowBarStart(now);
    for (let bar = (f.lastClosed ?? current - FLOW_BAR_MS) + FLOW_BAR_MS; bar < current; bar += FLOW_BAR_MS) {
      f.lastClosed = bar;
      if (!isMarketOpen(f.exchange as Exchange, bar + 1)) continue;
      const fp = f.trades.some((t) => t.time >= bar && t.time < bar + FLOW_BAR_MS)
        ? buildFootprint(f.trades, bar, FLOW_BAR_MS, ORDER_FLOW_PRICE_STEP[symbol] ?? 5, f.mode)
        : unavailableFootprint(bar, FLOW_BAR_MS);
      f.footprints.set(bar, fp);
      await persistFootprint(symbol, f, fp, fp.deltaMode === 'UNAVAILABLE' ? (connected ? 'NO_TRADES' : 'FEED_DOWN') : null);
      written++;
    }
    f.trades = f.trades.filter((t) => t.time >= current);
    if (f.footprints.size > KEEP_BARS) for (const k of [...f.footprints.keys()].sort((a, b) => a - b).slice(0, f.footprints.size - KEEP_BARS)) f.footprints.delete(k);
  }
  return written;
}

async function persistFootprint(symbol: string, f: SymbolFlow, fp: FootprintBar, reason: string | null): Promise<void> {
  if (!schemaFileReady(ORDER_FLOW_MIGRATION)) return;
  try {
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
        SELECT bar_time, bar_ms, delta_mode, trades, volume, buy_volume, sell_volume, unclassified_volume, delta, delta_pct, poc, vah, val, buy_imbalances, sell_imbalances, levels
        FROM order_flow_bars WHERE symbol = ${symbol} AND bar_time >= ${new Date(Math.min(...missing))} AND bar_time <= ${new Date(Math.max(...missing))}
      `;
      for (const r of rows) {
        const t = new Date(r.bar_time).getTime();
        if (!missing.includes(t)) continue;
        const levels = (r.levels ?? []) as FootprintBar['levels'];
        out.set(t, {
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
  flows.clear();
}
