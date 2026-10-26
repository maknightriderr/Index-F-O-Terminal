import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFootprint } from '@fno/analytics';
import type { MarketDataProvider } from '../../providers/interface.js';

const mocks = vi.hoisted(() => ({ footprints: vi.fn(), feed: vi.fn(), future: vi.fn(), history: vi.fn() }));
vi.mock('../order-flow-store.js', () => ({ footprintsFor: mocks.footprints }));
vi.mock('../dhan-feed.js', () => ({ orderFlowFeedStatus: mocks.feed }));
vi.mock('../option-chain.js', () => ({ resolveNearestFuturesContract: mocks.future }));
vi.mock('../../lib/cache.js', () => ({ cached: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn() }));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));

const { alignedFootprintsFor } = await import('../order-flow-alignment.js');
const { resolveNearestFutures } = await import('../../lib/dhan-feed-packets.js');
const { withDecisionTime } = await import('../decision-clock.js');
const { runRecording, runReplay } = await import('../../lib/io-tape.js');
const T = Date.parse('2026-10-06T10:45:00+05:30'), M = 900_000;
const bars = [{ time: T, open: 100, high: 105, low: 99, close: 104 }];
const provider = { getHistoricalData: mocks.history } as unknown as MarketDataProvider;
beforeEach(() => {
  vi.clearAllMocks();
  const fp = buildFootprint([{ time: T + 1, price: 119, qty: 60, side: 'BUY' }, { time: T + 2, price: 124, qty: 40, side: 'SELL' }], T, M, 1, 'INFERRED');
  fp.sourceInstrument = 'DHAN_OCT_FUT';
  mocks.footprints.mockResolvedValue(new Map([[T, fp]]));
  // Dhan's scrip master expiry carries a time (the real format, 26 Oct 2026 regression).
  mocks.feed.mockReturnValue({ instruments: { NIFTY: { tradingSymbol: 'DHAN_OCT_FUT', expiry: '2026-10-27 14:30:00', exchange: 'NSE' } } });
  mocks.future.mockResolvedValue({ token: 'ANGEL_TOKEN', underlying: 'NIFTY', exchange: 'NSE', expiry: '2026-10-27' });
  mocks.history.mockResolvedValue([{ timestamp: new Date(T).toISOString(), open: 120, high: 125, low: 119, close: 124, volume: 100 }]);
});
const read = () => withDecisionTime(T + M, () => alignedFootprintsFor(provider, 'NIFTY', 'NSE', bars));

describe('OF1 alignment input boundary', () => {
  it('joins contracts by exchange/underlying/expiry and matching bar time', async () => {
    const fp = (await read()).get(T)!;
    expect(fp.priceAlignment).toMatchObject({ status: 'ALIGNED', basis: 20, referenceClose: 104, futuresClose: 124 });
    expect(fp.levels.map(l => l.price)).toEqual([99, 104]);
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ token: 'ANGEL_TOKEN', exchange: 'NSE', segment: 'FO', interval: 'FIFTEEN_MINUTE' }));
  });
  it.each([{ expiry: '2026-11-24' }, { underlying: 'BANKNIFTY' }, { exchange: 'MCX' }])('refuses contract mismatch %s', async change => {
    mocks.future.mockResolvedValue({ token: 'OTHER', underlying: 'NIFTY', exchange: 'NSE', expiry: '2026-10-27', ...change });
    expect((await read()).get(T)?.priceAlignment).toMatchObject({ status: 'UNAVAILABLE', reason: 'CONTRACT_UNVERIFIED' });
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('26 Oct 2026 regression: the feed contract as resolveNearestFutures returns it (date + time) verifies against the Angel date', async () => {
    const csv = [
      'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
      'NSE,D,48704,FUTIDX,0,NIFTY-Oct2026-FUT,65.0,NIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
    ].join('\n');
    const resolved = resolveNearestFutures(csv, [{ symbol: 'NIFTY', exchange: 'NSE' }], T);
    expect(resolved.NIFTY.expiry).toBe('2026-10-27 14:30:00');
    mocks.feed.mockReturnValue({ instruments: resolved });
    // the recorder stamps each footprint with the feed's own trading symbol
    const fp = buildFootprint([{ time: T + 1, price: 119, qty: 60, side: 'BUY' }, { time: T + 2, price: 124, qty: 40, side: 'SELL' }], T, M, 1, 'INFERRED');
    fp.sourceInstrument = resolved.NIFTY.tradingSymbol;
    mocks.footprints.mockResolvedValue(new Map([[T, fp]]));
    expect((await read()).get(T)?.priceAlignment).toMatchObject({ status: 'ALIGNED', instrument: 'NIFTY-Oct2026-FUT', expiry: '2026-10-27', basis: 20 });
  });
  it('an unparseable feed expiry never verifies', async () => {
    mocks.feed.mockReturnValue({ instruments: { NIFTY: { tradingSymbol: 'DHAN_OCT_FUT', expiry: '27-10-2026', exchange: 'NSE' } } });
    expect((await read()).get(T)?.priceAlignment).toMatchObject({ status: 'UNAVAILABLE', reason: 'CONTRACT_UNVERIFIED' });
  });
  it('missing matching candle cannot use the previous candle basis', async () => {
    mocks.history.mockResolvedValue([{ timestamp: new Date(T - M).toISOString(), open: 120, high: 125, low: 119, close: 124 }]);
    expect((await read()).get(T)?.priceAlignment).toMatchObject({ status: 'UNAVAILABLE', reason: 'MATCHING_FUTURES_BAR_UNAVAILABLE' });
  });
  it('provider failure produces no aligned footprint', async () => {
    mocks.history.mockRejectedValue(new Error('feed unavailable'));
    expect((await read()).size).toBe(0);
  });
  it('no current flow skips instrument/history requests', async () => {
    mocks.footprints.mockResolvedValue(new Map());
    expect((await read()).size).toBe(0);
    expect(mocks.future).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('MCX verifies the same contract and preserves prices without extra history calls', async () => {
    mocks.feed.mockReturnValue({ instruments: { CRUDEOIL: { tradingSymbol: 'DHAN_OCT_FUT', expiry: '2026-10-27 23:30:00', exchange: 'MCX' } } });
    mocks.future.mockResolvedValue({ token: 'ANGEL_MCX', underlying: 'CRUDEOIL', exchange: 'MCX', expiry: '2026-10-27' });
    const mcxBars = [{ time: T, open: 120, high: 125, low: 119, close: 124 }];
    const result = await withDecisionTime(T + M, () => alignedFootprintsFor(provider, 'CRUDEOIL', 'MCX', mcxBars));
    expect(result.get(T)?.priceAlignment).toMatchObject({ status: 'ALIGNED', reference: 'FUTURES', basis: 0, method: 'SAME_CONTRACT' });
    expect(result.get(T)?.levels.map(l => l.price)).toEqual([119, 124]);
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('record/replay preserves alignment without reading current contracts/history', async () => {
    const recorded = await runRecording(read);
    vi.clearAllMocks();
    const replayed = await runReplay(recorded.tape, read);
    expect(replayed.error).toBeNull();
    expect(replayed.divergences).toEqual([]);
    expect(replayed.result).toEqual(recorded.result);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.feed).not.toHaveBeenCalled();
    expect(mocks.footprints).not.toHaveBeenCalled();
  });
});
