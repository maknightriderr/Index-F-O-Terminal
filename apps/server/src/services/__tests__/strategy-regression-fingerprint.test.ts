// ============================================================
// STRATEGY REGRESSION FINGERPRINT (frozen 2026-10-09, before the OB fix / OF1)
// ============================================================
// Runs the UNCHANGED live strategies over frozen real 15m bars
// (fixtures/regression-bars.json) and hashes everything they decide:
//   * every event and every A1–F4 trigger candidate at every bar of every session
//   * S1 (structure engine): every variant, live and research rules, every bar
//   * the live router (stages incl. A4 SHADOW, risk validation, paper / watch)
//   * the slot ranking of the router's paper candidates
//   * the option builder over a grid, and the pure safety / validation gates
// The expected hashes were computed on main (4628fba) BEFORE the change. Any
// difference means a strategy decides differently — the release that adds the
// Order Block fix and OF1 must leave every one of them identical.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' }, scanKeys: async () => [] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const A = await import('@fno/analytics');
const { evaluateFamiliesCore, EMPTY_FAMILY_ROUTER_STATE, liveTriggerStages, validateCandidateRisk } = await import('../trigger-router.js');
const { liveStructureRulesFor } = await import('../structure-live.js');
const SA = await import('../slot-arbitration.js');
const VG = await import('../validation-gates.js');
const { fixtureStrikes, ATM, LOT } = await import('./trade-setup-fixtures.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(path.join(HERE, 'fixtures/regression-bars.json'), 'utf8')) as { series: Record<string, number[][]> };
const EXCHANGE: Record<string, 'NSE' | 'MCX'> = { CRUDEOIL: 'MCX' };
const barsOf = (sym: string) => FIX.series[sym].map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

/** Stable JSON: sorted keys, numbers as given, undefined dropped. */
function stable(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex').slice(0, 16);

const SYMBOLS = Object.keys(FIX.series).sort();

function triggerFingerprint(sym: string) {
  const series = A.prepareMomentumSeries(barsOf(sym));
  const ctx = A.buildSeriesContext(series);
  const out: unknown[] = [];
  for (let s = 0; s < series.sessionStarts.length; s++) {
    const log = A.runSessionEvents(ctx, s);
    out.push({ s, events: log.events });
    for (let i = series.sessionStarts[s]; i <= ctx.sessionEnd(s); i++) {
      const c = A.evaluateTriggersAt(ctx, log, i, undefined, []);
      if (c.length) out.push({ i, c });
    }
  }
  return out;
}

function structureFingerprint(sym: string) {
  const series = A.prepareMomentumSeries(barsOf(sym));
  const out: unknown[] = [];
  for (const v of A.STRUCTURE_VARIANTS) {
    for (const rules of [liveStructureRulesFor('15m'), A.STRUCTURE_RULES]) {
      for (let i = 0; i < series.bars.length; i++) {
        const r = A.evaluateStructureSession(series, i, v, rules);
        if (r.setups.length) out.push({ v: v.id, live: rules !== A.STRUCTURE_RULES, i, setups: r.setups });
      }
    }
  }
  return out;
}

function routerFingerprint(sym: string) {
  const bars = barsOf(sym);
  const series = A.prepareMomentumSeries(bars);
  const out: unknown[] = [];
  for (let s = 0; s < series.sessionStarts.length; s++) {
    const last = s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] - 1 : bars.length - 1;
    // Mid-session and at the close: the router at two decision instants per session.
    for (const end of [Math.floor((series.sessionStarts[s] + last) / 2), last]) {
      const now = bars[end].time + 15 * 60_000 + 60_000;
      const r = evaluateFamiliesCore({ underlying: sym, exchange: EXCHANGE[sym] ?? 'NSE', mode: 'INTRADAY', bars: bars.slice(0, end + 1), chain: null, now, stages: liveTriggerStages(), state: EMPTY_FAMILY_ROUTER_STATE });
      const slots = r.paper.map((p) => SA.routedSlotCandidate(p));
      out.push({ s, end, status: r.status, routed: r.routed, paper: r.paper, watch: r.watch, failures: r.triggerFailures, ranking: slots.length ? SA.rankSlotCandidates(slots) : null });
    }
  }
  return out;
}

function optionFingerprint() {
  const out: unknown[] = [];
  for (const dir of ['BULLISH', 'BEARISH'] as const)
    for (const move of [20, 60, 120, 250])
      for (const sl of [undefined, 0.15, 0.3])
        for (const opts of [{}, { rrGate: false }, { rrGate: false, confidenceGate: false }])
          out.push({ dir, move, sl, opts, setup: A.buildTradeSetup(fixtureStrikes(), ATM, dir, 80, move, sl, null, 5, LOT, 50, opts as any) });
  return out;
}

function gatesFingerprint() {
  const out: unknown[] = [];
  for (const conf of [40, 74, 75, 90]) for (const mode of ['EVIDENCE', 'LEGACY'] as const) out.push(VG.setupConfidenceRefusal({ mode, confidence: conf, minConfidence: 75 }));
  for (const s of [null, true, false]) out.push(VG.roomGateReason({ enabled: true, sufficientV2: s, availableAtr: 0.4, requiredAtrV2: 1.2 }));
  for (const bucket of ['TRADE', 'LOW_RR', 'NO_TARGET', 'INVALID_STOP'])
    for (const sessionOk of [true, false])
      for (const costPct of [null, 2, 9]) out.push(validateCandidateRisk({ bucket } as any, { sessionOk, costPct, maxCostPct: 5 }));
  out.push(liveTriggerStages());
  return out;
}

// Computed on main (4628fba), before the Order Block fix and OF1.
const EXPECTED: Record<string, string> = {
  'triggers:ADANIGREEN': '62dee9119d01b245',
  'triggers:BANKNIFTY': '048a3a11f2a02c77',
  'triggers:CRUDEOIL': 'e739e0efad87f3ec',
  'triggers:KALYANKJIL': '9c12e151c4cacf1e',
  'triggers:NIFTY': '161f1d34cecc52c9',
  'triggers:POLICYBZR': '915ee7826123aaa4',
  'structure:ADANIGREEN': 'dcce42192e9865c0',
  'structure:BANKNIFTY': '32cd02826ff377fc',
  'structure:CRUDEOIL': '78a412e55802df21',
  'structure:KALYANKJIL': 'fc215c1a0d770424',
  'structure:NIFTY': 'cb722a43a2d21f7e',
  'structure:POLICYBZR': '91273077537002bf',
  'router:ADANIGREEN': '87751ee4f2385059',
  'router:BANKNIFTY': 'b080ab33393f5f42',
  'router:CRUDEOIL': '26547aae08816678',
  'router:KALYANKJIL': '4b641216d1119ab2',
  'router:NIFTY': 'a73221767b2e435e',
  'router:POLICYBZR': '034c2d8e09c6e7d2',
  option: '8e947c8e9caa077b',
  gates: 'f11bf550a74638e1',
};

describe('strategy regression fingerprint: A2–F3, A4 stage, S1, router, slot ranking, option builder, gates', () => {
  const got: Record<string, string> = {};
  for (const sym of SYMBOLS) {
    got[`triggers:${sym}`] = hash(triggerFingerprint(sym));
    got[`structure:${sym}`] = hash(structureFingerprint(sym));
    got[`router:${sym}`] = hash(routerFingerprint(sym));
  }
  got.option = hash(optionFingerprint());
  got.gates = hash(gatesFingerprint());

  it('the fixture exercises the families (not an empty fingerprint)', () => {
    const fired = new Set<string>();
    for (const sym of SYMBOLS) for (const x of triggerFingerprint(sym) as any[]) for (const c of x.c ?? []) fired.add(c.triggerId);
    expect(fired.size).toBeGreaterThanOrEqual(8);
  });

  for (const key of Object.keys(EXPECTED)) {
    it(`${key} is identical to main`, () => {
      if (process.env.PRINT_FINGERPRINT) console.log(`FP '${key}': '${got[key]}',`);
      expect(got[key]).toBe(EXPECTED[key]);
    });
  }
});
