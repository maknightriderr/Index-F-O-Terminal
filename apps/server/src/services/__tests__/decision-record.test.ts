// ============================================================
// PHASE 2 — immutable input snapshot, DecisionRecord, offline replay.
//   (a) replay equals the stored decision under canonicalization
//   (b) any difference outside NONDETERMINISTIC_RECORD_FIELDS fails
//   (c) any IO / clock access during replay fails
//   (d) ageMs recomputes from asOf + decisionBarTime
// plus: frozen snapshot, config-mismatch refusal, data-quality statuses,
// degraded marking, live router ≡ record, T on the exchange calendar.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MomentumBar } from '@fno/analytics';
import { NONDETERMINISTIC_RECORD_FIELDS, ageMsOf, decisionBarCloseAt, inputStatusOf, type DecisionRecord, type OptionChain } from '@fno/shared';

// ---- IO guard: every Redis / SQL / network access is counted; while armed it throws ----
const io = { armed: false, calls: [] as string[] };
const touch = (what: string) => {
  io.calls.push(what);
  if (io.armed) throw new Error(`IO during replay: ${what}`);
};
const store = new Map<string, string>();
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: async (k: string) => (touch(`redis.get ${k}`), store.get(k) ?? null),
    mget: async (...ks: string[]) => (touch('redis.mget'), ks.map((k) => store.get(k) ?? null)),
    set: async (k: string, v: string, ...args: unknown[]) => {
      touch(`redis.set ${k}`);
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
  },
}));
vi.mock('../../lib/db.js', () => ({ sql: new Proxy(() => undefined, { apply: () => touch('sql'), get: (_t, p) => (p === 'json' ? (v: unknown) => v : () => touch(`sql.${String(p)}`)) }) }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
const recorded: any[] = [];
vi.mock('../setup-events.js', () => ({ recordSetupEvent: (e: any) => recorded.push(e) }));

const dr = await import('../decision-record.js');
const { routeTriggerFamilies, EMPTY_FAMILY_ROUTER_STATE, liveTriggerStages } = await import('../trigger-router.js');
const { ANALYTICS_VERSION } = await import('../../config/trading-flags.js');

// ---- fixture: the router-live session (A2 and friends fire on the newest bar) ----
const M15 = 15 * 60 * 1000;
const ist = (s: string) => Date.parse(`${s}+05:30`);
const session = (date: string, p: Array<[number, number, number, number]>): MomentumBar[] =>
  p.map(([open, high, low, close], k) => ({ time: ist(`${date}T09:15:00`) + k * M15, open, high, low, close, volume: 0 }));
const quiet = (date: string) =>
  session(
    date,
    Array.from({ length: 25 }, (_, k) => {
      const o = 100 + ((k % 4) - 1.5) * 2;
      const c = 100 + (((k + 1) % 4) - 1.5) * 2;
      return [o, Math.max(o, c) + 4, Math.min(o, c) - 4, c] as [number, number, number, number];
    })
  );
const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));
const today = session('2026-08-10', [
  [100, 104, 96, 102],
  [102, 106, 99, 104],
  [104, 107, 101, 105],
  [105, 112, 103, 104],
  [104, 105, 100, 101],
  [101, 103, 98, 102],
  [102, 104, 99, 100],
  [100, 101, 94, 95],
]);
const bars = [...days.flatMap(quiet), ...today];
const POLL = ist('2026-08-10T11:18:00');
const T = ist('2026-08-10T11:15:00');

const leg = (ltp: number, delta: number) => ({ token: 't', ltp, bid: ltp - 0.05, ask: ltp + 0.05, volume: 1000, oi: 5000, changeOi: 0, changePercent: 0, iv: 14, delta, gamma: 0.01, theta: -1, vega: 1, oiInterpretation: 'NEUTRAL' });
const chainAt = (timestamp: number): OptionChain =>
  ({
    symbol: 'NIFTY', underlying: 'NIFTY', exchange: 'NSE', spotPrice: 95, expiry: '2026-08-13', availableExpiries: ['2026-08-13'], dte: 3, strikeInterval: 5, atmStrike: 95, lotSize: 75,
    strikes: [90, 95, 100].map((k) => ({ strike: k, distanceFromSpot: k - 95, call: leg(120 + (95 - k), 0.5), put: leg(120 + (k - 95), -0.5) })),
    timestamp,
  }) as unknown as OptionChain;

const stages = liveTriggerStages();
const build = (o: Partial<Parameters<typeof dr.buildSignalDecisionSnapshot>[0]> = {}) =>
  dr.buildSignalDecisionSnapshot({
    symbol: 'NIFTY',
    exchange: 'NSE',
    mode: 'INTRADAY',
    decisionBarTime: T,
    polledAt: POLL,
    captureReason: 'NEW_BAR',
    bars15m: bars,
    bars5m: null,
    closes1h: [100, 101, 99],
    last1hBarTime: ist('2026-08-10T10:15:00'),
    chain: chainAt(T - 30_000),
    futures: { contracts: [], timestamp: T - 30_000 } as any,
    optionMetrics: { pcr: 1, atmIvPct: 14, hvPct: 12, ivVsHv: 'FAIR' },
    marketRegime: { regime: 'RANGING', source: '1H' },
    structureState: { prev: null, outcomes: {} },
    familyRouterState: EMPTY_FAMILY_ROUTER_STATE,
    slotTradedKeys: [],
    config: dr.decisionConfig({ triggerStages: stages, structureOn: true, structureEntryTimeframe: '15m', structureEntryMode: 'TOUCH' }),
    versions: dr.currentVersions(),
    sources: { candles: 'test:candles', chain: 'test:chain', futures: 'test:futures' },
    ...o,
  });

/** What the database does to a stored row: JSON in, JSON out. */
const viaDatabase = (snap: ReturnType<typeof build>) => dr.thawSnapshotRow(JSON.parse(JSON.stringify(dr.freezeSnapshotRow(snap))));
const storedForm = (r: DecisionRecord): DecisionRecord => JSON.parse(dr.canonicalJson(r));

/** Runs fn with every IO path and the clock armed to throw. */
function offline<T>(fn: () => T): T {
  const RealDate = Date;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('clock read during replay: Date.now');
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network during replay');
  });
  class GuardDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) throw new Error('clock read during replay: new Date()');
      super(...(args as [any]));
    }
  }
  (globalThis as any).Date = GuardDate;
  (GuardDate as any).now = Date.now;
  io.armed = true;
  try {
    return fn();
  } finally {
    io.armed = false;
    (globalThis as any).Date = RealDate;
    now.mockRestore();
    fetchSpy.mockRestore();
  }
}

beforeEach(() => {
  store.clear();
  recorded.length = 0;
  io.calls.length = 0;
});
afterEach(() => {
  io.armed = false;
});

describe('SignalDecisionSnapshot', () => {
  it('is frozen and holds inputs only (no candidates, events or arbitration)', () => {
    const s = build();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.inputs.ohlcv15m[0])).toBe(true);
    expect(() => {
      (s.inputs.ohlcv15m[0] as any).close = 1;
    }).toThrow();
    expect(Object.keys(s.inputs).sort()).toEqual(
      ['corporateActions', 'familyRouterState', 'futures', 'liquidityMap', 'marketRegime', 'ohlcv15m', 'ohlcv1hCloses', 'ohlcv5m', 'optionChain', 'optionMetrics', 'slotTradedKeys', 'spot', 'structureState'].sort()
    );
    // Every input bar is ≤ T.
    for (const b of s.inputs.ohlcv15m) expect(b.time + M15).toBeLessThanOrEqual(s.decisionBarTime);
  });

  it('carries every version field the spec lists', () => {
    const v = build().versions;
    for (const k of ['gitCommit', 'analyticsVersion', 'signalEngineVersion', 'optionModelVersion', 'parentingVersion', 'arbitrationVersion', 'ruleVersion', 'strategyVersion', 'costModelVersion', 'snapshotSchemaVersion'])
      expect(v, k).toHaveProperty(k);
    expect(v.signalEngineVersion).toMatch(/\+rr-display-only\.1\+parent-identity\.1\+demote-a4\.1$/);
    expect(v.parentingVersion).toBe('PARENT-2.0');
  });

  it('ANALYTICS_VERSION mirrors the @fno/analytics package version', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/analytics/package.json'), 'utf8'));
    expect(ANALYTICS_VERSION).toBe(pkg.version);
  });

  it('has a deterministic, UUID-shaped id', () => {
    expect(build().snapshotId).toBe(build().snapshotId);
    expect(build().snapshotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(build({ polledAt: POLL + 1 }).snapshotId).not.toBe(build().snapshotId);
  });

  it('survives the stored form (compressed chain) unchanged', () => {
    const s = build();
    const row = dr.freezeSnapshotRow(s);
    expect(typeof row.inputs.optionChainGz).toBe('string');
    expect(row.inputs).not.toHaveProperty('optionChain');
    expect(dr.canonicalJson(viaDatabase(s))).toBe(dr.canonicalJson(s));
  });
});

describe('data quality at T', () => {
  it('(d) ageMs recomputes from asOf + decisionBarTime, before and after storage, and the status follows', () => {
    for (const s of [build(), viaDatabase(build()), build({ chain: chainAt(T + 200_000) }), build({ chain: null })]) {
      for (const [k, q] of Object.entries(s.dataQuality.inputs)) {
        expect(q.decisionBarTime, k).toBe(s.decisionBarTime);
        expect(q.ageMs, k).toBe(ageMsOf(q.asOf, q.decisionBarTime));
        expect(q.ageMs, k).toBe(q.asOf == null ? null : q.decisionBarTime - q.asOf);
        expect(q.status, k).toBe(inputStatusOf(q.asOf, q.decisionBarTime, q.toleranceMs));
      }
    }
  });

  it('OK / FUTURE_INPUT / STALE_INPUT / MISSING', () => {
    expect(build().dataQuality.inputs.ohlcv15m.status).toBe('OK');
    expect(build().dataQuality.inputs.optionChain.status).toBe('OK');
    expect(build({ chain: chainAt(T + 200_000) }).dataQuality.inputs.optionChain.status).toBe('FUTURE_INPUT');
    expect(build({ chain: chainAt(T - 10 * 60_000) }).dataQuality.inputs.optionChain.status).toBe('STALE_INPUT');
    expect(build({ chain: null }).dataQuality.inputs.optionChain.status).toBe('MISSING');
    // The feed has not delivered the bar that closed at T.
    expect(build({ bars15m: bars.slice(0, -1) }).dataQuality.inputs.ohlcv15m.status).toBe('STALE_INPUT');
    // Not applicable inputs do not degrade the snapshot.
    const ok = build();
    expect(ok.dataQuality.inputs.ohlcv5m.status).toBe('MISSING');
    expect(ok.dataQuality.inputs.corporateActions.status).toBe('MISSING');
    expect(ok.dataQuality.degraded).toBe(false);
  });

  it('a FUTURE_INPUT chain is never used silently: the record and the candidates that read it are degraded', () => {
    const r = dr.deriveDecisionRecord(build({ chain: chainAt(T + 200_000) }), 1);
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.join(' ')).toMatch(/optionChain: FUTURE_INPUT/);
    const newest = r.candidates.filter((c) => c.decisionTime === today[7].time);
    expect(newest.length).toBeGreaterThan(0);
    for (const c of newest) expect(c.degraded, c.candidateId).toBe(true);
    for (const o of r.optionCandidates) expect(o.degraded).toBe(true);
    const clean = dr.deriveDecisionRecord(build(), 1);
    expect(clean.degraded).toBe(false);
    for (const c of clean.candidates) expect(c.degraded).toBe(false);
  });
});

describe('DecisionRecord', () => {
  it('holds the derived decision: events, candidates, parents, trigger-event links, metrics, option candidates, arbitration, final status', () => {
    const r = dr.deriveDecisionRecord(build(), 1);
    expect(r.structure.status).toBe('ADVANCED');
    expect(r.families.status).toBe('EVALUATED');
    expect(r.families.events.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.parentId, c.candidateId).toBeTruthy();
      expect(c.anchorKeys[0]).toBe(c.parentId);
    }
    expect(r.triggerEventIds.length).toBeGreaterThan(0);
    const handed = r.candidates.filter((c) => c.handedToSlot).map((c) => c.candidateId).sort();
    expect(handed.length).toBeGreaterThan(0);
    expect(r.metrics.map((m: any) => m.candidateId).sort()).toEqual(handed);
    expect(r.optionCandidates.length).toBeGreaterThan(0);
    expect(r.arbitration?.order.slice().sort()).toEqual(handed);
    expect(r.finalStatus).toBe('CANDIDATES_TO_SLOT');
    expect(r.selectedCandidateId).toBe(r.arbitration!.order[0]);
    expect(r.notReplayed).toEqual([...dr.NOT_REPLAYED]);
  });

  it('is deterministic: same snapshot → byte-identical canonical record', () => {
    const s = build();
    expect(dr.canonicalRecord(dr.deriveDecisionRecord(s, 1))).toBe(dr.canonicalRecord(dr.deriveDecisionRecord(s, 999)));
  });

  it('a parent move already traded today is refused before ranking', () => {
    const first = dr.deriveDecisionRecord(build(), 1);
    const traded = first.candidates.find((c) => c.handedToSlot)!;
    const r = dr.deriveDecisionRecord(build({ slotTradedKeys: [traded.parentId!] }), 1);
    expect(r.arbitration?.parentAlreadyTraded).toContain(traded.candidateId);
    expect(r.arbitration?.order).not.toContain(traded.candidateId);
  });

  it('the live router, run on the snapshot\'s inputs, hands the slot exactly the record\'s candidates', async () => {
    const s = build();
    const r = dr.deriveDecisionRecord(s, 1);
    const live = await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: structuredClone(s.inputs.optionChain) as OptionChain, now: POLL, state: structuredClone(s.inputs.familyRouterState) as any });
    expect(live!.paper.map((p) => p.lifecycleId).sort()).toEqual(r.candidates.filter((c) => c.source !== 'S1' && c.handedToSlot).map((c) => c.candidateId).sort());
    expect(live!.linkage).toEqual(r.families.linkage);
  });
});

describe('replay(snapshotId) — offline', () => {
  it('(a) replay of the stored snapshot equals the stored decision under canonicalization', () => {
    const snap = build();
    const stored = storedForm(dr.deriveDecisionRecord(snap, 1_700_000_000_000));
    const loaded = viaDatabase(snap);
    const out = dr.replaySnapshot(loaded, dr.currentConfigHashFor(loaded));
    expect(out.status).toBe('OK');
    if (out.status !== 'OK') return;
    expect(dr.recordDiff(stored, out.record)).toEqual([]);
    expect(out.hash).toBe(dr.recordHash(stored));
    // generatedAt is the declared nondeterministic field: it differs and does not matter.
    expect(out.record.generatedAt).not.toBe(stored.generatedAt);
  });

  it('(b) any difference outside the declared list fails; the declared list is exactly the generated timestamp', () => {
    expect([...NONDETERMINISTIC_RECORD_FIELDS]).toEqual(['generatedAt']);
    const base = storedForm(dr.deriveDecisionRecord(build(), 1));
    const mutate = (f: (r: any) => void) => {
      const r = structuredClone(base) as any;
      f(r);
      return r as DecisionRecord;
    };
    expect(dr.recordDiff(base, mutate((r) => (r.generatedAt = 2)))).toEqual([]);
    const changes: Array<[string, (r: any) => void]> = [
      ['selected candidate', (r) => (r.selectedCandidateId = 'X')],
      ['parent id', (r) => (r.candidates[0].parentId = 'other')],
      ['rejection reason', (r) => (r.candidates[0].reason = 'changed')],
      ['ranking', (r) => r.arbitration.order.reverse().push('Z')],
      ['metric', (r) => (r.metrics[0].entryQuality = 0.123456)],
      ['option selection', (r) => (r.optionCandidates[0].strike = 1)],
      ['final status', (r) => (r.finalStatus = 'NO_CANDIDATE')],
      ['event', (r) => (r.families.events[0].price = -1)],
    ];
    for (const [name, f] of changes) {
      const m = mutate(f);
      expect(dr.recordDiff(base, m).length, name).toBeGreaterThan(0);
      expect(dr.recordHash(m), name).not.toBe(dr.recordHash(base));
    }
  });

  it('(c) replay reads nothing but the snapshot: any Redis / SQL / network / clock access fails it', () => {
    const loaded = viaDatabase(build());
    const hash = dr.currentConfigHashFor(loaded);
    io.calls.length = 0;
    const out = offline(() => dr.replaySnapshot(loaded, hash));
    expect(out.status).toBe('OK');
    expect(io.calls).toEqual([]);
    // The guard itself works: a clock or Redis read inside it throws.
    expect(() => offline(() => Date.now())).toThrow(/clock read/);
    expect(() => offline(() => new Date())).toThrow(/clock read/);
    expect(() => offline(() => touch('redis.get x'))).toThrow(/IO during replay/);
  });

  it('refuses to replay under a configuration other than the recorded one — never substitutes', () => {
    const loaded = viaDatabase(build());
    const out = dr.replaySnapshot(loaded, 'some-other-config');
    expect(out.status).toBe('CONFIG_MISMATCH');
    expect(out).not.toHaveProperty('record');
  });

  it('a missing chain stays missing in replay (no option candidates, never fetched)', () => {
    const loaded = viaDatabase(build({ chain: null }));
    const out = offline(() => dr.replaySnapshot(loaded, dr.currentConfigHashFor(loaded)));
    expect(out.status).toBe('OK');
    if (out.status === 'OK') {
      expect(out.record.optionCandidates).toEqual([]);
      expect(out.record.degradedReasons.join(' ')).toMatch(/optionChain: MISSING/);
    }
  });
});

describe('decision bar T on the exchange session calendar', () => {
  it('is the newest 15m bar closed by the poll, counted from the session open', () => {
    expect(decisionBarCloseAt('NSE', ist('2026-08-10T11:18:00'), M15)).toBe(ist('2026-08-10T11:15:00'));
    expect(decisionBarCloseAt('NSE', ist('2026-08-10T11:15:00'), M15)).toBe(ist('2026-08-10T11:15:00'));
    // Before the first bar closes: the previous session's last bar (Friday's close).
    expect(decisionBarCloseAt('NSE', ist('2026-08-10T09:20:00'), M15)).toBe(ist('2026-08-07T15:30:00'));
    // After the close: the session's last bar.
    expect(decisionBarCloseAt('NSE', ist('2026-08-10T18:00:00'), M15)).toBe(ist('2026-08-10T15:30:00'));
    // MCX opens 09:00.
    expect(decisionBarCloseAt('MCX', ist('2026-08-10T09:31:00'), M15)).toBe(ist('2026-08-10T09:30:00'));
  });
});
