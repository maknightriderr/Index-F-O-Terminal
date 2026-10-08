// ============================================================
// ORDER FLOW — normalized trades → per-bar footprint (pure)
// ============================================================
// Input is a broker-neutral trade stream (FlowTrade): price, quantity and
// the aggressor side WHERE KNOWN. How a side was obtained is carried as the
// DeltaMode and is never upgraded:
//   EXACT        the feed reports the executed trade's aggressor side
//   INFERRED     the side was inferred (quote rule, then tick rule) from
//                LTP against the prevailing best bid / ask — an estimate,
//                never to be presented as exchange (DEXT-style) delta
//   UNAVAILABLE  no usable trades for the bar
// Anything that cannot be computed is null — never a fabricated zero.
// No IO, no clock, no broker packet structures (those live in the server).
// ============================================================

export type DeltaMode = 'EXACT' | 'INFERRED' | 'UNAVAILABLE';
export type TradeSide = 'BUY' | 'SELL';

export interface FlowTrade {
  /** Epoch ms of the trade (or of the feed update that revealed it). */
  time: number;
  price: number;
  qty: number;
  /** Aggressor side; null = could not be classified. */
  side: TradeSide | null;
}

export const ORDER_FLOW_VERSION = 'OF-1.0';

export const ORDER_FLOW_RULES = Object.freeze({
  /** Share of the bar's volume inside the value area. */
  valueAreaFrac: 0.7,
  /** A level is a buy (sell) imbalance when buy ÷ sell (sell ÷ buy) is at least this, both counted at the same level. */
  imbalanceRatio: 3,
  /** …and the dominant side has at least this share of the bar's average level volume. */
  imbalanceMinShare: 0.5,
  /** Below this share of classified volume the bar's delta is not reported (null). */
  minClassifiedFrac: 0.8,
});

export interface FootprintLevel {
  price: number;
  buy: number;
  sell: number;
  unclassified: number;
}

export interface FootprintBar {
  barTime: number;
  barMs: number;
  deltaMode: DeltaMode;
  trades: number;
  volume: number | null;
  buyVolume: number | null;
  sellVolume: number | null;
  unclassifiedVolume: number | null;
  /** buy − sell; null when unavailable or too little volume could be classified. */
  delta: number | null;
  /** delta ÷ classified volume, −1…1. */
  deltaPct: number | null;
  /** Volume by price, ascending (step-sized buckets). */
  levels: FootprintLevel[];
  poc: number | null;
  vah: number | null;
  val: number | null;
  buyImbalances: number;
  sellImbalances: number;
  high: number | null;
  low: number | null;
  close: number | null;
}

const bucket = (price: number, step: number) => Math.round(Math.round(price / step) * step * 1e6) / 1e6;

/** The empty footprint of a bar with no usable trades — every measure null, not zero. */
export function unavailableFootprint(barTime: number, barMs: number): FootprintBar {
  return {
    barTime, barMs, deltaMode: 'UNAVAILABLE', trades: 0, volume: null, buyVolume: null, sellVolume: null, unclassifiedVolume: null,
    delta: null, deltaPct: null, levels: [], poc: null, vah: null, val: null, buyImbalances: 0, sellImbalances: 0, high: null, low: null, close: null,
  };
}

/** POC and the value area (valueAreaFrac of volume, grown from the POC towards the larger neighbour). */
export function valueArea(levels: readonly { price: number; total: number }[], frac: number = ORDER_FLOW_RULES.valueAreaFrac): { poc: number; vah: number; val: number } | null {
  const lv = [...levels].filter((l) => l.total > 0).sort((a, b) => a.price - b.price);
  if (lv.length === 0) return null;
  const total = lv.reduce((a, l) => a + l.total, 0);
  // POC: the most traded level; ties → the one nearest the middle, then the lower.
  let pi = 0;
  for (let k = 1; k < lv.length; k++) {
    const mid = (lv.length - 1) / 2;
    if (lv[k].total > lv[pi].total || (lv[k].total === lv[pi].total && Math.abs(k - mid) < Math.abs(pi - mid))) pi = k;
  }
  let lo = pi;
  let hi = pi;
  let acc = lv[pi].total;
  while (acc < frac * total && (lo > 0 || hi < lv.length - 1)) {
    const down = lo > 0 ? lv[lo - 1].total : -1;
    const up = hi < lv.length - 1 ? lv[hi + 1].total : -1;
    if (up >= down) acc += lv[++hi].total;
    else acc += lv[--lo].total;
  }
  return { poc: lv[pi].price, vah: lv[hi].price, val: lv[lo].price };
}

/**
 * The footprint of one bar from the trades inside [barTime, barTime + barMs).
 * `mode` is how the trades' sides were obtained (EXACT / INFERRED); with no
 * trades the bar is UNAVAILABLE.
 */
export function buildFootprint(trades: readonly FlowTrade[], barTime: number, barMs: number, priceStep: number, mode: Exclude<DeltaMode, 'UNAVAILABLE'>): FootprintBar {
  const inBar = trades.filter((t) => t.time >= barTime && t.time < barTime + barMs && t.qty > 0 && Number.isFinite(t.price)).sort((a, b) => a.time - b.time);
  if (inBar.length === 0) return unavailableFootprint(barTime, barMs);
  const map = new Map<number, FootprintLevel>();
  let buy = 0;
  let sell = 0;
  let unc = 0;
  for (const t of inBar) {
    const p = bucket(t.price, priceStep);
    const l = map.get(p) ?? { price: p, buy: 0, sell: 0, unclassified: 0 };
    if (t.side === 'BUY') (l.buy += t.qty), (buy += t.qty);
    else if (t.side === 'SELL') (l.sell += t.qty), (sell += t.qty);
    else (l.unclassified += t.qty), (unc += t.qty);
    map.set(p, l);
  }
  const levels = [...map.values()].sort((a, b) => a.price - b.price);
  const volume = buy + sell + unc;
  const classified = buy + sell;
  const enough = volume > 0 && classified / volume >= ORDER_FLOW_RULES.minClassifiedFrac;
  const va = valueArea(levels.map((l) => ({ price: l.price, total: l.buy + l.sell + l.unclassified })));
  const avgLevel = volume / Math.max(1, levels.length);
  const minDominant = ORDER_FLOW_RULES.imbalanceMinShare * avgLevel;
  const buyImbalances = levels.filter((l) => l.buy >= minDominant && l.buy >= ORDER_FLOW_RULES.imbalanceRatio * Math.max(l.sell, 1e-9) && l.buy > 0).length;
  const sellImbalances = levels.filter((l) => l.sell >= minDominant && l.sell >= ORDER_FLOW_RULES.imbalanceRatio * Math.max(l.buy, 1e-9) && l.sell > 0).length;
  return {
    barTime,
    barMs,
    deltaMode: mode,
    trades: inBar.length,
    volume,
    buyVolume: buy,
    sellVolume: sell,
    unclassifiedVolume: unc,
    delta: enough ? buy - sell : null,
    deltaPct: enough && classified > 0 ? Math.round(((buy - sell) / classified) * 10000) / 10000 : null,
    levels,
    poc: va?.poc ?? null,
    vah: va?.vah ?? null,
    val: va?.val ?? null,
    buyImbalances: enough ? buyImbalances : 0,
    sellImbalances: enough ? sellImbalances : 0,
    high: Math.max(...inBar.map((t) => t.price)),
    low: Math.min(...inBar.map((t) => t.price)),
    close: inBar[inBar.length - 1].price,
  };
}

/**
 * Infer a trade's aggressor side (INFERRED mode only): at or above the
 * prevailing ask → BUY, at or below the bid → SELL (quote rule); inside the
 * spread or without a quote, an uptick → BUY, a downtick → SELL, unchanged →
 * the previous inferred side (tick rule); nothing known → null.
 */
export function inferTradeSide(price: number, quote: { bid: number | null; ask: number | null } | null, prevPrice: number | null, prevSide: TradeSide | null): TradeSide | null {
  const bid = quote?.bid != null && quote.bid > 0 ? quote.bid : null;
  const ask = quote?.ask != null && quote.ask > 0 ? quote.ask : null;
  if (ask != null && price >= ask) return 'BUY';
  if (bid != null && price <= bid) return 'SELL';
  if (prevPrice != null) {
    if (price > prevPrice) return 'BUY';
    if (price < prevPrice) return 'SELL';
    return prevSide;
  }
  return null;
}

// ---------------- per-bar reads used by OF1 ----------------

/** Share of the bar's volume traded strictly above (side 'ABOVE') or below a level; null without levels. */
export function volumeShareBeyond(fp: FootprintBar, level: number, side: 'ABOVE' | 'BELOW'): number | null {
  if (fp.volume == null || fp.volume <= 0) return null;
  const v = fp.levels.filter((l) => (side === 'ABOVE' ? l.price > level : l.price < level)).reduce((a, l) => a + l.buy + l.sell + l.unclassified, 0);
  return v / fp.volume;
}

/**
 * Absorption: aggressive volume met at the bar's extreme without follow-
 * through. Bullish = selling absorbed at the lows: at least `minShare` of the
 * bar's SELL volume traded in its lowest third, yet the bar closed in its
 * upper half. Null when the sides are not classified.
 */
export function absorption(fp: FootprintBar, bar: { high: number; low: number; close: number }, dir: 'BULLISH' | 'BEARISH', minShare = 0.4): boolean | null {
  if (fp.deltaMode === 'UNAVAILABLE' || fp.delta == null) return null;
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  if (dir === 'BULLISH') {
    const total = fp.sellVolume ?? 0;
    if (total <= 0) return false;
    const low3 = fp.levels.filter((l) => l.price <= bar.low + range / 3).reduce((a, l) => a + l.sell, 0);
    return low3 / total >= minShare && bar.close >= bar.low + range / 2;
  }
  const total = fp.buyVolume ?? 0;
  if (total <= 0) return false;
  const high3 = fp.levels.filter((l) => l.price >= bar.high - range / 3).reduce((a, l) => a + l.buy, 0);
  return high3 / total >= minShare && bar.close <= bar.high - range / 2;
}
