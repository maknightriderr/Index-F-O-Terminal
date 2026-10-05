// ============================================================
// PHASE 8 — the DecisionRecord research view.
//   /api/diagnostics/decision/:snapshotId: snapshot summary, per-input data
//   quality, market state, events, candidates (parentId), common metrics,
//   option candidates (+ rejected), arbitration (+ losing criterion), final
//   status, outcome, every version field; ?replay=1 compares offline.
// ============================================================

import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { MomentumBar } from '@fno/analytics';

vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, mget: async () => [] }, scanKeys: async () => [] }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));

// The stored rows this decision produced, returned by query shape.
const ARB = [
  { lifecycle_id: 'L-A2', trigger_type: 'A2', direction: 'BEARISH', time: new Date(), rejection_reason: null, a: { parentId: 'P:1', role: 'SELECTED', rank: 1, preBuildRank: 1, slotDecision: { slot: 'FREE', decision: 'MINTED', heldSignalId: null }, criteriaUsed: ['timing'] } },
  { lifecycle_id: 'L-B1', trigger_type: 'B1', direction: 'BEARISH', time: new Date(), rejection_reason: 'Not selected: A2 ranked higher on entry timing for this symbol\'s one paper-trade slot.', a: { parentId: 'P:2', role: 'ALTERNATIVE', rank: 2, preBuildRank: 2, refusalCode: 'NOT_SELECTED', slotDecision: { slot: 'FREE', decision: 'NOT_SELECTED', heldSignalId: null } } },
];
const OUTCOMES = [{ lifecycle_id: 'L-A2', event_type: 'TRADED', trigger_type: 'A2', direction: 'BEARISH', decision: 'TRADED', result_r: '1.25', mfe_r: '1.9', mae_r: '-0.3', exit_reason: 'TARGET', graded_at: new Date('2026-08-10T12:00:00Z') }];
const PLANS = [{ plan_id: 'pl', signal_id: 'sig', source: 'A2', candidate_id: 'L-A2', option_side: 'PE', option_strike: '95', option_expiry: '2026-08-13', option_entry: '120', option_sl: '90', option_tsl: '90', option_t1: '160', option_t2: null, underlying_entry: '95', underlying_stop: '101', underlying_t1: '90', underlying_t2: null, selected_strike: '95', candidates: [{ strike: 95, status: 'SELECTED' }, { strike: 100, status: 'REJECTED', rejectedAt: 'SPREAD', rejectionReason: 'wide' }], option_selection_version: 'OPTSEL-1.0' }];
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes("event_type = 'ARBITRATION'")) return Promise.resolve(ARB);
    if (q.includes("event_type <> 'ARBITRATION'")) return Promise.resolve(OUTCOMES);
    if (q.includes('FROM option_plans')) return Promise.resolve(PLANS);
    return Promise.resolve([]);
  };
  sql.json = (v: unknown) => v;
  return { sql };
});

const dr = await import('../decision-record.js');
const { EMPTY_FAMILY_ROUTER_STATE, liveTriggerStages } = await import('../trigger-router.js');

// The Phase 2 fixture session (families fire on the newest bar).
const M15 = 15 * 60 * 1000;
const ist = (s: string) => Date.parse(`${s}+05:30`);
const session = (date: string, p: Array<[number, number, number, number]>): MomentumBar[] => p.map(([open, high, low, close], k) => ({ time: ist(`${date}T09:15:00`) + k * M15, open, high, low, close, volume: 0 }));
const quiet = (date: string) => session(date, Array.from({ length: 25 }, (_, k) => {
  const o = 100 + ((k % 4) - 1.5) * 2;
  const c = 100 + (((k + 1) % 4) - 1.5) * 2;
  return [o, Math.max(o, c) + 4, Math.min(o, c) - 4, c] as [number, number, number, number];
}));
const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));
const bars = [...days.flatMap(quiet), ...session('2026-08-10', [[100, 104, 96, 102], [102, 106, 99, 104], [104, 107, 101, 105], [105, 112, 103, 104], [104, 105, 100, 101], [101, 103, 98, 102], [102, 104, 99, 100], [100, 101, 94, 95]])];
const T = ist('2026-08-10T11:15:00');
const snap = dr.buildSignalDecisionSnapshot({
  symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', decisionBarTime: T, polledAt: T + 180_000, captureReason: 'NEW_BAR', bars15m: bars, bars5m: null, closes1h: [100], last1hBarTime: T - 60 * 60_000,
  chain: null, futures: null, optionMetrics: { pcr: null, atmIvPct: null, hvPct: null, ivVsHv: null }, marketRegime: { regime: 'RANGING', source: '1H' },
  structureState: { prev: null, outcomes: {} }, familyRouterState: EMPTY_FAMILY_ROUTER_STATE, slotTradedKeys: [],
  config: dr.decisionConfig({ triggerStages: liveTriggerStages(), structureOn: true, structureEntryTimeframe: '15m', structureEntryMode: 'TOUCH' }),
  versions: dr.currentVersions(), sources: { candles: 'test:candles', chain: 'test:chain', futures: 'test:futures' },
});
const record = dr.deriveDecisionRecord(snap, 1);

vi.mock('../decision-record-store.js', () => ({
  loadSnapshot: async (id: string) => (id === snap.snapshotId ? snap : null),
  loadDecisionRecord: async (id: string) => (id === snap.snapshotId ? { record, hash: dr.recordHash(record), outcome: { resultR: 1.25 }, outcomeAt: null } : null),
  replay: async () => ({ status: 'MATCH', snapshotId: snap.snapshotId, hash: dr.recordHash(record), storedHash: dr.recordHash(record), diff: [], record }),
}));

const { summarizeSnapshot, decisionDiagnostics } = await import('../decision-diagnostics.js');
const { createDiagnosticsRoutes } = await import('../../api/diagnostics.js');

describe('decision research view', () => {
  it('summarises the input snapshot without its bulky inputs, with data quality and every version', () => {
    const s = summarizeSnapshot(snap);
    expect(s.inputs.ohlcv15m.bars).toBe(bars.length);
    expect(s.inputs.optionChain).toBeNull();
    expect(s.inputs.marketRegime).toEqual({ regime: 'RANGING', source: '1H' });
    expect(s.dataQuality.inputs.optionChain.status).toBe('MISSING');
    for (const k of ['gitCommit', 'analyticsVersion', 'signalEngineVersion', 'optionModelVersion', 'parentingVersion', 'arbitrationVersion', 'ruleVersion', 'strategyVersion', 'costModelVersion', 'snapshotSchemaVersion']) expect(s.versions).toHaveProperty(k);
    expect(JSON.stringify(s).length).toBeLessThan(20_000);
  });

  it('assembles the decision: record (events, candidates + parents, metrics, option candidates, final status), plans with rejected strikes, the slot rows with losing criterion, graded outcome', async () => {
    const v = (await decisionDiagnostics(snap.snapshotId))!;
    expect(v.record!.families.events.length).toBeGreaterThan(0);
    expect(v.record!.candidates.every((c) => c.parentId)).toBe(true);
    expect(v.record!.metrics.length).toBeGreaterThan(0);
    expect(v.record!.finalStatus).toBe('CANDIDATES_TO_SLOT');
    expect(v.optionPlans[0].candidates).toContainEqual(expect.objectContaining({ status: 'REJECTED', rejectedAt: 'SPREAD' }));
    expect(v.optionPlans[0].option).toMatchObject({ strike: 95, entry: 120, sl: 90 });
    expect(v.arbitration.find((a) => a.candidateId === 'L-B1')!.reason).toMatch(/ranked higher on entry timing/);
    expect(v.arbitration.map((a) => a.slotDecision?.decision)).toEqual(['MINTED', 'NOT_SELECTED']);
    expect(v.outcomes[0]).toMatchObject({ resultR: 1.25, exitReason: 'TARGET' });
    expect(v.storedOutcome).toEqual({ resultR: 1.25 });
    expect(v.replay).toBeNull();
    expect((await decisionDiagnostics(snap.snapshotId, { replay: true }))!.replay).toEqual({ status: 'MATCH', diff: [], hash: dr.recordHash(record) });
    expect(await decisionDiagnostics('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('GET /api/diagnostics/decision/:snapshotId', () => {
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use('/api/diagnostics', createDiagnosticsRoutes());
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return () => server.close();
  });
  it('400 on a malformed id, 404 on an unknown one, 200 with the view (and replay on request)', async () => {
    expect((await fetch(`${base}/api/diagnostics/decision/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${base}/api/diagnostics/decision/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    const ok = await fetch(`${base}/api/diagnostics/decision/${snap.snapshotId}?replay=1`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.snapshot.snapshotId).toBe(snap.snapshotId);
    expect(body.data.replay.status).toBe('MATCH');
  });
});
