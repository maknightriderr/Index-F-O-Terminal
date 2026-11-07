// Dhan order-flow engine v2, phase 1 (data integrity): instrument resolution from Dhan's master (tick in paise, BSE_FNO,
// stock futures), subscription batching (100 / message), LTQ reconciliation, per-instrument status, INCOMPLETE bars,
// recorded events. Facts per the Dhan v2 docs re-read on 7 Nov 2026.
import { describe, it, expect, beforeEach } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { futuresRoot, resolveFlowContracts, fullSubscriptions, DHAN_SEGMENT_CODE, DHAN_MAX_INSTRUMENTS_PER_MESSAGE } from '../../lib/dhan-feed-packets.js';
import { tradeFromFullPacket, instrumentStatus, INSTRUMENT_STALE_MS } from '../dhan-feed.js';
import { applyReconciliation, encodeFlowEvents, recordFlowTrade, recordFlowUnreconciled, registerFlowSymbol, resetFlowStore, flowFiveMinuteBars } from '../order-flow-store.js';
import { flowPriceStep, unavailableFootprint, buildFootprint, FLOW_MAX_UNRECONCILED_SHARE } from '@fno/analytics';

const HEAD = 'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME';
// Rows copied in shape from the live master (7 Nov 2026).
const CSV = [HEAD,
  'NSE,D,61471,FUTIDX,0,NIFTY-Nov2026-FUT,65.0,NIFTY NOV FUT,2026-11-23 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
  'NSE,D,61999,FUTIDX,0,NIFTY-Dec2026-FUT,65.0,NIFTY DEC FUT,2026-12-28 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
  'BSE,D,1100929,FUTIDX,0,SENSEX-Nov2026-FUT,20.0,SENSEX NOV  FUT,2026-11-26 15:30:00,0.00000,,5.0000,M,FUTIDX,,BSXFUT',
  'BSE,D,1105194,FUTSTK,0,RELIANCE-Nov2026-FUT,500.0,RELIANCE NOV  FUT,2026-11-26 15:30:00,0.00000,,5.0000,M,FUTSTK,,RELIFUT',
  'NSE,D,61697,FUTSTK,0,RELIANCE-Nov2026-FUT,500.0,RELIANCE NOV FUT,2026-11-23 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
  'NSE,D,61505,FUTSTK,0,BAJAJ-AUTO-Nov2026-FUT,75.0,BAJAJ-AUTO NOV FUT,2026-11-23 14:30:00,-0.01000,XX,100.0000,M,FUT,,',
  'MCX,M,573422,FUTCOM,0,CRUDEOIL-19Nov2026-FUT,1.0,CRUDEOIL NOV FUT,2026-11-19 23:30:00,0.00000,XX,100.0000,M,FUTCOM,2,CRUDEOIL',
  'MCX,M,573423,FUTCOM,0,CRUDEOILM-19Nov2026-FUT,1.0,CRUDEOILM NOV FUT,2026-11-19 23:30:00,0.00000,XX,100.0000,M,FUTCOM,2,CRUDEOILM',
  'MCX,M,578634,FUTCOM,0,COPPER-30Nov2026-FUT,1.0,COPPER NOV FUT,2026-11-30 23:30:00,0.00000,XX,5.0000,M,FUTCOM,2,COPPER',
  'NSE,D,40000,FUTSTK,0,OLDCO-Oct2026-FUT,100.0,OLDCO OCT FUT,2026-10-29 14:30:00,-0.01000,XX,5.0000,M,FUT,,',
].join('\n');
const NOW = Date.parse('2026-11-09T05:00:00Z');

describe('Dhan master resolution (v2)', () => {
  it('reads the underlying before "-<expiry>-FUT", keeping hyphenated names and minis apart', () => {
    expect(futuresRoot('BAJAJ-AUTO-Nov2026-FUT')).toBe('BAJAJ-AUTO');
    expect(futuresRoot('CRUDEOILM-19Nov2026-FUT')).toBe('CRUDEOILM');
    expect(futuresRoot('M&M-Nov2026-FUT')).toBe('M&M');
    expect(futuresRoot('NIFTY 26 NOV 24000 CALL')).toBeNull();
  });
  it('resolves the nearest unexpired future per name, with tick size converted from paise and BSE on segment 8', () => {
    const r = resolveFlowContracts(CSV, [{ symbol: 'NIFTY', exchange: 'NSE' }, { symbol: 'SENSEX', exchange: 'BSE' }, { symbol: 'CRUDEOIL', exchange: 'MCX' }, { symbol: 'COPPER', exchange: 'MCX' }], NOW, { allStocks: true });
    expect(r.NIFTY).toMatchObject({ securityId: '61471', segment: 'NSE_FNO', kind: 'INDEX', tickSize: 0.1, lotSize: 65 });
    expect(r.SENSEX).toMatchObject({ securityId: '1100929', segment: 'BSE_FNO', exchange: 'BSE', tickSize: 0.05, lotSize: 20 });
    expect(r.CRUDEOIL).toMatchObject({ segment: 'MCX_COMM', kind: 'COMMODITY', tickSize: 1 });
    expect(r.COPPER?.tickSize).toBe(0.05);
    expect(r.CRUDEOILM).toBeUndefined(); // not asked for
    expect(r.RELIANCE).toMatchObject({ securityId: '61697', exchange: 'NSE', kind: 'STOCK', tickSize: 0.1 }); // NSE stock future, never the BSE one
    expect(r['BAJAJ-AUTO']).toMatchObject({ kind: 'STOCK', tickSize: 1 });
    expect(r.OLDCO).toBeUndefined(); // expired
    expect(DHAN_SEGMENT_CODE.BSE_FNO).toBe(8);
  });
  it('leaves stocks out unless asked', () => {
    expect(resolveFlowContracts(CSV, [{ symbol: 'NIFTY', exchange: 'NSE' }], NOW).RELIANCE).toBeUndefined();
  });
  it('subscribes in messages of at most 100 instruments', () => {
    const ids = Array.from({ length: 244 }, (_, i) => ({ securityId: String(i), segment: 'NSE_FNO' as const }));
    const msgs = fullSubscriptions(ids).map((m) => JSON.parse(m));
    expect(msgs.map((m) => m.InstrumentCount)).toEqual([100, 100, 44]);
    expect(msgs.every((m) => m.RequestCode === 21 && m.InstrumentList.length <= DHAN_MAX_INSTRUMENTS_PER_MESSAGE)).toBe(true);
    expect(msgs.flatMap((m) => m.InstrumentList).map((x: any) => x.SecurityId)).toEqual(ids.map((x) => x.securityId));
  });
});

describe('LTQ reconciliation (master prompt 4.1)', () => {
  const s0 = { symbol: 'NIFTY', prevVolume: 1000, prevLtp: 100, prevSide: null, prevQuote: { bid: 99.9, ask: 100 } };
  const depth = [{ bidQty: 1, askQty: 1, bidOrders: 1, askOrders: 1, bidPrice: 100, askPrice: 100.1 }];
  it('books the observed last trade and keeps the rest unreconciled', () => {
    const one = tradeFromFullPacket(s0, { ltp: 100, volume: 1075, ltq: 75, depth }, 1);
    expect(one).toMatchObject({ trade: { qty: 75, side: 'BUY', price: 100 }, unreconciled: 0, ltqInvalid: false });
    const many = tradeFromFullPacket(s0, { ltp: 100, volume: 1300, ltq: 75, depth }, 1);
    expect(many).toMatchObject({ trade: { qty: 75 }, unreconciled: 225 });
  });
  it('treats an invalid LTQ (int16 overflow / zero) as unknown: the whole rise is unreconciled, no trade', () => {
    for (const ltq of [-5536, 0]) expect(tradeFromFullPacket(s0, { ltp: 100, volume: 1300, ltq, depth }, 1)).toMatchObject({ trade: null, unreconciled: 300, ltqInvalid: true });
  });
  it('never invents volume: a first packet sets the baseline, a falling volume re-bases', () => {
    expect(tradeFromFullPacket({ ...s0, prevVolume: null }, { ltp: 100, volume: 5000, ltq: 10, depth }, 1)).toMatchObject({ trade: null, unreconciled: 0 });
    expect(tradeFromFullPacket(s0, { ltp: 100, volume: 900, ltq: 10, depth }, 1)).toMatchObject({ trade: null, unreconciled: 0, next: { prevVolume: 900 } });
  });
  it('reads an instrument ESTIMATED when fresh, STALE after 2 minutes in session, UNAVAILABLE before any packet', () => {
    const q = { packets: 3, lastPacketAt: 1_000_000, tradedQty: 1, unreconciledQty: 0, ltqInvalid: 0 };
    expect(instrumentStatus(q, 1_000_000 + 1000, true)).toBe('ESTIMATED');
    expect(instrumentStatus(q, 1_000_000 + INSTRUMENT_STALE_MS + 1, true)).toBe('STALE');
    expect(instrumentStatus(q, 1_000_000 + INSTRUMENT_STALE_MS + 1, false)).toBe('ESTIMATED');
    expect(instrumentStatus(undefined, 1, true)).toBe('UNAVAILABLE');
  });
});

describe('footprint integrity and recording', () => {
  beforeEach(() => resetFlowStore());
  it('uses a multi-tick price row of ~5 bp, a whole number of ticks', () => {
    expect(flowPriceStep(25000, 0.1)).toBe(12.5);
    expect(flowPriceStep(300, 0.05)).toBe(0.15);
    expect(flowPriceStep(2800, 1)).toBe(1);
    expect(flowPriceStep(0, 0.1)).toBeNull();
    expect(flowPriceStep(100, null)).toBeNull();
  });
  it('marks a bar INCOMPLETE above the unreconciled share and withholds delta / imbalances', () => {
    const fp = buildFootprint([{ time: 1, price: 100, qty: 800, side: 'BUY' }, { time: 2, price: 100, qty: 200, side: 'SELL' }], 0, 900000, 1, 'INFERRED');
    expect(applyReconciliation({ ...fp }, 100)).toMatchObject({ incomplete: false, unreconciledVolume: 100, delta: 600 });
    const bad = applyReconciliation({ ...fp }, 1000 * FLOW_MAX_UNRECONCILED_SHARE / (1 - FLOW_MAX_UNRECONCILED_SHARE) + 1);
    expect(bad).toMatchObject({ incomplete: true, delta: null, deltaPct: null, buyImbalances: 0, sellImbalances: 0 });
    expect(bad.levels.length).toBeGreaterThan(0); // the observed trades still describe the bar
    expect(applyReconciliation(unavailableFootprint(0, 900000), 0)).toMatchObject({ incomplete: false, unreconciledVolume: 0 });
  });
  it('encodes events compactly (side 1 / -1 / 0, unreconciled as 9 with no price), in time order, gzip-round-trippable', () => {
    const rows = encodeFlowEvents([{ time: 1500, price: 100, qty: 5, side: 'BUY' }, { time: 1200, price: 99.5, qty: 2, side: null }], [{ time: 1300, qty: 7 }], 1000);
    expect(rows).toEqual([[200, 99.5, 2, 0], [300, null, 7, 9], [500, 100, 5, 1]]);
    expect(JSON.parse(gunzipSync(gzipSync(Buffer.from(JSON.stringify(rows)))).toString())).toEqual(rows);
  });
  it('carries unreconciled volume into the five-minute flow bars (it counts against the classified share)', () => {
    const t0 = Date.parse('2026-11-09T04:00:00Z');
    registerFlowSymbol('SENSEX', { exchange: 'BSE', instrument: 'SENSEX-Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: t0, kind: 'INDEX', tickSize: 0.05 });
    recordFlowTrade('SENSEX', { time: t0 + 1000, price: 80000, qty: 20, side: 'BUY' });
    recordFlowUnreconciled('SENSEX', t0 + 2000, 60);
    expect(flowFiveMinuteBars('SENSEX', t0, t0 + 300000)!.bars).toEqual([{ time: t0, buy: 20, sell: 0, unclassified: 0, trades: 1, unreconciled: 60 }]);
  });
});
