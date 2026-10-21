import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), session: { clientId: '1100000000', accessToken: 'tok' } as { clientId: string; accessToken: string } | null, rejected: vi.fn() }));
vi.mock('axios', () => ({ default: { post: m.post, get: m.get } }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../../services/dhan-session.js', () => ({ dhanSession: () => m.session, markDhanTokenRejected: m.rejected }));
process.env.QUOTE_PROVIDER = 'DHAN';

const Q = await import('../quotes.js');

const CSV = [
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
  'NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance,,-0.01000,XX,0.1000,NA,ES,EQ,RELIANCE',
  'NSE,E,1327,EQUITY,0,HCL-INSYS,1.0,HCL,,-0.01000,XX,0.0500,NA,ES,EQ,HCL',
  'NSE,D,43210,OPTSTK,0,TCS-Oct2026-2440-CE,175,TCS,2026-10-27 14:30:00,2440.00000,CE,0.0500,M,OP,NA,TCS',
  'NSE,D,43211,OPTSTK,0,TCS-Oct2026-2460-CE,175,TCS,2026-10-27 14:30:00,2460.00000,CE,0.0500,M,OP,NA,TCS',
  'MCX,M,573422,FUTCOM,0,CRUDEOIL-19Nov2026-FUT,100,CRUDE,2026-11-19 23:30:00,-0.01000,XX,1.0000,M,FUTCOM,NA,CRUDEOIL',
  'NSE,I,13,INDEX,0,NIFTY,1.0,Nifty 50,,-0.01000,XX,0.0500,NA,INDEX,NA,NIFTY',
].join('\n');

const inst = (o: object) => ({ exchange: 'NSE', segment: 'FO', instrumentType: 'OPTSTK', ...o }) as never;
const INSTRUMENTS = [
  inst({ token: '2885', symbol: 'RELIANCE-EQ', segment: 'CM', instrumentType: 'EQ' }),
  inst({ token: '1327', symbol: 'HCL-INSYS-EQ', segment: 'CM', instrumentType: 'EQ' }),
  inst({ token: '43210', symbol: 'TCS27OCT262440CE', strike: 2440, optionType: 'CE', expiry: '2026-10-27' }),
  // Same id, a different strike on Angel One's side: never routed.
  inst({ token: '43211', symbol: 'TCS27OCT262480CE', strike: 2480, optionType: 'CE', expiry: '2026-10-27' }),
  inst({ token: '573422', symbol: 'CRUDEOIL19NOV26FUT', exchange: 'MCX', instrumentType: 'FUTCOM', expiry: '2026-11-19' }),
  // An index: Angel One's token is not Dhan's id.
  inst({ token: '13', symbol: 'Nifty 50', segment: 'CM', instrumentType: 'INDEX' }),
];

describe('Dhan quotes: only the same contract is ever routed', () => {
  it('equity by symbol, future by expiry, option by expiry + strike + side; an index never', () => {
    const t = Q.verifiedDhanTokens(CSV, INSTRUMENTS);
    expect([...t.get('NSE_CM')!]).toEqual(['2885', '1327']);
    expect([...t.get('NSE_FO')!]).toEqual(['43210']);
    expect([...t.get('MCX_FO')!]).toEqual(['573422']);
  });

  it('a quote item maps to the provider shape; the previous close is last price − net change', () => {
    const q = Q.quoteFromDhan('43210', {
      last_price: 52.5, net_change: 2.5, ohlc: { open: 49, high: 55, low: 48, close: 52.5 }, volume: 1200, oi: 3400, average_price: 51.2,
      last_trade_time: '21/10/2026 15:29:58', depth: { buy: [{ quantity: 175, orders: 2, price: 52.4 }], sell: [{ quantity: 350, orders: 3, price: 52.6 }] },
    }, 1000);
    expect(q).toMatchObject({ token: '43210', ltp: 52.5, open: 49, high: 55, low: 48, close: 50, volume: 1200, oi: 3400, netChange: 2.5, percentChange: 5, avgPrice: 51.2, bid: 52.4, ask: 52.6, bidQty: 175, askQty: 350, timestamp: 1000, source: 'DHAN' });
    expect(q.lastTradeTimestamp).toBe(Date.parse('2026-10-21T15:29:58+05:30'));
    expect(q.exchangeTimestamp).toBeUndefined();
    expect(Q.parseDhanTradeTime('01/01/1980 00:00:00')).toBeUndefined();
  });

  it('QUOTE_PROVIDER: DHAN only when asked; anything else stays on Angel One', () => {
    expect(Q.parseQuoteProvider('dhan')).toBe('DHAN');
    expect(Q.parseQuoteProvider(undefined)).toBe('ANGEL');
    expect(Q.parseQuoteProvider('zerodha')).toBe('ANGEL');
  });
});

describe('Dhan quotes: merged calls and fallback', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const getInstruments = async () => [] as never[];
  beforeEach(() => {
    m.post.mockReset();
    m.rejected.mockReset();
    m.session = { clientId: '1100000000', accessToken: 'tok' };
    Q.setRoutableForTest(new Map([['NSE_FO', new Set(['43210', '43212'])], ['NSE_CM', new Set(['2885'])]]), today);
  });

  it('two requests waiting together cost one call; tokens Dhan cannot serve are left out', async () => {
    m.post.mockResolvedValue({ data: { status: 'success', data: { NSE_FNO: { '43210': { last_price: 50 }, '43212': { last_price: 61 } }, NSE_EQ: { '2885': { last_price: 1400 } } } } });
    const [a, b] = await Promise.all([Q.dhanQuotes('NSE_FO', ['43210', '43212', '99999'], getInstruments), Q.dhanQuotes('NSE_CM', ['2885', '99926000'], getInstruments)]);
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.post.mock.calls[0][1]).toEqual({ NSE_FNO: [43210, 43212], NSE_EQ: [2885] });
    expect(m.post.mock.calls[0][2].headers).toMatchObject({ 'access-token': 'tok', 'client-id': '1100000000' });
    expect([...a.keys()]).toEqual(['43210', '43212']);
    expect([...b.keys()]).toEqual(['2885']);
  });

  it('a rejected token: nothing from Dhan (Angel One serves all of it) and the session is told', async () => {
    m.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    expect((await Q.dhanQuotes('NSE_FO', ['43210'], getInstruments)).size).toBe(0);
    expect(m.rejected).toHaveBeenCalledWith('tok');
  });

  it('no Dhan session: no call at all', async () => {
    m.session = null;
    expect((await Q.dhanQuotes('NSE_FO', ['43210'], getInstruments)).size).toBe(0);
    expect(m.post).not.toHaveBeenCalled();
  });
});
