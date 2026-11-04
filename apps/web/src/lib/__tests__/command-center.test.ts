import { describe, expect, it } from 'vitest';
import type { FreshStartStatus, OptionChain } from '@fno/shared';
import { accountView, equityCurve, exitReasons, istDay, pickContract, positionViews, promotionGate, rHistogram, setupRadar, stopToTarget, timeHeatmap, toPositionView } from '../command-center';

const NOW = Date.parse('2026-11-02T06:30:00Z'); // 12:00 IST
const at = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00+05:30`);

function pos(over: Record<string, unknown> = {}, cand: Record<string, unknown> = {}) {
  const state = {
    id: 'p1', entry: 100, quantity: 75, openedAt: at('10:00'), lastEventAt: at('10:40'), state: 'CLOSED', originalRiskCurrency: 1250,
    emergencyStop: 75, currentStop: 80, highBid: 130, exitPrice: 120, exitReason: 'TARGET', netPnl: 1400, maxUnderlyingFavorable: 60,
    contract: { id: 'NIFTY-24850-CE', multiplier: 1, delta: 0.52, market: 'NSE_INDEX_OPTIONS', evidence: { underlying: 'NIFTY', strike: 24850, expiry: '2026-11-04' } },
    candidate: { strategy: 'NEW_ORB_RETEST_V1', direction: 'BULLISH', instrument: 'NIFTY', referenceEntry: 24800, stop: 24760, target: 24900, at: at('09:59') },
    ...over,
  } as Record<string, unknown>;
  state.candidate = { ...(state.candidate as object), ...cand };
  return { strategy: 'NEW_ORB_RETEST_V1', version: 'NEW-INTRADAY-1.4', session: '2026-11-02', status: String(state.state), state };
}

const status = (positions: ReturnType<typeof pos>[], extra: Partial<FreshStartStatus> = {}) =>
  ({ capital: 500000, positions, candidates: [], evaluations: [], performance: [], strategies: [], ...extra }) as unknown as FreshStartStatus;

describe('position views', () => {
  it('reads a stored paper position without inventing fields', () => {
    const v = toPositionView(pos())!;
    expect(v).toMatchObject({ contract: 'NIFTY 24850 CE', side: 'CE', units: 75, r: 1400 / 1250, strategyLabel: 'ORB retest', expiry: '2026-11-04' });
    expect(v.closedAt).toBe(at('10:40'));
  });
  it('drops unreadable rows instead of half-rendering them', () => {
    expect(toPositionView({ strategy: 'x', version: 'v', session: 's', status: 'OPEN', state: { id: 'x' } })).toBeNull();
    expect(positionViews(status([pos(), { strategy: 'x', version: 'v', session: 's', status: 'OPEN', state: null } as never]))).toHaveLength(1);
  });
  it('places the best bid between the premium stop and the 1.5R premium', () => {
    const v = toPositionView(pos({ state: 'OPEN', highBid: 105 }))!;
    const l = stopToTarget(v);
    expect(l.target).toBeCloseTo(100 + 1.5 * (1250 / 75));
    expect(l.markAt).toBeGreaterThan(l.entryAt);
  });
});

describe('account', () => {
  it('counts today, open risk and the drawdown against the 5% pause', () => {
    const ps = positionViews(status([pos(), pos({ id: 'p2', netPnl: -1250, exitReason: 'STOP' }), pos({ id: 'p3', state: 'OPEN', netPnl: null })]));
    const a = accountView(status([]), ps, NOW);
    expect(a).toMatchObject({ capital: 500000, riskPerTrade: 2500, todayNet: 150, todayClosed: 2, todayWins: 1, todayLosses: 1, open: 1, openRisk: 1250 });
    const loss = accountView(status([]), positionViews(status([pos({ netPnl: -7500 })])), NOW);
    expect(loss.drawdownUsed).toBeCloseTo(0.3);
    expect(loss.drawdownPct).toBeCloseTo(1.5);
  });
  it('uses the IST calendar day', () => {
    expect(istDay(Date.parse('2026-11-01T19:00:00Z'))).toBe('2026-11-02');
  });
});

describe('curves and distributions', () => {
  const ps = positionViews(status([pos({ id: 'a', netPnl: 1250, lastEventAt: at('10:30') }), pos({ id: 'b', netPnl: -2500, exitReason: 'STOP+THIN_BOOK_HAIRCUT', lastEventAt: at('11:00'), openedAt: at('10:45') }), pos({ id: 'c', netPnl: 3750, lastEventAt: at('12:00'), openedAt: at('11:40') })]));
  it('builds equity with a running drawdown', () => {
    expect(equityCurve(ps, 500000).map((p) => [p.equity, p.drawdown])).toEqual([[501250, 0], [498750, 2500], [502500, 0]]);
  });
  it('buckets R multiples', () => {
    const h = rHistogram(ps);
    expect(h.find((b) => b.label === '+1')!.n).toBe(1);
    expect(h.find((b) => b.label === '≤−1')!.n).toBe(1);
    expect(h.find((b) => b.label === '3+')!.n).toBe(1);
  });
  it('averages R by IST entry time and groups exit reasons by prefix', () => {
    const orb = timeHeatmap(ps).find((r) => r.strategy === 'NEW_ORB_RETEST_V1')!;
    expect(orb.cells[1]).toEqual({ r: 1, n: 1 });
    expect(exitReasons(ps).map((r) => r.reason).sort()).toEqual(['STOP', 'TARGET']);
  });
});

describe('promotion gate', () => {
  it('fails every check with no evidence, passes with enough', () => {
    expect(promotionGate(undefined).every((g) => !g.ok)).toBe(true);
    const ok = promotionGate({ closed: 40, independentSessions: 25, expectancyR: 0.3, profitFactor: 1.6, winRate95: [0.45, 0.7] } as never);
    expect(ok.every((g) => g.ok)).toBe(true);
  });
});

describe('setup radar', () => {
  it('prefers an open trade, then a candidate decision, then the evaluation refusal', () => {
    const s = status([pos({ id: 'o', state: 'OPEN', netPnl: null })], {
      evaluations: [{ id: 'e', at: new Date(at('11:55')).toISOString(), instrument: 'BANKNIFTY', session: 's', refusals: [{ strategy: 'NEW_VWAP_PULLBACK_V1', code: 'NO_PULLBACK' }] }],
      candidates: [{ id: 'c', at: new Date(at('11:00')).toISOString(), strategy: 'NEW_ORB_RETEST_V1', decision: 'REFUSED', code: 'WIDE_SPREAD', evidence: { candidate: { instrument: 'BANKNIFTY' } } }],
    });
    const rows = setupRadar(s, positionViews(s), NOW);
    const bn = rows.find((r) => r.instrument === 'BANKNIFTY')!;
    expect(bn.cells.NEW_VWAP_PULLBACK_V1).toMatchObject({ state: 'NO_SETUP', code: 'NO_PULLBACK' });
    expect(bn.cells.NEW_ORB_RETEST_V1).toMatchObject({ state: 'REFUSED', code: 'WIDE_SPREAD' });
    expect(bn.cells.NEW_PREVIOUS_SESSION_SWEEP_V1.state).toBe('NOT_EVALUATED');
    expect(rows.find((r) => r.instrument === 'NIFTY')!.cells.NEW_ORB_RETEST_V1.state).toBe('IN_TRADE');
  });
  it('ignores yesterday', () => {
    const s = status([], { evaluations: [{ id: 'e', at: '2026-11-01T06:00:00Z', instrument: 'NIFTY', session: 's', refusals: [] }] });
    expect(setupRadar(s, [], NOW)).toEqual([]);
  });
});

describe('contract picker', () => {
  const leg = (delta: number, bid: number, ask: number, over: Record<string, unknown> = {}) => ({ token: 't', ltp: ask, bid, ask, delta, iv: 13, oi: 1, changeOi: 0, volume: 0, timestamp: NOW - 1000, bidQty: 300, askQty: 300, ...over });
  const chain = {
    atmStrike: 24850, strikeInterval: 50, lotSize: 75,
    strikes: [
      { strike: 24750, call: leg(0.66, 180, 180.4), put: leg(-0.34, 60, 60.2) },
      { strike: 24800, call: leg(0.6, 150, 150.2, { askQty: 10 }), put: leg(-0.4, 80, 80.2) },
      { strike: 24850, call: leg(0.52, 118, 118.4), put: leg(-0.48, 104, 104.3) },
      { strike: 24900, call: leg(0.44, 90, 90.2), put: leg(-0.56, 130, 135) },
    ],
  } as unknown as OptionChain;
  it('mirrors the admission checks and sizes at the 75% emergency stop', () => {
    const r = pickContract(chain, 'CE', 500000, NOW);
    expect(r.selected?.strike).toBe(24850);
    // 0.5% risk (₹2,500): one lot risks (118.45 − 88.80) × 75 ≈ ₹2,224 at the 75% emergency stop, so it fits.
    expect(r.sizing).toMatchObject({ riskBudget: 2500, lots: 1, units: 75 });
    expect(r.sizing!.emergencyStop).toBeCloseTo(88.85);
    const cheap = pickContract({ ...chain, strikes: [{ strike: 24850, call: leg(0.5, 50, 50.2), put: null }] } as unknown as OptionChain, 'CE', 500000, NOW);
    expect(cheap.sizing).toMatchObject({ lots: 2, units: 150 });
    // Above ~₹133 premium one NIFTY lot exceeds ₹2,500 at the emergency stop: the engine would refuse ZERO_PERMITTED_LOTS.
    const dear = pickContract({ ...chain, strikes: [{ strike: 24850, call: leg(0.5, 150, 150.2), put: null }] } as unknown as OptionChain, 'CE', 500000, NOW);
    expect(dear.sizing).toMatchObject({ lots: 0 });
    const why = Object.fromEntries(r.rejected.map((x) => [x.strike, x.firstFailure]));
    expect(why[24750]).toMatch(/Delta/);
    expect(why[24800]).toMatch(/Depth/);
    expect(why[24900]).toMatch(/Delta/);
  });
  it('rejects a wide spread and a stale quote, and the wrong sign', () => {
    const r = pickContract(chain, 'PE', 500000, NOW);
    expect(r.selected?.strike).toBe(24850);
    expect(r.rejected.find((x) => x.strike === 24900)!.firstFailure).toMatch(/Spread/);
    const stale = pickContract({ ...chain, strikes: [{ strike: 24850, call: leg(0.52, 118, 118.4, { timestamp: NOW - 5000 }), put: null }] } as unknown as OptionChain, 'CE', null, NOW);
    expect(stale.selected).toBeNull();
    expect(stale.rejected[0].firstFailure).toMatch(/Quote/);
  });
});

describe('live mark', () => {
  it('attaches the exit monitor bid to held positions only and marks the rail with it', () => {
    const s = status([pos({ id: 'o', state: 'OPEN', netPnl: null, highBid: 130 }), pos({ id: 'c' })], { feedQualification: { marks: { o: { bid: 110, ask: 110.5, at: NOW, underlying: 24810 }, c: { bid: 1, ask: 2, at: NOW, underlying: null } } } } as never);
    const [open, closed] = positionViews(s);
    expect(open).toMatchObject({ markBid: 110, markAt: NOW });
    expect(closed.markBid).toBeNull();
    expect(stopToTarget(open).mark).toBe(110);
  });
});

describe('order-flow shadow', () => {
  it('reads the entry tag and groups closed trades by it', async () => {
    const { orderFlowShadow } = await import('../command-center');
    const tagged = (id: string, alignment: string | null, net: number) => pos({ id, netPnl: net, candidate: { strategy: 'NEW_MOMENTUM_BREAKOUT_V1', direction: 'BULLISH', instrument: 'NIFTY', referenceEntry: 24800, stop: 24760, target: 24900, at: at('09:59'), evidence: alignment ? { orderFlow: { alignment } } : {} } });
    const views = positionViews(status([tagged('a', 'ALIGNED', 1250), tagged('b', 'ALIGNED', -625), tagged('c', 'OPPOSED', -1250), tagged('d', null, 100)]));
    expect(views.map((v) => v.orderFlow)).toEqual(['ALIGNED', 'ALIGNED', 'OPPOSED', 'UNTAGGED']);
    const rows = Object.fromEntries(orderFlowShadow(views).map((r) => [r.tag, r]));
    expect(rows.ALIGNED).toMatchObject({ trades: 2, wins: 1, net: 625 });
    expect(rows.ALIGNED.avgR).toBeCloseTo(0.25);
    expect(rows.OPPOSED).toMatchObject({ trades: 1, wins: 0, avgR: -1 });
    expect(rows.UNTAGGED.trades).toBe(1);
  });
});
