// ============================================================
// OB1 / OF1 PAPER CANDIDATES (user decision 2026-10-09)
// ============================================================
// OB-2.0 and OF1 hand the slot ordinary trigger candidates, built by the
// event engine's own buildCandidate and qualified by the router's own risk
// / cost checks, then join the trigger families' pool — the existing chain
// and slot arbitration decide. They never enter the indicator engine.
// Real bars from the frozen fixture; OF1 inputs FABRICATED.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' }, scanKeys: async () => [] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const A = await import('@fno/analytics');
const { orderFlowPaperCandidates } = await import('../order-flow-candidates.js');
const { validateCandidateRisk } = await import('../trigger-router.js');
const { sourceOfSetup } = await import('../backtesting.js');
const flags = await import('../../config/order-flow-flags.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(path.join(HERE, 'fixtures/regression-bars.json'), 'utf8')).series as Record<string, number[][]>;
const nifty = FIX.NIFTY.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

/** The first bar where the OB-2.0 signal fires on the newest bar of the session (bars cut there). */
function firstObSignalCut() {
  for (let i = 40; i < nifty.length; i++) {
    const cut = nifty.slice(0, i + 1);
    const series = A.prepareMomentumSeries(cut);
    const ctx = A.buildSeriesContext(series);
    if (ctx.sessionEnd(series.sessionStarts.length - 1) !== i) continue;
    const sig = A.orderBlockSignalAt(cut, i);
    if (sig) return { cut, i, sig, ctx, series };
  }
  throw new Error('no OB-2.0 signal in the fixture');
}

describe('OB1: the OB-2.0 signal as an ordinary trigger candidate', () => {
  const { cut, i, sig, ctx, series } = firstObSignalCut();
  const [rc, ...rest] = orderFlowPaperCandidates({ underlying: 'NIFTY', exchange: 'NSE', bars: cut, chain: null, footprints: new Map(), ob1: true, of1: false });

  it('one candidate, PAPER_RESEARCH, parent = its block, entry = the decision bar close', () => {
    expect(rest).toHaveLength(0);
    expect(rc.stage).toBe('PAPER_RESEARCH');
    expect(rc.candidate).toMatchObject({ triggerId: 'OB1', direction: sig.block.type, decisionIndex: i, entry: Math.round(cut[i].close * 100) / 100, eventIds: [] });
    expect(rc.parentId).toBe(`OB1:NSE:NIFTY:${cut[sig.block.blockIndex].time}:${sig.block.type}`);
    expect(rc.anchorKeys).toEqual([rc.parentId]);
    expect(rc.lifecycleId).toBe(`NSE:NIFTY:MP:OB1:${sig.block.type}:${cut[i].time}`);
  });

  it('stop, T1 / T2, R:R bucket, timing and move potential come from the event engine\'s own buildCandidate', () => {
    const log = A.runSessionEvents(ctx, series.sessionStarts.length - 1);
    const stopRef = sig.block.type === 'BULLISH' ? sig.block.bottom : sig.block.top;
    const level = sig.block.type === 'BULLISH' ? sig.block.top : sig.block.bottom;
    const t = cut[sig.block.blockIndex].time;
    const same = A.buildCandidate(ctx, log, { triggerId: 'OB1', family: 'ORDER_BLOCK' } as any, { direction: sig.block.type, anchor: { id: `ORDER_BLOCK:${sig.block.type}:${t}`, type: 'RECLAIM', barIndex: sig.block.blockIndex, time: t, availableAt: t + 15 * 60_000, direction: sig.block.type, price: level } as any, events: [], stopRef } as any, i);
    expect(rc.candidate).toEqual(same);
    const buf = 0.1 * ctx.atrAt(i)!;
    expect(rc.candidate.stop).toBeCloseTo(sig.block.type === 'BULLISH' ? stopRef - buf : stopRef + buf, 1);
  });

  it('qualified by the router\'s own risk check (no chain → cost not measured)', () => {
    expect(rc.cost).toBeNull();
    expect(rc.risk).toEqual(validateCandidateRisk(rc.candidate, { sessionOk: rc.risk.sessionOk, costPct: null, maxCostPct: 5 }));
  });

  it('switched off, it produces nothing', () => {
    expect(orderFlowPaperCandidates({ underlying: 'NIFTY', exchange: 'NSE', bars: cut, chain: null, footprints: new Map(), ob1: false, of1: false })).toEqual([]);
  });
});

// ---------------- OF1 ----------------
const M15 = 15 * 60_000;
const D1 = Date.parse('2026-10-06T09:15:00+05:30');
const D2 = Date.parse('2026-10-07T09:15:00+05:30');
function of1Bars() {
  const bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (let k = 0; k < 25; k++) bars.push(k === 10 ? { time: D1 + k * M15, open: 101, high: 101, low: 95, close: 100, volume: 0 } : k % 2 ? { time: D1 + k * M15, open: 101, high: 104, low: 99, close: 102, volume: 0 } : { time: D1 + k * M15, open: 102, high: 104, low: 99, close: 101, volume: 0 });
  for (let k = 0; k < 6; k++) bars.push(k % 2 ? { time: D2 + k * M15, open: 103, high: 104, low: 99, close: 102, volume: 0 } : { time: D2 + k * M15, open: 102, high: 104, low: 99, close: 103, volume: 0 });
  bars.push({ time: D2 + 6 * M15, open: 100, high: 101, low: 94.5, close: 100.5, volume: 0 });
  return bars;
}

describe('OF1: each OF1 candidate as an ordinary trigger candidate', () => {
  const bars = of1Bars();
  const t = bars[bars.length - 1].time;
  const fp = A.buildFootprint([95, 96, 97, 98, 99, 100].flatMap((p, k) => [{ time: t + 10 + k, price: p, qty: 300, side: 'BUY' as const }, { time: t + 20 + k, price: p, qty: 50, side: 'SELL' as const }]), t, M15, 1, 'INFERRED');
  const fps = new Map([[t, fp]]);
  it('routed with the stop beyond the bar / level and its own parent', () => {
    const out = orderFlowPaperCandidates({ underlying: 'NIFTY', exchange: 'NSE', bars, chain: null, footprints: fps, ob1: false, of1: true });
    const of1 = out.filter((r) => r.candidate.triggerId === 'OF1');
    expect(of1).toHaveLength(1);
    expect(of1[0].stage).toBe('PAPER_RESEARCH');
    expect(of1[0].candidate).toMatchObject({ direction: 'BULLISH', entry: 100.5, anchorPrice: 95 });
    expect(of1[0].candidate.stop).toBeLessThan(94.5);
    expect(of1[0].parentId).toBe('OF1:NSE:NIFTY:2026-10-07:BULLISH:PDL:95');
  });
  it('no order-flow data → no OF1 candidate', () => {
    expect(orderFlowPaperCandidates({ underlying: 'NIFTY', exchange: 'NSE', bars, chain: null, footprints: new Map(), ob1: false, of1: true })).toEqual([]);
  });
});

describe('wiring and tagging', () => {
  const mb = readFileSync(path.join(HERE, '../market-bias.ts'), 'utf8');
  it('OB1 / OF1 join the trigger families\' pool (MULTIPATH) on a newly evaluated bar — never the indicator vote', () => {
    expect(mb).toMatch(/const familyPaper = routed \? \[\.\.\.routed\.paper, \.\.\.orderFlowPaper\] : \[\];/);
    expect(mb).toMatch(/family: 'MULTIPATH' as const, state: structureState, candidates: familyPaper,/);
    expect(mb).toMatch(/routed && routed\.evaluated > 0 && closedNow\.length > 0/);
    expect(mb).toMatch(/const orderBlocks = detectOrderBlocksLegacy\(c15\.highs, c15\.lows, c15\.closes\);/);
  });
  it('each trade carries its source and version; the backtest splits them out', () => {
    expect(flags.ORDER_FLOW_SOURCE_VERSIONS).toEqual({ OB1: 'OB-2.0', OF1: 'OF1-1.0' });
    expect(mb).toMatch(/sourceVersion: ORDER_FLOW_SOURCE_VERSIONS\[ctx\.structure\.triggerId \?\? ''\] \?\? null/);
    expect(sourceOfSetup({ strategy: 'STRUCTURE', source: 'OB1' })).toBe('OB1');
    expect(sourceOfSetup({ strategy: 'STRUCTURE', logicVersion: 'x+paper-research.OF1' })).toBe('OF1');
  });
});
