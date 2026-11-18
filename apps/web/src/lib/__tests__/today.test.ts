import { describe, expect, it } from 'vitest';
import { bookToday, displayDay, legacyFeed, marketRead, pulseRow, rCurve, scorecard, sortFeed, watchFeed, freshFeed } from '../today';
import { lastSessionBars } from '../use-pulse';

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-11-18T18:21:00Z'); // 23:51 IST
const trade = (o: Record<string, unknown>) => ({ id: 'x', symbol: 'NIFTY', exchange: 'NSE', side: 'CE', strike: 25300, family: 'OF1', strategyLabel: 'OF1', state: 'LOSS', closeReason: 'STOP_LOSS', netR: -1.12, mintedAt: T('2026-11-18T06:03:00Z'), exitAt: T('2026-11-18T07:00:00Z'), ...o }) as never;

describe('today view-model', () => {
  it('pulse row: quote first; MCX from its bars (change vs the session open); stale bias flagged', () => {
    const q = pulseRow({ symbol: 'NIFTY', exchange: 'NSE' }, { quote: { ltp: 25227.95, changePercent: -0.63, low: 25141.8, high: 25390.8 }, bias: { direction: 'BEARISH', confidence: 76, regime: 'WEAK_BULL_TREND', assessedAt: NOW - 3600_000 } }, NOW);
    expect(q).toMatchObject({ last: 25227.95, changePct: -0.63, changeBasis: 'DAY', direction: 'BEARISH', stale: false });
    const bars = [{ time: 1, open: 100, high: 101, low: 99, close: 100 }, { time: 2, open: 100, high: 103, low: 98, close: 102 }];
    const m = pulseRow({ symbol: 'GOLD', exchange: 'MCX' }, { bars }, NOW);
    expect(m).toMatchObject({ last: 102, changeBasis: 'SESSION_OPEN', low: 98, high: 103, direction: null });
    expect(m.changePct).toBeCloseTo(2);
    expect(pulseRow({ symbol: 'MIDCPNIFTY', exchange: 'NSE' }, { bias: { direction: 'BULLISH', confidence: 94, regime: null, assessedAt: NOW - 40 * 86_400_000 } }, NOW).stale).toBe(true);
    expect(pulseRow({ symbol: 'X', exchange: 'NSE' }, {}, NOW)).toMatchObject({ last: null, changePct: null, direction: null });
  });

  it('market read is built only from what is shown; nothing known gives null', () => {
    expect(marketRead([], { closed: 0, wins: 0, open: 0 })).toBeNull();
    const rows = [
      pulseRow({ symbol: 'NIFTY', exchange: 'NSE' }, { quote: { ltp: 1, changePercent: -0.63, low: 1, high: 1 }, bias: { direction: 'BEARISH', confidence: 76, regime: null, assessedAt: NOW } }, NOW),
      pulseRow({ symbol: 'FINNIFTY', exchange: 'NSE' }, { quote: { ltp: 1, changePercent: -0.72, low: 1, high: 1 }, bias: { direction: 'BEARISH', confidence: 83, regime: null, assessedAt: NOW } }, NOW),
      pulseRow({ symbol: 'GOLD', exchange: 'MCX' }, { bias: { direction: 'BEARISH', confidence: 95, regime: null, assessedAt: NOW } }, NOW),
      pulseRow({ symbol: 'NATURALGAS', exchange: 'MCX' }, { bias: { direction: 'BULLISH', confidence: 95, regime: null, assessedAt: NOW } }, NOW),
    ];
    const s = marketRead(rows, { closed: 7, wins: 0, open: 4 })!;
    expect(s).toMatch(/Indices fell: NIFTY −0.63%, FINNIFTY −0.72%/);
    expect(s).toMatch(/bearish on 2 of 2 indices/);
    expect(s).toMatch(/MCX: bearish on gold, bullish on natural gas/);
    expect(s).toMatch(/7 closed today, no winner yet, 4 open/);
  });

  it('one feed for both engines and confirmed structures; book and R curve from it', () => {
    const day = '2026-11-18';
    const legacy = legacyFeed([trade({}), trade({ symbol: 'GOLD', exchange: 'MCX', state: 'OPEN', closeReason: null, netR: null, exitAt: null, mintedAt: T('2026-11-18T12:40:00Z') }), trade({ mintedAt: T('2026-11-17T06:00:00Z') })], day);
    expect(legacy).toHaveLength(2);
    expect(legacy.map((i) => i.state)).toEqual(['LOSS', 'ACTIVE']);
    expect(legacy[0].why).toBe('Stop loss hit');
    const fresh = freshFeed([{ session: day, status: 'CLOSED', r: 1.55, netPnl: 7459, exitReason: 'MAX_HOLD', strategy: 'HTA_HUMAN_TA_V1', contract: 'BSE_FO:1', market: 'BSE_VERIFIED_OPTIONS', openedAt: T('2026-11-18T05:31:00Z'), closedAt: T('2026-11-18T07:01:00Z') } as never], day, () => 'Human TA');
    expect(fresh[0]).toMatchObject({ engine: 'New engine', state: 'PROFIT', exchange: 'BSE', strategy: 'Human TA' });
    const watch = watchFeed([{ symbol: 'GOLD', type: 'STRUCTURE_CONFIRMED', message: 'GOLD (MCX)', createdAt: '2026-11-18T14:01:00.000Z' }, { symbol: 'X', type: 'TRADE_SETUP_CLOSED', message: '', createdAt: NOW }], day);
    expect(watch).toHaveLength(1);
    expect(watch[0]).toMatchObject({ state: 'NEW', open: { kind: 'asset', exchange: 'MCX' } });
    const feed = sortFeed([...legacy, ...fresh, ...watch]);
    expect(feed[0].at).toBeGreaterThan(feed[feed.length - 1].at);
    const book = bookToday(feed);
    expect(book).toMatchObject({ trades: 3, closed: 2, wins: 1, losses: 1, open: 1, byEngine: { Legacy: 2, 'New engine': 1 } });
    expect(book.netR).toBeCloseTo(0.43);
    const curve = rCurve(feed, T('2026-11-18T03:30:00Z'));
    expect(curve.map((p) => Math.round(p.r * 100) / 100)).toEqual([0, -1.12, 0.43]);
  });

  it('scorecard keeps the two engines apart and sorts by net R', () => {
    const rows = scorecard([trade({ family: 'A3', netR: 2 }), trade({ family: 'A3', netR: -1 }), trade({ family: 'A4', netR: -3 }), trade({ family: 'A4', netR: null })], [{ status: 'CLOSED', r: 1.5, strategy: 'HTA' } as never, { status: 'OPEN', r: null, strategy: 'HTA' } as never], () => 'Human TA');
    expect(rows.map((r) => [r.strategy, r.engine, r.trades])).toEqual([['Human TA', 'New engine', 1], ['A3', 'Legacy', 2], ['A4', 'Legacy', 1]]);
    expect(rows[1].winRate).toBe(50);
  });

  it('before the first session of the day the screen shows the last session with activity', () => {
    const open = T('2026-11-19T03:30:00Z');
    expect(displayDay(T('2026-11-18T18:55:00Z'), ['2026-11-17', '2026-11-18'], open)).toEqual({ day: '2026-11-18', live: false });
    expect(displayDay(T('2026-11-19T04:00:00Z'), ['2026-11-18'], open)).toEqual({ day: '2026-11-19', live: true });
    expect(displayDay(T('2026-11-18T18:55:00Z'), ['2026-11-19'], open)).toEqual({ day: '2026-11-19', live: true });
    expect(displayDay(T('2026-11-18T18:55:00Z'), [], open)).toEqual({ day: '2026-11-19', live: true });
  });

  it('bars: only the latest IST day present, in time order', () => {
    const b = lastSessionBars([
      { timestamp: '2026-11-18T09:20:00+05:30', open: 2, high: 2, low: 2, close: 2 },
      { timestamp: '2026-11-17T15:25:00+05:30', open: 1, high: 1, low: 1, close: 1 },
      { timestamp: '2026-11-18T09:15:00+05:30', open: 3, high: 3, low: 3, close: 3 },
    ]);
    expect(b.map((x) => x.close)).toEqual([3, 2]);
    expect(lastSessionBars([])).toEqual([]);
  });
});
