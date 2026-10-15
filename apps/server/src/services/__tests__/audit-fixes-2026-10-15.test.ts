// ============================================================
// AUDIT FIXES (2026-10-15) — measurement defects and the evidence reports
// ============================================================
// Every fix here is measurement only. The tests pin (a) each defect's
// corrected behaviour, (b) that the decision inputs those modules also feed
// are unchanged, and (c) the arithmetic of the evidence reports on small,
// hand-checkable inputs.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnedToEntryOf, summarisePostExit } from '../measurement-core.js';
import { sessionEndExitTime } from '../validation-gates.js';
import { segmentOf } from '../diagnostics-metrics.js';
import { costForDiagnostics, measureSetupCost, MAX_USABLE_SPREAD_SHARE_OF_MID, type OptionQuoteInput } from '../setup-cost.js';
import { entryFlagsV11, aggregateEntryRules, ENTRY_RULES_V11, SHADOW_RULES_V11_REGISTERED_AT, SHADOW_RULES_REGISTERED_AT } from '../shadow-rules.js';
import {
  EVIDENCE_RULES,
  clusterBootstrapMean,
  clusterBootstrapDiff,
  spearman,
  spearmanByDay,
  strategyKeyOf,
  scorecard,
  forwardMoves,
  signalQuality,
  gateValidation,
  replayCaps,
  bookStats,
  type DecisionPoint,
  type ReplayTrade,
  type ScoreRow,
} from '../evaluation-core.js';
import { archiveRowsOf, archivableDates, archiveWindowOpen, ALWAYS_ARCHIVED } from '../bar-archive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('post-exit "returned to entry" (was trivially true for every losing exit)', () => {
  it('a win or flat exit returns when a later LOW reaches entry', () => {
    expect(returnedToEntryOf(100, 130, 99, 140)).toBe(true);
    expect(returnedToEntryOf(100, 130, 101, 140)).toBe(false);
    expect(returnedToEntryOf(100, 100, 100, 110)).toBe(true);
  });
  it('a losing exit returns only when a later HIGH recovers to entry', () => {
    expect(returnedToEntryOf(100, 70, 60, 95)).toBe(false); // the old rule (min <= entry) said true
    expect(returnedToEntryOf(100, 70, 60, 100)).toBe(true);
  });
  it('missing prices give null, never a guess', () => {
    expect(returnedToEntryOf(null, 70, 60, 95)).toBeNull();
    expect(returnedToEntryOf(100, 70, 60, null)).toBeNull();
  });
  it('the report re-derives the flag from stored prices, so rows written before the fix read correctly', () => {
    const row = (exitPrice: number, minAfter: number, maxAfter: number, stored: boolean) => ({
      status: 'OBSERVED',
      outcome: 'LOSS',
      record: { entry: 100, exitPrice, option: { minAfter, maxAfter, returnedToEntry: stored } },
    });
    // Two old losing rows both stored `true`; only one actually recovered to entry.
    const s = summarisePostExit([row(70, 60, 95, true), row(70, 60, 101, true)]);
    expect(s.stopExits.shareReturnedToEntry).toBe(50);
  });
});

describe('session-end exit time (was the 00:00 IST rollover)', () => {
  it('stamps the close of the trade’s own session', () => {
    const minted = ist('2026-10-06T10:15:00');
    const rollover = ist('2026-10-07T00:00:00');
    expect(sessionEndExitTime('NSE', minted, rollover)).toBe(ist('2026-10-06T15:30:00'));
  });
  it('uses MCX’s own close (23:30 during US daylight saving)', () => {
    expect(sessionEndExitTime('MCX', ist('2026-10-06T21:54:00'), ist('2026-10-07T00:00:00'))).toBe(ist('2026-10-06T23:30:00'));
  });
  it('falls back to now when the close is not yet past, or there is no session that day', () => {
    const now = ist('2026-10-06T14:00:00');
    expect(sessionEndExitTime('NSE', ist('2026-10-06T10:00:00'), now)).toBe(now);
    const sundayNow = ist('2026-10-12T01:00:00');
    expect(sessionEndExitTime('NSE', ist('2026-10-11T10:00:00'), sundayNow)).toBe(sundayNow);
    expect(sessionEndExitTime('NSE', null, now)).toBe(now);
  });
  it('only the INTRADAY session-end close uses it (market-bias.ts)', () => {
    const src = readFileSync(path.resolve(HERE, '../market-bias.ts'), 'utf-8');
    expect(src).toMatch(/close\.reason === 'SESSION_ENDED' && close\.mode === 'INTRADAY' \? sessionEndExitTime\(/);
  });
});

describe('segment label (NSE stocks were labelled INDEX)', () => {
  it('splits single stocks from indices when the instrument is known', () => {
    expect(segmentOf('NSE', 'RELIANCE')).toBe('STOCK');
    expect(segmentOf('NSE', 'NIFTY')).toBe('INDEX');
    expect(segmentOf('BSE', 'SENSEX')).toBe('INDEX');
    expect(segmentOf('MCX', 'GOLD')).toBe('MCX');
  });
  it('keeps the old exchange-only answer for callers without an instrument', () => {
    expect(segmentOf('NSE')).toBe('INDEX');
    expect(segmentOf('MCX')).toBe('MCX');
  });
});

describe('cost in R from a quote that is not a market (GOLD 230.5 / 26,797)', () => {
  const leg = (over: Partial<OptionQuoteInput> = {}): OptionQuoteInput => ({ side: 'PE', strike: 155000, expiry: '2026-10-30', strikeBasis: 'ATM_PROXY', premium: 13513.75, bid: 230.5, ask: 26797, delta: -0.44, lotSize: 1, ...over });
  const geometry = { entry: 150000, stop: 150280, t1: 149500, atr: 150, costVersion: 'COST-2.0' };
  it('is stored for the diagnostics with no cost in R (was 216R) and no net R', () => {
    const m = costForDiagnostics(measureSetupCost({ ...geometry, option: leg() }))!;
    expect(m.costR).toBeNull();
    expect(m.netR).toBeNull();
    expect(m.spreadR).toBeNull();
    expect(m.costPctOfPremium!).toBeGreaterThan(100); // parts and % of premium kept
  });
  it('leaves the live measurement exactly as before, so no decision that reads it can move', () => {
    const m = measureSetupCost({ ...geometry, option: leg() });
    expect(m.quoteUsableForR).toBe(false);
    expect(m.costR).toBeGreaterThan(200); // the pre-fix value: the router's ceiling and the arbitration see what they always saw
    expect(m.netR).not.toBeNull();
    expect(m.costPctOfPremium!).toBeGreaterThan(100); // far above the 5% ceiling: refused there as before
  });
  it('a normal wide quote below the threshold is stored unchanged', () => {
    const premium = 100;
    const m = measureSetupCost({ ...geometry, option: leg({ premium, bid: 80, ask: 120, delta: -0.5 }) });
    expect((120 - 80) / ((120 + 80) / 2)).toBeLessThan(MAX_USABLE_SPREAD_SHARE_OF_MID);
    expect(m.quoteUsableForR).toBe(true);
    expect(costForDiagnostics(m)).toBe(m);
    expect(costForDiagnostics(null)).toBeNull();
  });
});

describe('SHADOW-1.1 entry rules (measurement only)', () => {
  it('registers after SHADOW-1.0 and only flags, never skips', () => {
    expect(SHADOW_RULES_V11_REGISTERED_AT).toBeGreaterThan(SHADOW_RULES_REGISTERED_AT);
    expect(entryFlagsV11({ direction: 'BULLISH', netRiskReward: 0.4, positioningNet: 2 })).toEqual({ NET_RR_FLOOR_1: true, POSITIONING_OPPOSED: false });
    expect(entryFlagsV11({ direction: 'BEARISH', netRiskReward: 1.2, positioningNet: 1 })).toEqual({ NET_RR_FLOOR_1: false, POSITIONING_OPPOSED: true });
    expect(entryFlagsV11({ direction: 'BULLISH', netRiskReward: null, positioningNet: null })).toEqual({ NET_RR_FLOOR_1: null, POSITIONING_OPPOSED: null });
    expect(entryFlagsV11({ direction: 'BULLISH', netRiskReward: 1, positioningNet: 0 }).POSITIONING_OPPOSED).toBe(false);
  });
  it('aggregates with the shared aggregator over its own rule list', () => {
    const a = aggregateEntryRules(
      [
        { netPct: -5, flags: { NET_RR_FLOOR_1: true, POSITIONING_OPPOSED: false } },
        { netPct: 3, flags: { NET_RR_FLOOR_1: false, POSITIONING_OPPOSED: null } },
      ],
      ENTRY_RULES_V11
    );
    expect(a.rules.NET_RR_FLOOR_1).toMatchObject({ measured: 2, skipped: 1, skippedNetPerTrade: -5, keptNetPerTrade: 3, improvementTotalNet: 5 });
    expect(a.rules.POSITIONING_OPPOSED).toMatchObject({ measured: 1, skipped: 0 });
  });
});

describe('evaluation core: statistics', () => {
  it('cluster bootstrap is reproducible and brackets the mean', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const c = ['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c'];
    const s1 = clusterBootstrapMean(v, c);
    const s2 = clusterBootstrapMean(v, c);
    expect(s1).toEqual(s2);
    expect(s1.mean).toBe(5);
    expect(s1.lo!).toBeLessThanOrEqual(5);
    expect(s1.hi!).toBeGreaterThanOrEqual(5);
    expect(s1.clusters).toBe(3);
  });
  it('fewer than 3 days gives a mean but no interval', () => {
    expect(clusterBootstrapMean([1, 2], ['a', 'b'])).toMatchObject({ mean: 1.5, lo: null, hi: null });
  });
  it('a difference resamples days jointly', () => {
    const a = ['d1', 'd2', 'd3', 'd4'].flatMap((d) => [{ v: -1, c: d }, { v: -1.2, c: d }]);
    const b = ['d1', 'd2', 'd3', 'd4'].flatMap((d) => [{ v: 0.5, c: d }, { v: 0.7, c: d }]);
    const d = clusterBootstrapDiff(a, b);
    expect(d.diff).toBeCloseTo(-1.7, 4);
    expect(d.hi!).toBeLessThan(0);
  });
  it('spearman: monotone = 1, reversed = -1, constant = null', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 6);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    const byDay = spearmanByDay([1, 2, 3, 4, 5, 6], [2, 4, 6, 8, 10, 12], ['a', 'a', 'b', 'b', 'c', 'c']);
    expect(byDay.rho).toBeCloseTo(1, 6);
  });
});

describe('evaluation core: scorecard', () => {
  const rows = (strategy: string, n: number, netR: (i: number) => number, days = 25): ScoreRow[] =>
    Array.from({ length: n }, (_, i) => ({ strategy, day: `2026-10-${String(1 + (i % days)).padStart(2, '0')}`, netR: netR(i), grossR: netR(i) + 0.08, state: netR(i) > 0 ? 'WIN' : 'LOSS' }));
  it('strategy keys come from the source, else the label', () => {
    expect(strategyKeyOf('A3', 'Paper research · A3')).toBe('A3');
    expect(strategyKeyOf(null, 'Indicator · OLD')).toBe('INDICATOR');
    expect(strategyKeyOf(null, 'Structure · NEW')).toBe('S1');
    expect(strategyKeyOf(null, 'Paper research · F3')).toBe('F3');
  });
  it('the Old Indicator is PROTECTED however it performs', () => {
    const s = scorecard(rows('INDICATOR', 200, () => -0.5));
    expect(s[0].action).toBe('PROTECTED_BENCHMARK');
  });
  it('a clearly negative strategy with enough trades is a demotion candidate', () => {
    const s = scorecard(rows('A4', 60, (i) => (i % 3 === 0 ? 0.2 : -0.6)));
    expect(s[0].action).toBe('DEMOTE_CANDIDATE');
    expect(s[0].netR.hi!).toBeLessThan(0);
  });
  it('a small sample is never demoted or promoted', () => {
    const s = scorecard(rows('B1', 12, () => -1));
    expect(s[0].action).toBe('KEEP_MEASURING');
  });
  it('promotion needs size, days, a corrected lower bound above 0 and both halves positive', () => {
    const good = scorecard(rows('X1', 150, (i) => (i % 4 === 0 ? -0.5 : 0.6)));
    expect(good[0].action).toBe('PROMOTE_ELIGIBLE');
    const fewDays = scorecard(rows('X2', 150, (i) => (i % 4 === 0 ? -0.5 : 0.6), 10));
    expect(fewDays[0].action).toBe('KEEP_MEASURING');
  });
  it('reports both win rates and the average net win and loss', () => {
    const s = scorecard([
      { strategy: 'Y', day: '2026-10-01', netR: 0.3, grossR: 0.4, state: 'WIN' },
      { strategy: 'Y', day: '2026-10-02', netR: -1.1, grossR: -1, state: 'LOSS' },
      { strategy: 'Y', day: '2026-10-03', netR: -0.3, grossR: -0.2, state: 'EXPIRED' },
    ])[0];
    expect(s.winRateClosedOnly).toBe(50);
    expect(s.winRateAllTrades).toBeCloseTo(33.3333, 3);
    expect(s.avgNetWin).toBe(0.3);
    expect(s.avgNetLoss).toBe(-1.1);
  });
});

describe('evaluation core: signal quality and gates', () => {
  const day = '2026-10-06';
  const base = (i: number, over: Partial<DecisionPoint> = {}): DecisionPoint => ({
    symbol: 'NIFTY', exchange: 'NSE', t: ist(`${day}T10:00:00`) + i * 15 * 60_000, day, px: 100 + i, atr: 2, sign: 1, confidence: 80, votes: { futuresOi: 95 }, decision: 'TAKE', outcomeR: null, ...over,
  });
  it('forward moves are signed by the call, in ATR, same symbol and day only', () => {
    const pts = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => base(i));
    const m = forwardMoves(pts);
    // +60 min = 4 bars later, price +4, ATR 2 → +2 ATR for a bullish call.
    expect(m[0].byHorizon[60]).toBe(2);
    const bear = forwardMoves(pts.map((p) => ({ ...p, sign: -1 as const })));
    expect(bear[0].byHorizon[60]).toBe(-2);
    // The last point has no later observation.
    expect(m[8].byHorizon[30]).toBeNull();
  });
  it('a different day never counts as the forward observation', () => {
    const a = base(0);
    const b = { ...base(4), day: '2026-10-07', t: ist('2026-10-07T10:00:00') };
    expect(forwardMoves([a, b])[0].byHorizon[60]).toBeNull();
  });
  it('signal quality reports horizons, a baseline and dimension correlations', () => {
    const pts = ['2026-10-06', '2026-10-07', '2026-10-08'].flatMap((d) =>
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ ...base(i), day: d, t: ist(`${d}T10:00:00`) + i * 15 * 60_000 }))
    );
    const q = signalQuality(pts);
    expect(q.days).toBe(3);
    expect(q.horizons.map((h) => h.minutes)).toEqual([...EVIDENCE_RULES.HORIZONS_MIN]);
    expect(q.horizons[1].hitRate).toBe(100);
    expect(q.dimensions.map((d) => d.dimension)).toEqual(['futuresOi']);
  });
  it('gate validation compares what a gate refused with what was taken', () => {
    const pts: DecisionPoint[] = [];
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07']) {
      for (let i = 0; i < 10; i++) {
        pts.push({ ...base(i), day: d, decision: 'TAKE', outcomeR: 0.3 });
        pts.push({ ...base(i), day: d, decision: 'BAD_GATE', outcomeR: -0.8 });
        pts.push({ ...base(i), day: d, decision: 'NOISE_GATE', outcomeR: 0.3 });
      }
    }
    const g = gateValidation(pts);
    const bad = g.gates.find((x) => x.code === 'BAD_GATE')!;
    expect(bad.verdict).toBe('FILTERS_WORSE');
    const noise = g.gates.find((x) => x.code === 'NOISE_GATE')!;
    expect(noise.verdict).toBe('REFUSES_NO_WORSE');
    expect(bad.tooFewDays).toBe(false);
  });
  it('never judges a gate whose refusals fall on fewer than MIN_DAYS_GATE days (RISK_OFF: 61 refusals, one day)', () => {
    const pts: DecisionPoint[] = [];
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07', '2026-10-08'];
    days.forEach((d, k) => {
      for (let i = 0; i < 10; i++) pts.push({ ...base(i), day: d, decision: 'TAKE', outcomeR: 0.1 + (k % 3) * 0.1 });
    });
    for (let i = 0; i < 61; i++) pts.push({ ...base(i), day: '2026-10-07', decision: 'ONE_DAY_GATE', outcomeR: -0.9 });
    const g = gateValidation(pts);
    const one = g.gates.find((x) => x.code === 'ONE_DAY_GATE')!;
    expect(one.refused.clusters).toBe(1);
    expect(one.tooFewDays).toBe(true);
    expect(one.verdict).toBe('INCONCLUSIVE');
    expect(EVIDENCE_RULES.MIN_DAYS_GATE).toBe(5);
  });
});

describe('evaluation core: portfolio-limits replay', () => {
  const t0 = ist('2026-10-06T10:00:00');
  const trade = (i: number, over: Partial<ReplayTrade> = {}): ReplayTrade => ({
    id: `t${i}`, mintedAt: t0 + i * 60_000, exitAt: t0 + 4 * 3_600_000, symbol: `S${i}`, direction: 'BULLISH', netR: -0.2, outcome: 'EXPIRED', day: '2026-10-06', ...over,
  });
  it('book stats count concurrency and drawdown', () => {
    const s = bookStats([trade(0), trade(1), trade(2, { direction: 'BEARISH' })]);
    expect(s.maxOpen).toBe(3);
    expect(s.maxSameDirection).toBe(2);
    expect(s.totalNetR).toBeCloseTo(-0.6, 6);
    expect(s.maxDrawdownR).toBeCloseTo(0.6, 6);
  });
  it('a same-direction cap skips the excess and says why', () => {
    const r = replayCaps([trade(0), trade(1), trade(2), trade(3), trade(4, { direction: 'BEARISH' })], { maxOpenPositions: null, maxSameDirection: 3, maxDailyLossR: null, maxTradesPerDay: null, maxConsecutiveStops: null });
    expect(r.stats.trades).toBe(4);
    expect(r.skipped).toEqual({ MAX_SAME_DIRECTION: 1 });
  });
  it('a daily loss stop only counts losses already closed when the next trade is minted', () => {
    const closed = (i: number) => trade(i, { exitAt: t0 + i * 60_000 + 30_000, netR: -1.5, outcome: 'LOSS' });
    const r = replayCaps([closed(0), closed(1), trade(2), trade(3)], { maxOpenPositions: null, maxSameDirection: null, maxDailyLossR: 3, maxTradesPerDay: null, maxConsecutiveStops: null });
    expect(r.skipped).toEqual({ DAILY_LOSS_LIMIT: 2 });
  });
});

describe('bar archive (research only)', () => {
  it('archives only while no exchange trades', () => {
    expect(archiveWindowOpen(0, () => false)).toBe(true);
    expect(archiveWindowOpen(0, (e) => e === 'MCX')).toBe(false);
  });
  it('lists sessions that are over, never one still trading or a weekend', () => {
    const tuesdayNight = ist('2026-10-13T23:50:00');
    expect(archivableDates('NSE', tuesdayNight, 2)).toEqual(['2026-10-12', '2026-10-13']);
    expect(archivableDates('NSE', ist('2026-10-13T12:00:00'), 0)).toEqual([]);
    expect(archivableDates('NSE', ist('2026-10-12T08:00:00'), 3)).toEqual(['2026-10-09']);
  });
  it('keeps only the date’s well-formed bars', () => {
    const rows = archiveRowsOf('NIFTY', 'NSE', '15m', '99926000', '2026-10-13', [
      { timestamp: '2026-10-13T09:15:00+05:30', open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: '2026-10-12T15:15:00+05:30', open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: '2026-10-13T09:30:00+05:30', open: 100, high: 98, low: 99, close: 101, volume: 10 },
      { timestamp: '2026-10-13T09:45:00+05:30', open: NaN, high: 102, low: 99, close: 101, volume: 10 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'NIFTY', interval: '15m', open: 100, close: 101 });
  });
  it('always archives the main indices and MCX benchmarks', () => {
    expect(ALWAYS_ARCHIVED.map((s) => s.symbol)).toEqual(expect.arrayContaining(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD']));
  });
  it('the migration is idempotent and keyed by symbol, exchange, interval and bar time', () => {
    const sqlText = readFileSync(path.resolve(HERE, '../../../../../database/init/041_bar_archive.sql'), 'utf-8');
    expect(sqlText).toMatch(/CREATE TABLE IF NOT EXISTS bar_archive/);
    expect(sqlText).toMatch(/PRIMARY KEY \(symbol, exchange, interval, bar_time\)/);
    expect(sqlText).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });
  it('nothing in the decision path imports the evaluation or archive modules', () => {
    for (const f of ['../market-bias.ts', '../trigger-router.ts', '../slot-arbitration.ts', '../trade-setup-monitor.ts']) {
      const src = readFileSync(path.resolve(HERE, f), 'utf-8');
      expect(src).not.toMatch(/evaluation-core|evaluation-reports|bar-archive/);
    }
  });
});
