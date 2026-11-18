import { describe, expect, it } from 'vitest';
import { blotter, DEFAULT_BLOTTER, fromFresh, fromLegacy, summarize } from '../paper-unified';

const T = (iso: string) => Date.parse(iso);
const legacy = (o: Record<string, unknown>) => fromLegacy({ id: 'a', symbol: 'NIFTY', exchange: 'NSE', side: 'CE', strike: 25300, expiry: '2026-11-24', structureType: 'NAKED_LONG', direction: 'BULLISH', family: 'OF1', strategyLabel: 'OF1', state: 'LOSS', status: 'CLOSED', closeReason: 'STOP_LOSS', netR: -1.12, entry: 120, exitPrice: 80, includedInPerformance: true, excludedReason: null, mintedAt: T('2026-11-18T06:03:00Z'), exitAt: T('2026-11-18T07:00:00Z'), live: null, ...o } as never);
const fresh = (o: Record<string, unknown>) => fromFresh({ id: 'f1', strategy: 'HTA_HUMAN_TA_V1', direction: 'BULLISH', contract: 'BSE_FO:821869', expiry: '2026-11-20', status: 'CLOSED', session: '2026-11-17', openedAt: T('2026-11-17T05:31:00Z'), closedAt: T('2026-11-17T07:01:00Z'), entry: 471.65, exit: 660.75, r: 1.55, netPnl: 7459, exitReason: 'MAX_HOLD', market: 'BSE_VERIFIED_OPTIONS', markBid: null, ...o } as never, () => 'Human TA');

describe('one paper blotter', () => {
  it('maps a legacy trade: contract, result, reason in words; closed legacy rupees stay missing', () => {
    const r = legacy({});
    expect(r).toMatchObject({ engine: 'Legacy', strategy: 'OF1', result: 'LOSS', reason: 'Stop loss hit', netR: -1.12, netInr: null, open: false, day: '2026-11-18', dateLabel: '18 Nov 2026' });
    expect(r.contract).toMatch(/^NIFTY 25300 CE/);
    const open = legacy({ state: 'OPEN', status: 'OPEN_TRACKED', netR: null, closeReason: null, exitAt: null, live: { premium: 131, unrealisedNetR: 0.4, unrealisedPnlInr: 900 } });
    expect(open).toMatchObject({ open: true, result: 'OPEN', mark: 131, netR: 0.4, netInr: 900, reason: null });
    expect(legacy({ includedInPerformance: false, excludedReason: 'voided', status: 'VOIDED' }).excluded).toBe('voided');
  });
  it('maps a new-engine position with its rupees and reason', () => {
    expect(fresh({})).toMatchObject({ engine: 'New engine', strategy: 'Human TA', result: 'PROFIT', reason: 'Maximum holding time reached — closed at market', netR: 1.55, netInr: 7459, exchange: 'BSE', day: '2026-11-17' });
    expect(fresh({ status: 'OPEN', r: null, netPnl: null, markBid: 500 })).toMatchObject({ open: true, result: 'OPEN', mark: 500, netR: null, netInr: null });
  });
  it('views: Today keeps open trades from earlier days; engine, result and text filters; newest first', () => {
    const rows = [legacy({}), legacy({ id: 'b', mintedAt: T('2026-11-17T05:00:00Z'), state: 'OPEN', status: 'OPEN_TRACKED', netR: null, closeReason: null, exitAt: null }), fresh({})];
    expect(blotter(rows, DEFAULT_BLOTTER, '2026-11-18').map((r) => r.key)).toEqual(['L:a', 'L:b']);
    expect(blotter(rows, { ...DEFAULT_BLOTTER, view: 'OPEN' }, '2026-11-18').map((r) => r.key)).toEqual(['L:b']);
    expect(blotter(rows, { ...DEFAULT_BLOTTER, view: 'ALL', engine: 'New engine' }, '2026-11-18').map((r) => r.key)).toEqual(['N:f1']);
    expect(blotter(rows, { ...DEFAULT_BLOTTER, view: 'ALL', result: 'PROFIT' }, '2026-11-18').map((r) => r.key)).toEqual(['N:f1']);
    expect(blotter(rows, { ...DEFAULT_BLOTTER, view: 'ALL', query: 'human' }, '2026-11-18')).toHaveLength(1);
    expect(blotter(rows, { ...DEFAULT_BLOTTER, view: 'ALL' }, '2026-11-18')[0].key).toBe('L:a');
  });
  it('summary: open, today, per engine over 30 days (excluded and open trades not counted), best and worst', () => {
    const rows = [legacy({}), legacy({ id: 'c', netR: 2, state: 'WIN', closeReason: 'TARGET' }), legacy({ id: 'v', netR: -5, includedInPerformance: false, excludedReason: 'voided' }), fresh({}), legacy({ id: 'o', state: 'OPEN', status: 'OPEN_TRACKED', netR: null, closeReason: null })];
    const s = summarize(rows, '2026-11-18', T('2026-11-18T12:00:00Z'));
    expect(s.open).toBe(1);
    expect(s.today).toMatchObject({ closed: 2, wins: 1, losses: 1 });
    expect(s.today.netR).toBeCloseTo(0.88);
    expect(s.window.Legacy).toMatchObject({ trades: 4, closed: 2, wins: 1, winRate: 50 });
    expect(s.window.Legacy.netR).toBeCloseTo(0.88);
    expect(s.window['New engine']).toMatchObject({ closed: 1, winRate: 100, netR: 1.55 });
    expect(s.best?.strategy).toBe('Human TA (new)');
    expect(s.worst?.strategy).toBe('OF1 (legacy)');
  });
});
