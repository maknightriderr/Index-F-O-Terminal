import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpCandidate } from '../experiment-arms.js';
import { ENTRY_CONFIRMATION_VERSION as version, type EntryEvidence } from '../entry-confirmation-rules.js';

const m = vi.hoisted(() => ({ queries: [] as Array<{ text: string; values: any[] }>, loadRows: [] as any[], failObservation: false, persistenceGate: null as Promise<void> | null }));
vi.mock('../../lib/db.js', () => {
  const sql: any = async (s: TemplateStringsArray, ...values: any[]) => {
    const text = s.join('?');
    if (text.includes("'OBSERVE'") && m.failObservation) { m.failObservation = false; throw new Error('temporary write failure'); }
    m.queries.push({ text, values: structuredClone(values) });
    if (text.includes('INSERT INTO experiment_positions') && m.persistenceGate) await m.persistenceGate;
    return text.includes("WHERE official_status = 'OPEN'") ? m.loadRows : [];
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
const E = await import('../experiment-engine.js');
const t = Date.parse('2026-10-26T10:00:00+05:30');
const e = (close = 102): EntryEvidence => ({ version, source: 'OB1', sourceVersion: 'OB-2.0', direction: 'BULLISH', decisionTime: t - 900_000, blockTop: 101, blockBottom: 94, close });
const candidate = (id = 'ob1', evidence = e()): ExpCandidate => ({ at: t, candidateId: id, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', direction: 'BULLISH', confidence: 80, side: 'CE', strike: 24000, expiry: '2026-10-27', token: '1', lotSize: 50, entry: 100, stop: 80, target: 140, costPct: 2, statutoryPct: .2, brokeragePerLotInr: 40, minutesSinceOpen: 45, behindLevel: 94, atr: 10, decisionTime: t - 900_000, triggerId: evidence.source, entryEvidence: evidence, quote: { ltp: 100, bid: 99, ask: 101, bidQty: 500, askQty: 500, exchangeAt: t, receivedAt: t, feedState: null, source: 'CHAIN' } });
const chain = (price = 100, time = t) => ({ expiry: '2026-10-27', spotPrice: 24000, strikes: [{ strike: 24000, call: { token: '1', ltp: price, bid: price - 1, ask: price + 1, bidQty: 500, askQty: 500, timestamp: time, exchangeTimestamp: time } }] }) as any;
const poll = (id = 'ob1', evidence = e(), build = async () => candidate(id, evidence)) => ({ at: t, symbol: 'NIFTY', exchange: 'NSE' as const, mode: 'INTRADAY' as const, direction: 'NEUTRAL', confidence: 80, chain: chain(), confirmMs: 300_000, lastClosedBar: null, buildCandidate: async () => null, triggerCandidates: [{ source: evidence.source, candidateId: id, entryEvidence: evidence, build }] });
const observations = () => m.queries.filter((q) => q.text.includes("'OBSERVE'"));
beforeEach(() => { E.__resetExperimentEngine(); E.__startedForTest(); m.queries = []; m.loadRows = []; m.failObservation = false; m.persistenceGate = null; vi.stubEnv('ENTRY_CONFIRMATION_EXPERIMENTS', 'on'); vi.stubEnv('EXPERIMENT_NEW_ENTRIES', 'on'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('paired shadow arms, isolated and reproducible', () => {
  it('builds once, opens both matching arms, observes once and never duplicates the recurring candidate', async () => {
    const build = vi.fn(async () => candidate());
    await E.onIndicatorPoll(poll('ob1', e(), build));
    await E.onIndicatorPoll(poll('ob1', e(), build));
    expect(build).toHaveBeenCalledTimes(1);
    expect(E.__positions().map((p) => p.arm).sort()).toEqual(['OB1C', 'OB1J']);
    expect(observations()).toHaveLength(2);
    expect(E.__positions().every((p) => p.quantity === 50 && p.candidate.entry === 100)).toBe(true);
    expect(m.queries.every((q) => !/INSERT INTO (signals|trades|slot_decisions)/.test(q.text))).toBe(true);
  });
  it('captures weak-retest rejection while control opens, including observations when slots are held', async () => {
    await E.onIndicatorPoll(poll('weak', e(100)));
    expect(E.__positions().map((p) => p.arm)).toEqual(['OB1C']);
    expect(observations().some((q) => q.values.includes('OB_REJECTION_NOT_CONFIRMED'))).toBe(true);
    await E.onIndicatorPoll(poll('strong', e(102)));
    expect(E.__positions().find((p) => p.arm === 'OB1J')?.candidate.candidateId).toBe('strong');
    const build = vi.fn(async () => candidate('third'));
    await E.onIndicatorPoll(poll('third', e(), build));
    expect(build).not.toHaveBeenCalled();
    expect(observations()).toHaveLength(6); // all three candidate pairs, even when both slots are held
  });
  it('records a refusal to build without inventing a position or outcome', async () => {
    await E.onIndicatorPoll({ ...poll(), triggerCandidates: [{ ...poll().triggerCandidates[0], build: async () => null }] });
    expect(observations()).toHaveLength(2);
    expect(E.__positions()).toEqual([]);
    expect(m.queries.filter((q) => q.values.includes('NOT_BUILT'))).toHaveLength(2);
  });
  it('OF1 pressure-only evidence is captured by both controls but filtered in OF1G', async () => {
    const evidence: EntryEvidence = { version, source: 'OF1', sourceVersion: 'OF1-1.2', direction: 'BULLISH', decisionTime: t - 900_000, alignment: 'ALIGNED', flowBasis: 'INFERRED', found: ['DELTA', 'IMBALANCE'] };
    await E.onIndicatorPoll(poll('of1', evidence));
    expect(E.__positions().map((p) => p.arm).sort()).toEqual(['OF1C', 'OF1R']);
    expect(observations().some((q) => q.values.includes('OF_FLOW_GROUP_MISSING'))).toBe(true);
  });
  it('overlapping polls cannot mint the same candidate twice per arm', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const build = vi.fn(async () => { await gate; return candidate(); });
    const a = E.onIndicatorPoll(poll('ob1', e(), build));
    const b = E.onIndicatorPoll(poll('ob1', e(), build));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    release(); await Promise.all([a, b]);
    expect(E.__positions().map((p) => p.arm).sort()).toEqual(['OB1C', 'OB1J']);
  });
  it('an observation write failure is retried on the next poll', async () => {
    m.failObservation = true;
    await E.onIndicatorPoll(poll());
    expect(observations()).toHaveLength(1);
    await E.onIndicatorPoll(poll());
    expect(observations()).toHaveLength(2);
  });
  it('dedicated drain switch stops new arms while preserving exits and legacy OF1R entries', async () => {
    await E.onIndicatorPoll(poll());
    const held = [...E.__positions()];
    vi.stubEnv('ENTRY_CONFIRMATION_EXPERIMENTS', 'off');
    const build = vi.fn(async () => candidate('next'));
    await E.onIndicatorPoll({ ...poll('next', e(), build), at: t + 1000, chain: chain(145, t + 1000) });
    expect(build).not.toHaveBeenCalled();
    expect(E.__positions()).toHaveLength(0);
    expect(held.every((p) => p.official.status === 'CLOSED' && p.sim.status === 'CLOSED')).toBe(true);
    const evidence: EntryEvidence = { version, source: 'OF1', sourceVersion: 'OF1-1.2', direction: 'BULLISH', decisionTime: t - 900_000, alignment: 'ALIGNED', flowBasis: 'INFERRED', found: ['DELTA', 'ABSORPTION'] };
    await E.onIndicatorPoll(poll('old-of', evidence));
    expect(E.__positions().map((p) => p.arm)).toEqual(['OF1R']);
  });
  it('rechecks the dedicated stop switch after a build in flight', async () => {
    await E.onIndicatorPoll(poll('ob1', e(), async () => { vi.stubEnv('ENTRY_CONFIRMATION_EXPERIMENTS', 'off'); return candidate(); }));
    expect(E.__positions()).toEqual([]);
  });
  it('restores new arm readers and deduplication after restart', async () => {
    await E.onIndicatorPoll(poll());
    m.loadRows = E.__positions().map((state) => ({ state: structuredClone(state) }));
    E.__resetExperimentEngine();
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as any);
    try {
      E.startExperimentEngine();
      await vi.waitFor(() => expect(m.queries.filter((q) => q.text.includes('INSERT INTO experiment_arms'))).toHaveLength(11));
      const build = vi.fn(async () => candidate());
      await E.onIndicatorPoll(poll('ob1', e(), build));
      expect(E.__positions()).toHaveLength(2); expect(build).not.toHaveBeenCalled();
      await E.onIndicatorPoll({ ...poll(), at: t + 1000, chain: chain(145, t + 1000), triggerCandidates: [] });
      expect(E.__positions()).toHaveLength(0);
    } finally { timer.mockRestore(); }
  });
});

it('serializes immutable new-position snapshots so a slow OPEN write cannot overwrite CLOSED', async () => {
  let release!: () => void;
  m.persistenceGate = new Promise<void>((resolve) => { release = resolve; });
  await E.onIndicatorPoll(poll());
  await vi.waitFor(() => expect(m.queries.filter((q) => q.text.includes('INSERT INTO experiment_positions'))).toHaveLength(2));
  await E.onIndicatorPoll({ ...poll(), at: t + 1000, chain: chain(145, t + 1000), triggerCandidates: [] });
  const writesBeforeRelease = m.queries.filter((q) => q.text.includes('INSERT INTO experiment_positions'));
  expect(writesBeforeRelease).toHaveLength(2);
  expect(writesBeforeRelease.every((q) => q.values.some((v) => v?.official?.status === 'OPEN'))).toBe(true);
  release(); m.persistenceGate = null;
  await vi.waitFor(() => expect(m.queries.filter((q) => q.text.includes('INSERT INTO experiment_positions'))).toHaveLength(4));
  const last = m.queries.filter((q) => q.text.includes('INSERT INTO experiment_positions')).slice(-2);
  expect(last.every((q) => q.values.some((v) => v?.official?.status === 'CLOSED'))).toBe(true);
});
