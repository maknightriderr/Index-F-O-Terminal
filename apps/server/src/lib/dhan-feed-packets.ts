// ============================================================
// DHAN MARKET FEED v2 — binary packet parsing (Dhan-specific; never imported
// by packages/analytics)
// ============================================================
// Layout per Dhan's Live Market Feed v2 documentation (little-endian):
//   header (8 bytes): [0] uint8 feed response code, [1..2] int16 message
//   length, [3] uint8 exchange segment, [4..7] int32 security id
//   2  TICKER     8 f32 LTP, 12 i32 LTT
//   4  QUOTE      8 f32 LTP, 12 i16 LTQ, 14 i32 LTT, 18 f32 ATP, 22 i32 volume,
//                 26 i32 total sell qty, 30 i32 total buy qty, 34 f32 open,
//                 38 f32 close, 42 f32 high, 46 f32 low
//   5  OI         8 i32 OI
//   6  PREV_CLOSE 8 f32 previous close, 12 i32 previous OI
//   8  FULL       8 f32 LTP, 12 i16 LTQ, 14 i32 LTT, 18 f32 ATP, 22 i32 volume,
//                 26 i32 total sell qty, 30 i32 total buy qty, 34 i32 OI,
//                 38 i32 highest OI, 42 i32 lowest OI, 46 f32 open, 50 f32 close,
//                 54 f32 high, 58 f32 low, 62.. five depth levels × 20 bytes:
//                 i32 bid qty, i32 ask qty, i16 bid orders, i16 ask orders,
//                 f32 bid price, f32 ask price
//   50 DISCONNECT 8 i16 reason code
// What the feed does NOT carry: the aggressor side of an executed trade. A
// FULL packet shows the cumulative day volume, the last trade price and the
// best bid / ask, so trade sides can only be INFERRED (order-flow/index.ts
// inferTradeSide) — never exact.
// ============================================================

export const DHAN_FEED_URL = 'wss://api-feed.dhan.co';
export const DHAN_REQUEST = { TICKER: 15, QUOTE: 17, FULL: 21, UNSUBSCRIBE_FULL: 22, DISCONNECT: 12 } as const;
export const DHAN_RESPONSE = { TICKER: 2, QUOTE: 4, OI: 5, PREV_CLOSE: 6, FULL: 8, DISCONNECT: 50 } as const;

export interface DhanHeader {
  code: number;
  length: number;
  segment: number;
  securityId: number;
}

export interface DhanDepthLevel {
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
  bidPrice: number;
  askPrice: number;
}

export interface DhanFullPacket {
  kind: 'FULL';
  header: DhanHeader;
  ltp: number;
  ltq: number;
  /** As sent (epoch seconds per the feed). Bar assignment uses the receive time, not this. */
  ltt: number;
  atp: number;
  volume: number;
  totalSellQty: number;
  totalBuyQty: number;
  oi: number;
  open: number;
  close: number;
  high: number;
  low: number;
  depth: DhanDepthLevel[];
}

export interface DhanQuotePacket {
  kind: 'QUOTE';
  header: DhanHeader;
  ltp: number;
  ltq: number;
  ltt: number;
  atp: number;
  volume: number;
  totalSellQty: number;
  totalBuyQty: number;
}

export type DhanPacket = DhanFullPacket | DhanQuotePacket | { kind: 'DISCONNECT'; header: DhanHeader; reason: number } | { kind: 'OTHER'; header: DhanHeader };

export const DHAN_FULL_PACKET_BYTES = 162;
export const DHAN_QUOTE_PACKET_BYTES = 50;

export function readHeader(b: Buffer, at = 0): DhanHeader {
  return { code: b.readUInt8(at), length: b.readInt16LE(at + 1), segment: b.readUInt8(at + 3), securityId: b.readInt32LE(at + 4) };
}

/** Parse every packet in one WebSocket frame (a frame may carry several). Malformed tails are dropped, never guessed. */
export function parseDhanFrame(frame: Buffer): DhanPacket[] {
  const out: DhanPacket[] = [];
  let at = 0;
  while (at + 8 <= frame.length) {
    const header = readHeader(frame, at);
    // A disconnect packet is 10 bytes whatever its length field says (never drop the reason).
    const size =
      header.code === DHAN_RESPONSE.FULL
        ? DHAN_FULL_PACKET_BYTES
        : header.code === DHAN_RESPONSE.QUOTE
          ? DHAN_QUOTE_PACKET_BYTES
          : header.code === DHAN_RESPONSE.DISCONNECT
            ? Math.min(Math.max(header.length, 10), frame.length - at)
            : header.length > 0
              ? header.length
              : 0;
    if (size < 8 || at + size > frame.length) break;
    const p = frame.subarray(at, at + size);
    if (header.code === DHAN_RESPONSE.FULL) {
      const depth: DhanDepthLevel[] = [];
      for (let k = 0; k < 5; k++) {
        const o = 62 + k * 20;
        depth.push({ bidQty: p.readInt32LE(o), askQty: p.readInt32LE(o + 4), bidOrders: p.readInt16LE(o + 8), askOrders: p.readInt16LE(o + 10), bidPrice: p.readFloatLE(o + 12), askPrice: p.readFloatLE(o + 16) });
      }
      out.push({
        kind: 'FULL', header, ltp: p.readFloatLE(8), ltq: p.readInt16LE(12), ltt: p.readInt32LE(14), atp: p.readFloatLE(18), volume: p.readInt32LE(22),
        totalSellQty: p.readInt32LE(26), totalBuyQty: p.readInt32LE(30), oi: p.readInt32LE(34), open: p.readFloatLE(46), close: p.readFloatLE(50), high: p.readFloatLE(54), low: p.readFloatLE(58), depth,
      });
    } else if (header.code === DHAN_RESPONSE.QUOTE) {
      out.push({ kind: 'QUOTE', header, ltp: p.readFloatLE(8), ltq: p.readInt16LE(12), ltt: p.readInt32LE(14), atp: p.readFloatLE(18), volume: p.readInt32LE(22), totalSellQty: p.readInt32LE(26), totalBuyQty: p.readInt32LE(30) });
    } else if (header.code === DHAN_RESPONSE.DISCONNECT) {
      out.push({ kind: 'DISCONNECT', header, reason: p.length >= 10 ? p.readInt16LE(8) : -1 });
    } else {
      out.push({ kind: 'OTHER', header });
    }
    at += size;
  }
  return out;
}

export type DhanSegment = 'NSE_FNO' | 'MCX_COMM';
/** The packet header's numeric exchange segment for each subscription segment (Dhan v2). */
export const DHAN_SEGMENT_CODE: Readonly<Record<DhanSegment, number>> = Object.freeze({ NSE_FNO: 2, MCX_COMM: 5 });

/** The subscription request for FULL packets (plain ids = NSE F&O). */
export function fullSubscription(instruments: ReadonlyArray<string | { securityId: string; segment: DhanSegment }>): string {
  const list = instruments.map((x) => (typeof x === 'string' ? { ExchangeSegment: 'NSE_FNO', SecurityId: x } : { ExchangeSegment: x.segment, SecurityId: x.securityId }));
  return JSON.stringify({ RequestCode: DHAN_REQUEST.FULL, InstrumentCount: list.length, InstrumentList: list });
}

/** The feed URL. The token is a query parameter per Dhan's API — never log the result. */
export function dhanFeedUrl(clientId: string, accessToken: string): string {
  return `${DHAN_FEED_URL}?version=2&token=${encodeURIComponent(accessToken)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
}

/** Nearest-expiry NSE index future per symbol from Dhan's public instrument master (CSV text). */
export function resolveIndexFutures(csv: string, symbols: readonly string[], now: number): Record<string, { securityId: string; tradingSymbol: string; expiry: string }> {
  const r = resolveNearestFutures(csv, symbols.map((symbol) => ({ symbol, exchange: 'NSE' as const })), now);
  return Object.fromEntries(Object.entries(r).map(([s, v]) => [s, { securityId: v.securityId, tradingSymbol: v.tradingSymbol, expiry: v.expiry }]));
}

/**
 * Nearest-expiry future per symbol: NSE index futures (segment D, FUTIDX) and
 * MCX commodity futures (segment M, FUTCOM). The trading symbol's root must
 * equal the symbol exactly (CRUDEOIL is not CRUDEOILM).
 */
export function resolveNearestFutures(
  csv: string,
  wants: ReadonlyArray<{ symbol: string; exchange: 'NSE' | 'MCX' }>,
  now: number
): Record<string, { securityId: string; tradingSymbol: string; expiry: string; segment: DhanSegment; exchange: 'NSE' | 'MCX' }> {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',');
  const col = (name: string) => head.indexOf(name);
  const [ex, seg, id, inst, ts, exp] = ['SEM_EXM_EXCH_ID', 'SEM_SEGMENT', 'SEM_SMST_SECURITY_ID', 'SEM_INSTRUMENT_NAME', 'SEM_TRADING_SYMBOL', 'SEM_EXPIRY_DATE'].map(col);
  if ([ex, seg, id, inst, ts, exp].some((c) => c < 0)) return {};
  const wanted = new Map(wants.map((w) => [w.symbol, w.exchange]));
  const best: Record<string, { securityId: string; tradingSymbol: string; expiry: string; segment: DhanSegment; exchange: 'NSE' | 'MCX'; t: number }> = {};
  for (let k = 1; k < lines.length; k++) {
    const r = lines[k].split(',');
    const isNse = r[ex] === 'NSE' && r[seg] === 'D' && r[inst] === 'FUTIDX';
    const isMcx = r[ex] === 'MCX' && r[seg] === 'M' && r[inst] === 'FUTCOM';
    if (!isNse && !isMcx) continue;
    const sym = r[ts]?.split('-')[0];
    if (!sym || wanted.get(sym) !== (isNse ? 'NSE' : 'MCX')) continue;
    const t = Date.parse(`${r[exp].replace(' ', 'T')}+05:30`);
    if (!Number.isFinite(t) || t <= now) continue;
    if (!best[sym] || t < best[sym].t) best[sym] = { securityId: r[id], tradingSymbol: r[ts], expiry: r[exp], segment: isNse ? 'NSE_FNO' : 'MCX_COMM', exchange: isNse ? 'NSE' : 'MCX', t };
  }
  return Object.fromEntries(Object.entries(best).map(([s, { t: _t, ...v }]) => [s, v]));
}
