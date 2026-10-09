// ============================================================
// ORDER FLOW (OF-1.0), OF1 (OF1-1.0) and the Dhan data layer (2026-10-09)
// ============================================================
// Footprint maths, delta modes (INFERRED never presented as EXACT, missing
// data null — never zero), OF1's fixed LOCATION + FLOW + PRICE rule with no
// look-ahead, the Dhan packet parser / instrument resolution / side
// inference, and OF1 staying shadow-only. All inputs are FABRICATED.
// ============================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const A = await import('@fno/analytics');
const P = await import('../../lib/dhan-feed-packets.js');
const { tradeFromFullPacket } = await import('../dhan-feed.js');
const { of1TradeVerdict } = await import('../of1-live.js');
const flags = await import('../../config/order-flow-flags.js');

const M15 = 15 * 60_000;
const BAR = Date.parse('2026-10-07T10:45:00+05:30');
const tr = (price: number, qty: number, side: 'BUY' | 'SELL' | null, k = 0) => ({ time: BAR + 1000 + k, price, qty, side });

describe('footprint', () => {
  it('buy / sell / delta / delta %, POC and value area; trades outside the bar ignored', () => {
    const fp = A.buildFootprint([tr(100, 30, 'BUY'), tr(100, 10, 'SELL', 1), tr(101, 50, 'BUY', 2), tr(99, 10, 'SELL', 3), { time: BAR + M15, price: 120, qty: 999, side: 'BUY' }], BAR, M15, 1, 'INFERRED');
    expect(fp).toMatchObject({ deltaMode: 'INFERRED', trades: 4, volume: 100, buyVolume: 80, sellVolume: 20, delta: 60, deltaPct: 0.6, poc: 101, high: 101, low: 99, close: 99 });
    expect(fp.vah).toBe(101);
    expect(fp.val).toBe(100);
  });
  it('a bar with no trades is UNAVAILABLE with every measure null — never zero', () => {
    const fp = A.buildFootprint([], BAR, M15, 1, 'INFERRED');
    expect(fp).toMatchObject({ deltaMode: 'UNAVAILABLE', volume: null, buyVolume: null, sellVolume: null, delta: null, deltaPct: null, poc: null, vah: null, val: null });
  });
  it('too little classified volume → delta null (the volume itself is still reported)', () => {
    const fp = A.buildFootprint([tr(100, 50, 'BUY'), tr(100, 50, null, 1)], BAR, M15, 1, 'INFERRED');
    expect(fp.volume).toBe(100);
    expect(fp.delta).toBeNull();
    expect(fp.deltaPct).toBeNull();
  });
  it('imbalances: a dominant side ≥ 3× the other at the same level', () => {
    const fp = A.buildFootprint([tr(100, 90, 'BUY'), tr(100, 10, 'SELL', 1), tr(101, 50, 'BUY', 2), tr(101, 50, 'SELL', 3)], BAR, M15, 1, 'EXACT');
    expect(fp.buyImbalances).toBe(1);
    expect(fp.sellImbalances).toBe(0);
    expect(fp.deltaMode).toBe('EXACT');
  });
  it('trade-side inference: quote rule first, then tick rule, else unknown', () => {
    expect(A.inferTradeSide(101, { bid: 100, ask: 101 }, null, null)).toBe('BUY');
    expect(A.inferTradeSide(100, { bid: 100, ask: 101 }, null, null)).toBe('SELL');
    expect(A.inferTradeSide(100.5, { bid: 100, ask: 101 }, 100.4, null)).toBe('BUY');
    expect(A.inferTradeSide(100.5, null, 100.6, null)).toBe('SELL');
    expect(A.inferTradeSide(100.5, null, 100.5, 'SELL')).toBe('SELL');
    expect(A.inferTradeSide(100.5, null, null, null)).toBeNull();
  });
  it('absorption: selling absorbed in the bar\'s lowest third, close in its upper half', () => {
    const fp = A.buildFootprint([tr(95, 60, 'SELL'), tr(96, 20, 'SELL', 1), tr(99, 20, 'SELL', 2), tr(99, 120, 'BUY', 3)], BAR, M15, 1, 'INFERRED');
    expect(A.absorption(fp, { high: 101, low: 94, close: 99 }, 'BULLISH')).toBe(true);
    expect(A.absorption(fp, { high: 101, low: 94, close: 96 }, 'BULLISH')).toBe(false);
    expect(A.absorption(A.unavailableFootprint(BAR, M15), { high: 101, low: 94, close: 99 }, 'BULLISH')).toBeNull();
  });
});

// ---------------- OF1 ----------------
const D1 = Date.parse('2026-10-06T09:15:00+05:30');
const D2 = Date.parse('2026-10-07T09:15:00+05:30');
type Bar = { time: number; open: number; high: number; low: number; close: number };
function session(): Bar[] {
  const bars: Bar[] = [];
  for (let k = 0; k < 25; k++) bars.push(k === 10 ? { time: D1 + k * M15, open: 101, high: 101, low: 95, close: 100 } : k % 2 ? { time: D1 + k * M15, open: 101, high: 104, low: 99, close: 102 } : { time: D1 + k * M15, open: 102, high: 104, low: 99, close: 101 });
  for (let k = 0; k < 6; k++) bars.push(k % 2 ? { time: D2 + k * M15, open: 103, high: 104, low: 99, close: 102 } : { time: D2 + k * M15, open: 102, high: 104, low: 99, close: 103 });
  bars.push({ time: D2 + 6 * M15, open: 100, high: 101, low: 94.5, close: 100.5 }); // the decision bar: sweeps PDL 95, closes back above it
  bars.push({ time: D2 + 7 * M15, open: 100.5, high: 103, low: 100, close: 102 }); // a later bar (no-look-ahead check)
  return bars;
}
const I = 31;
const buyFlow = (t: number) => A.buildFootprint([95, 96, 97, 98, 99, 100].flatMap((p, k) => [{ time: t + 10 + k, price: p, qty: 300, side: 'BUY' as const }, { time: t + 20 + k, price: p, qty: 50, side: 'SELL' as const }]), t, M15, 1, 'INFERRED');

describe('OF1: location + order flow + price response', () => {
  const bars = session();
  it('bullish: PDL swept and reclaimed with buyer imbalance, positive delta and acceptance above the level', () => {
    const fps = new Map([[bars[I].time, buyFlow(bars[I].time)]]);
    const [c, ...rest] = A.evaluateOf1(bars, I, fps);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ version: 'OF1-1.0', direction: 'BULLISH', decisionIndex: I, subtype: 'PDL_IMBALANCE', location: { kind: 'PDL', price: 95 }, entry: 100.5, deltaMode: 'INFERRED' });
    expect(c.evidence).toEqual(expect.arrayContaining(['DELTA', 'IMBALANCE', 'ACCEPTANCE']));
    expect(c.measurable).not.toContain('POC_UP'); // no previous footprint → not measurable, not counted
    expect(c.stop).toBeCloseTo(94.5 - 0.1 * c.atr, 6);
    expect(c.target).toMatchObject({ price: 104 });
  });
  it('one piece of flow evidence is not enough; an UNAVAILABLE or missing footprint gives nothing', () => {
    const t = bars[I].time;
    const balanced = A.buildFootprint([96, 97, 98, 99, 100].flatMap((p, k) => [{ time: t + k, price: p, qty: 100, side: 'BUY' as const }, { time: t + 10 + k, price: p, qty: 100, side: 'SELL' as const }]), t, M15, 1, 'INFERRED');
    expect(A.evaluateOf1(bars, I, new Map([[t, balanced]]))).toEqual([]);
    expect(A.evaluateOf1(bars, I, new Map([[t, A.unavailableFootprint(t, M15)]]))).toEqual([]);
    expect(A.evaluateOf1(bars, I, new Map())).toEqual([]);
  });
  it('no price response, no candidate: a close back below the level', () => {
    const b = session();
    b[I] = { ...b[I], close: 94.8 };
    expect(A.evaluateOf1(b, I, new Map([[b[I].time, buyFlow(b[I].time)]]))).toEqual([]);
  });
  it('bearish mirrors', () => {
    const m = session().map((x) => ({ ...x, open: 200 - x.open, high: 200 - x.low, low: 200 - x.high, close: 200 - x.close }));
    const t = m[I].time;
    const sellFlow = A.buildFootprint([100, 101, 102, 103, 104, 105].flatMap((p, k) => [{ time: t + 10 + k, price: p, qty: 300, side: 'SELL' as const }, { time: t + 20 + k, price: p, qty: 50, side: 'BUY' as const }]), t, M15, 1, 'INFERRED');
    const [c] = A.evaluateOf1(m, I, new Map([[t, sellFlow]]));
    expect(c).toMatchObject({ direction: 'BEARISH', subtype: 'PDH_IMBALANCE', location: { kind: 'PDH', price: 105 } });
  });
  it('no look-ahead: later bars and later footprints never change the read at bar i', () => {
    const fps = new Map([[bars[I].time, buyFlow(bars[I].time)], [bars[I + 1].time, buyFlow(bars[I + 1].time)]]);
    const cut = new Map([[bars[I].time, fps.get(bars[I].time)!]]);
    expect(A.evaluateOf1(bars, I, fps)).toEqual(A.evaluateOf1(bars.slice(0, I + 1), I, cut));
    expect(A.of1Locations(bars, I, fps)).toEqual(A.of1Locations(bars.slice(0, I + 1), I, cut));
  });
});

describe('OF1: paper trading switch and hypothesis', () => {
  const base = { version: 'OF1-1.0', direction: 'BULLISH', decisionIndex: 0, decisionTime: 0, subtype: 'PDL_DELTA', location: { kind: 'PDL', price: 95, role: 'SUPPORT' }, atr: 5, entry: 100, stop: 94, evidence: [], measurable: [], deltaMode: 'INFERRED', delta: 1, deltaPct: 0.2, poc: null, vah: null, val: null, imbalances: 0, absorption: null, priceConfirmation: '' } as any;
  it('would_trade_if_live is a hypothesis: no target, a session gate or risk-off each say no', () => {
    expect(of1TradeVerdict({ ...base, target: null }, null, { session: null, riskOff: null }, 6.25)).toMatchObject({ wouldTrade: false, plan: null });
    expect(of1TradeVerdict({ ...base, target: null }, null, { session: null, riskOff: null }, 6.25).reasons.join()).toMatch(/NO_TARGET/);
    expect(of1TradeVerdict({ ...base, target: { kind: 'PDH', price: 104, role: 'RESISTANCE' } }, null, { session: 'closing guard', riskOff: null }, 6.25).reasons.join()).toMatch(/SESSION/);
  });
  it('OF1 paper-trades by default (OF1_TRADING=false rolls back to shadow); NSE and MCX symbols are supported, others refused', () => {
    expect(flags.OF1_TRADING).toBe(true);
    expect(flags.orderFlowLogicSuffix(true, true)).toBe('+ob1-paper.1+of1-paper.1');
    expect(flags.orderFlowLogicSuffix(false, false)).toBe('');
    expect(flags.parseOrderFlowSymbols('NIFTY,CRUDEOIL,banknifty,RELIANCE')).toEqual({ symbols: ['NIFTY', 'CRUDEOIL', 'BANKNIFTY'], rejected: ['RELIANCE'] });
    expect(flags.parseOrderFlowSymbols(undefined).symbols).toEqual(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS']);
    expect(flags.ORDER_FLOW_SUPPORTED.CRUDEOIL).toBe('MCX');
  });
});

// ---------------- Dhan ----------------
function fullPacket(o: { sid: number; ltp: number; volume: number; bid: number; ask: number }): Buffer {
  const b = Buffer.alloc(P.DHAN_FULL_PACKET_BYTES);
  b.writeUInt8(8, 0);
  b.writeInt16LE(P.DHAN_FULL_PACKET_BYTES, 1);
  b.writeUInt8(2, 3);
  b.writeInt32LE(o.sid, 4);
  b.writeFloatLE(o.ltp, 8);
  b.writeInt16LE(75, 12);
  b.writeInt32LE(1791500000, 14);
  b.writeFloatLE(o.ltp, 18);
  b.writeInt32LE(o.volume, 22);
  b.writeInt32LE(5000, 26);
  b.writeInt32LE(6000, 30);
  b.writeInt32LE(123456, 34);
  b.writeFloatLE(25000, 46);
  b.writeFloatLE(24900, 50);
  b.writeFloatLE(25100, 54);
  b.writeFloatLE(24950, 58);
  b.writeInt32LE(650, 62);
  b.writeInt32LE(325, 66);
  b.writeInt16LE(10, 70);
  b.writeInt16LE(5, 72);
  b.writeFloatLE(o.bid, 74);
  b.writeFloatLE(o.ask, 78);
  return b;
}

describe('Dhan feed packets (data only)', () => {
  it('parses FULL packets (several per frame) and drops a malformed tail rather than guessing', () => {
    const frame = Buffer.concat([fullPacket({ sid: 48704, ltp: 25010.5, volume: 1000, bid: 25010, ask: 25011 }), fullPacket({ sid: 48699, ltp: 55000, volume: 30, bid: 54999, ask: 55001 }), Buffer.from([8, 0, 1])]);
    const ps = P.parseDhanFrame(frame);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ kind: 'FULL', header: { code: 8, segment: 2, securityId: 48704 }, ltp: 25010.5, ltq: 75, volume: 1000, oi: 123456, open: 25000, high: 25100 });
    expect((ps[0] as any).depth[0]).toMatchObject({ bidQty: 650, askQty: 325, bidOrders: 10, askOrders: 5, bidPrice: 25010, askPrice: 25011 });
  });
  it('the volume added since the previous packet is one trade at the last price, its side inferred from the quote before it', () => {
    const s0 = { symbol: 'NIFTY', prevVolume: null, prevLtp: null, prevSide: null, prevQuote: null };
    const p = (ltp: number, volume: number, bid: number, ask: number) => ({ ltp, volume, depth: [{ bidQty: 1, askQty: 1, bidOrders: 1, askOrders: 1, bidPrice: bid, askPrice: ask }] });
    const a = tradeFromFullPacket(s0, p(25010, 1000, 25009, 25010), 1);
    expect(a.trade).toBeNull(); // the first packet only sets the baseline
    const b = tradeFromFullPacket(a.next, p(25010, 1065, 25010, 25011), 2);
    expect(b.trade).toEqual({ time: 2, price: 25010, qty: 65, side: 'BUY' }); // at the prevailing ask
    const c = tradeFromFullPacket(b.next, p(25008, 1130, 25007, 25008), 3);
    expect(c.trade?.side).toBe('SELL'); // at / below the prevailing bid (25010)
    const reset = tradeFromFullPacket(c.next, p(25008, 10, 25007, 25008), 4);
    expect(reset.trade).toBeNull(); // volume went down: re-base, no fabricated trade
  });
  it('resolves the nearest unexpired NSE index future from the public instrument master', () => {
    const csv = [
      'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
      'NSE,D,48699,FUTIDX,0,BANKNIFTY-Oct2026-FUT,30.0,BANKNIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,20.0000,M,FUT,,',
      'NSE,D,48704,FUTIDX,0,NIFTY-Oct2026-FUT,65.0,NIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
      'NSE,D,61471,FUTIDX,0,NIFTY-Nov2026-FUT,65.0,NIFTY NOV FUT,2026-11-23 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
      'NSE,D,99999,OPTIDX,0,NIFTY-Oct2026-25000-CE,65.0,NIFTY 25000 CE,2026-10-13 14:30:00,25000,CE,5.0000,W,OP,,',
      'MCX,M,1234,FUTCOM,0,CRUDEOIL-Oct2026-FUT,100.0,CRUDEOIL OCT FUT,2026-10-19 23:30:00,-0.01000,XX,100.0000,M,FUT,,',
    ].join('\n');
    expect(P.resolveIndexFutures(csv, ['NIFTY', 'BANKNIFTY'], Date.parse('2026-10-09T10:00:00+05:30'))).toEqual({
      NIFTY: { securityId: '48704', tradingSymbol: 'NIFTY-Oct2026-FUT', expiry: '2026-10-27 14:30:00' },
      BANKNIFTY: { securityId: '48699', tradingSymbol: 'BANKNIFTY-Oct2026-FUT', expiry: '2026-10-27 14:30:00' },
    });
    expect(P.resolveIndexFutures(csv, ['NIFTY'], Date.parse('2026-10-28T10:00:00+05:30')).NIFTY.securityId).toBe('61471');
  });
  it('subscribes to FULL packets on NSE F&O, and the URL is the v2 data feed (no order endpoint)', () => {
    expect(JSON.parse(P.fullSubscription(['48704']))).toEqual({ RequestCode: 21, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: 'NSE_FNO', SecurityId: '48704' }] });
    const url = P.dhanFeedUrl('C1', 'tok');
    expect(url.startsWith('wss://api-feed.dhan.co?version=2')).toBe(true);
    expect(url).toContain('authType=2');
  });
  it('without credentials the feed is NOT_CONFIGURED', () => {
    expect(flags.dhanCredentials({} as any)).toBeNull();
    expect(flags.dhanCredentials({ DHAN_CLIENT_ID: 'x', DHAN_ACCESS_TOKEN: 'y' } as any)).toEqual({ clientId: 'x', accessToken: 'y' });
  });
});

describe('Dhan feed: never hammer Dhan; no connection without the Data API plan (2026-10-09)', async () => {
  const F = await import('../dhan-feed.js');
  it('backs off exponentially after connections that bring no data, much longer after a 429, and resets only on real data', () => {
    expect(F.nextReconnectDelay(F.RECONNECT_MIN_MS, 'NO_DATA')).toBe(2 * F.RECONNECT_MIN_MS);
    let d = F.RECONNECT_MIN_MS;
    for (let k = 0; k < 20; k++) d = F.nextReconnectDelay(d, 'NO_DATA');
    expect(d).toBe(F.RECONNECT_MAX_MS);
    expect(F.nextReconnectDelay(d, 'RATE_LIMITED')).toBe(F.RATE_LIMIT_BACKOFF_MS);
    expect(F.nextReconnectDelay(d, 'GOT_DATA')).toBe(F.RECONNECT_MIN_MS);
    expect(F.RECONNECT_MIN_MS).toBeGreaterThanOrEqual(30_000);
  });
  it('reads the Data API plan from the Dhan profile (the 9 Oct account: Deactive)', () => {
    expect(F.dataPlanActive({ dataPlan: 'Deactive' })).toBe(false);
    expect(F.dataPlanActive({ dataPlan: 'Active' })).toBe(true);
    expect(F.dataPlanActive({})).toBeNull();
  });
  it('a disconnect packet keeps its reason even when its length field is not 10', () => {
    const b = Buffer.alloc(10);
    b.writeUInt8(50, 0);
    b.writeInt16LE(0, 1);
    b.writeInt16LE(806, 8);
    expect(P.parseDhanFrame(b)).toEqual([{ kind: 'DISCONNECT', header: { code: 50, length: 0, segment: 0, securityId: 0 }, reason: 806 }]);
  });
});
