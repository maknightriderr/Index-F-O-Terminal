import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const m = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray) => {
    m.writes.push(strings.join('?').trim().split(/\s+/).slice(0, 3).join(' '));
    return Promise.resolve([]);
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));

const E = await import('../experiment-engine.js');
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f: string) => readFileSync(path.join(SERVER, f), 'utf8');

const T0 = Date.UTC(2026, 9, 26, 5, 0);
const leg = (o: object = {}) => ({ token: '43210', ltp: 100, bid: 99.5, ask: 100.5, bidQty: 1000, askQty: 1000, timestamp: T0, exchangeTimestamp: T0 - 1000, ...o });
const chain = (o: object = {}) => ({ expiry: '2026-10-27', spotPrice: 2400, strikes: [{ strike: 2400, call: leg(o), put: leg({ token: '43211' }) }] }) as any;
const candidate = (o: object = {}) => ({
  at: T0, candidateId: 'IND:NSE:TCS:INTRADAY:BULLISH:2026-10-26', symbol: 'TCS', exchange: 'NSE' as const, mode: 'INTRADAY' as const, direction: 'BULLISH' as const,
  confidence: 70, side: 'CE' as const, strike: 2400, expiry: '2026-10-27', token: '43210', lotSize: 175, entry: 100, stop: 70, target: 110, costPct: 2.5,
  statutoryPct: 0.15, brokeragePerLotInr: 47.2, minutesSinceOpen: 120, behindLevel: 2380, atr: 10,
  quote: { ltp: 100, bid: 99.5, ask: 100.5, bidQty: 1000, askQty: 1000, exchangeAt: T0 - 1000, receivedAt: T0, feedState: null, source: 'CHAIN' }, ...o,
});
const poll = (o: object = {}) => ({ at: T0, symbol: 'TCS', exchange: 'NSE' as const, mode: 'INTRADAY' as const, direction: 'BULLISH', confidence: 70, chain: chain(), confirmMs: 300_000, lastClosedBar: null, buildCandidate: async () => candidate(), ...o });

describe('experiment engine: one candidate stream, independent arm state', () => {
  beforeEach(() => {
    E.__resetExperimentEngine();
    E.__startedForTest();
    m.writes.length = 0;
  });

  it('each arm decides on its own; a low-target candidate opens R0, B and V2 but not A or C', async () => {
    await E.onIndicatorPoll(poll()); // target 110: 10 / 30 = 0.33R
    expect(E.__positions().map((p) => p.arm).sort()).toEqual(['B', 'R0', 'V2']);
  });

  it("an arm that skipped keeps its slot free: A takes a later qualifying candidate while R0's slot is still held", async () => {
    await E.onIndicatorPoll(poll());
    await E.onIndicatorPoll(poll({ at: T0 + 15 * 60_000, buildCandidate: async () => candidate({ at: T0 + 15 * 60_000, target: 130 }) }));
    const arms = E.__positions().map((p) => p.arm).sort();
    expect(arms.filter((a) => a === 'R0')).toHaveLength(1); // R0 held, did not re-enter
    expect(arms).toContain('A');
    expect(arms).toContain('C');
  });

  it('no candidate is built when every arm holds this slot', async () => {
    await E.onIndicatorPoll(poll({ buildCandidate: async () => candidate({ target: 130 }) }));
    expect(E.__positions()).toHaveLength(5);
    const build = vi.fn(async () => candidate());
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, buildCandidate: build }));
    expect(build).not.toHaveBeenCalled();
  });

  it("existing positions are marked from the poll's own chain and close on their own rules", async () => {
    await E.onIndicatorPoll(poll({ buildCandidate: async () => candidate({ target: 130 }) }));
    // No new candidate on this poll, so only the existing positions move.
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, chain: chain({ ltp: 131, bid: 130.5, ask: 131.5, timestamp: T0 + 60_000, exchangeTimestamp: T0 + 59_000 }), buildCandidate: async () => null }));
    expect(E.__positions()).toHaveLength(0); // every arm's official and simulated target filled -> no longer live
    expect(m.writes.some((w) => w.startsWith('INSERT INTO experiment_positions'))).toBe(true);
  });

  it('a positional or neutral read never builds a candidate', async () => {
    const build = vi.fn(async () => candidate());
    await E.onIndicatorPoll(poll({ mode: 'POSITIONAL', buildCandidate: build }));
    await E.onIndicatorPoll(poll({ direction: 'NEUTRAL', buildCandidate: build }));
    expect(build).not.toHaveBeenCalled();
  });

  it('freed slots take the next candidate in the same poll; its stale quote leaves the simulation NOT_OPENED', async () => {
    await E.onIndicatorPoll(poll({ buildCandidate: async () => candidate({ target: 130 }) }));
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, chain: chain({ ltp: 131, bid: 130.5, ask: 131.5, timestamp: T0 + 60_000, exchangeTimestamp: T0 + 59_000 }) }));
    const reopened = E.__positions();
    expect(reopened.map((p) => p.arm).sort()).toEqual(['B', 'R0', 'V2']); // the 0.33R candidate: A and C skip it
    expect(reopened.every((p) => p.sim.status === 'NOT_OPENED' && p.sim.reason === 'ENTRY_UNAVAILABLE:STALE_QUOTE')).toBe(true);
  });

  it('a position is stamped no earlier than its own entry quote (the poll clock starts before the contract build)', async () => {
    await E.onIndicatorPoll(poll({ at: T0 - 30_000 })); // the candidate's quote was received at T0, 30 s after the poll began
    expect(E.__positions().map((p) => p.openedAt)).toEqual(Array(E.__positions().length).fill(T0));
    E.__resetExperimentEngine();
    E.__startedForTest();
    await E.onIndicatorPoll(poll({ at: T0 + 5_000 })); // a quote older than the poll never back-dates it
    expect(new Set(E.__positions().map((p) => p.openedAt))).toEqual(new Set([T0 + 5_000]));
  });
  it('V2 1.1: after its losing invalidation exit the same move is not re-entered in that poll; under the retired 1.0 it was', async () => {
    const later = T0 + 30 * 60_000;
    const q = { ltp: 90, bid: 89.5, ask: 90.5, timestamp: later, exchangeTimestamp: later - 1000 };
    const second = () => poll({ at: later, chain: chain(q), lastClosedBar: { close: 2370, closeAt: later }, buildCandidate: async () => candidate({ at: later, target: 130, quote: { ltp: 90, bid: 89.5, ask: 90.5, bidQty: 1000, askQty: 1000, exchangeAt: later - 1000, receivedAt: later, feedState: null, source: 'CHAIN' } }) });
    for (const [version, reenters] of [['IND-V2-INVALIDATION-1.1', false], ['IND-V2-INVALIDATION-1.0', true]] as const) {
      E.__resetExperimentEngine();
      E.__startedForTest();
      await E.onIndicatorPoll(poll({ buildCandidate: async () => candidate({ target: 130 }) }));
      E.__positions().filter((p) => p.arm === 'V2').forEach((p) => (p.armVersion = version));
      await E.onIndicatorPoll(second());
      expect(E.__positions().filter((p) => p.arm === 'V2' && p.openedAt === later).length > 0).toBe(reenters);
      expect(E.__positions().some((p) => p.arm === 'R0' && p.openedAt === T0)).toBe(true); // R0 holds: no invalidation exit
    }
  });
  it('a failing candidate builder never throws into the poll', async () => {
    await expect(E.onIndicatorPoll(poll({ buildCandidate: async () => { throw new Error('boom'); } }))).resolves.toBeUndefined();
  });
});

describe('EXP-3.0: routed trigger candidates feed only their own capture arm, once each', () => {
  beforeEach(() => {
    E.__resetExperimentEngine();
    E.__startedForTest();
  });
  const trig = (source: 'A3' | 'OF1', id: string, o: object = {}) => ({ source, candidateId: id, build: async () => candidate({ candidateId: id, triggerId: source, sweepExtreme: 2385, target: 130, ...o }) });
  it('an A3 candidate opens A3R only; the Indicator arms ignore it; OF1R ignores it', async () => {
    await E.onIndicatorPoll(poll({ direction: 'NEUTRAL', triggerCandidates: [trig('A3', 'NSE:TCS:MP:A3:BULLISH:1')] }));
    expect(E.__positions().map((p) => p.arm)).toEqual(['A3R']);
  });
  it('the same routed candidate on later polls of its bar is not taken twice, even once its position closed', async () => {
    const t = trig('OF1', 'NSE:TCS:MP:OF1:BULLISH:1');
    await E.onIndicatorPoll(poll({ direction: 'NEUTRAL', triggerCandidates: [t] }));
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, direction: 'NEUTRAL', chain: chain({ ltp: 131, bid: 130.5, ask: 131.5, timestamp: T0 + 60_000, exchangeTimestamp: T0 + 59_000 }), triggerCandidates: [t] }));
    expect(E.__positions()).toHaveLength(0); // closed at its target and not re-opened
    await E.onIndicatorPoll(poll({ at: T0 + 15 * 60_000, direction: 'NEUTRAL', triggerCandidates: [trig('OF1', 'NSE:TCS:MP:OF1:BULLISH:2', { at: T0 + 15 * 60_000 })] }));
    expect(E.__positions().map((p) => p.arm)).toEqual(['OF1R']); // a new candidate is a new position
  });
  it('a fresh opposite trigger closes the held A3R trade on its first poll only (as the claim), never again', async () => {
    await E.onIndicatorPoll(poll({ direction: 'NEUTRAL', triggerCandidates: [trig('A3', 'NSE:TCS:MP:A3:BULLISH:1')] }));
    const fresh = [{ id: 'S:lc-9', direction: 'BEARISH' as const }];
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, direction: 'NEUTRAL', freshTriggers: fresh }));
    expect(E.__positions()[0].official).toMatchObject({ status: 'CLOSED', reason: 'TRIGGER_REVERSAL' }); // its simulated exit waits for a fresh bid
    await E.onIndicatorPoll(poll({ at: T0 + 120_000, direction: 'NEUTRAL', triggerCandidates: [trig('A3', 'NSE:TCS:MP:A3:BULLISH:2', { at: T0 + 120_000 })] }));
    await E.onIndicatorPoll(poll({ at: T0 + 180_000, direction: 'NEUTRAL', freshTriggers: fresh })); // the same trigger, seen again
    expect(E.__positions().filter((p) => p.official.status === 'OPEN').map((p) => p.candidate.candidateId)).toEqual(['NSE:TCS:MP:A3:BULLISH:2']);
  });
  it('a position opened under a retired version finishes under that version (no TRIGGER_REVERSAL for 1.0)', async () => {
    await E.onIndicatorPoll(poll({ direction: 'NEUTRAL', triggerCandidates: [trig('A3', 'NSE:TCS:MP:A3:BULLISH:1')] }));
    const p = E.__positions()[0];
    p.armVersion = 'A3-R0-1.0';
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, direction: 'NEUTRAL', freshTriggers: [{ id: 'S:lc-7', direction: 'BEARISH' }] }));
    expect(E.__positions()).toHaveLength(1);
  });
  it('every routed candidate is recorded: a held slot (ARM_SLOT_HELD) and a refused build (NOT_BUILT) included', async () => {
    await E.onIndicatorPoll(poll({ direction: 'NEUTRAL', triggerCandidates: [trig('A3', 'NSE:TCS:MP:A3:BULLISH:1')] }));
    m.writes.length = 0;
    let built = 0;
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, direction: 'NEUTRAL', triggerCandidates: [{ source: 'A3' as const, candidateId: 'NSE:TCS:MP:A3:BULLISH:2', build: async () => { built++; return candidate(); } }] }));
    expect(built).toBe(0); // never built while the arm's slot is held
    expect(m.writes.filter((w) => w === 'INSERT INTO experiment_decisions')).toHaveLength(1);
    await E.onIndicatorPoll(poll({ at: T0 + 60_000, direction: 'NEUTRAL', triggerCandidates: [{ source: 'OF1' as const, candidateId: 'NSE:TCS:MP:OF1:BULLISH:3', build: async () => null }] }));
    expect(m.writes.filter((w) => w === 'INSERT INTO experiment_decisions')).toHaveLength(2);
    const eng = read('src/services/experiment-engine.ts');
    expect(eng).toMatch(/recordDecision\(arm, id, false, 'ARM_SLOT_HELD', poll\.at\)/);
    expect(eng).toMatch(/recordDecision\(arm, id, false, 'NOT_BUILT', poll\.at\)/);
  });
  it("the fresh triggers are decided side effect free by the claims' own code, before the claims", () => {
    const mb = read('src/services/market-bias.ts');
    const hook = mb.slice(mb.indexOf('freshTriggers: ['), mb.indexOf('const trigger = momentumFamily?.trigger ? await claimMomentumTrigger'));
    expect(hook).toMatch(/structureFillDecision\(structureFamily, chain\.spotPrice, structureFamily\.lastClosedBar \?\? lastClosedBar\)\.fill/);
    expect(hook).not.toMatch(/redis\.|recordStructureOutcome|claimStructureFill\(/);
    const claim = mb.slice(mb.indexOf('async function claimStructureFill('), mb.indexOf('async function claimStructureFill(') + 900);
    expect(claim).toMatch(/const \{ fill: candidate, refused \} = structureFillDecision\(family, spot, closedBar\);/);
    const decide = mb.slice(mb.indexOf('function structureFillDecision('), mb.indexOf('async function claimStructureFill('));
    expect(decide).not.toMatch(/await|redis\.|recordStructureOutcome/);
  });
  it('a candidate production never selects still reaches its arm (the arm does not read production arbitration)', () => {
    const mb = read('src/services/market-bias.ts');
    const hook = mb.slice(mb.indexOf('triggerCandidates: (triggers?.families'), mb.indexOf('triggerCandidates: (triggers?.families') + 600);
    expect(hook).toMatch(/\.filter\(\(rc\) => rc\.candidate\.triggerId === 'A3' \|\| rc\.candidate\.triggerId === 'OF1'\)/);
    expect(hook).not.toMatch(/arbitration|SELECTED|structure_claimed/);
  });
  it('the trigger candidate builder runs the production contract build and has no side effect', () => {
    const mb = read('src/services/market-bias.ts');
    const fn = mb.slice(mb.indexOf('export async function buildTriggerExperimentCandidate'), mb.indexOf('async function buildStructureContract'));
    expect(fn).toMatch(/await buildStructureContract\(/);
    expect(fn).not.toMatch(/losingCloseCooldownReason|concurrencyGateReason|logDecision|recordDecisionSnapshot|recordStructureOutcome|redis\.|mintTradeSetup|setSlotIfSame|structure_claimed/);
    expect(mb).toMatch(/const \{ validated, targetMove, expectedHoldHours, ivRank \} = await buildStructureContract\(\{ provider, underlying, exchange, chain, lc, spot, side, direction, confidence, optionAtr, fiveMinute, entryContext, at \}\);/);
  });
});

describe('isolation from production (source wiring)', () => {
  const mb = read('src/services/market-bias.ts');
  it('the poll hands the engine its read fire-and-forget, before and outside the production slot logic', () => {
    expect(mb).toMatch(/if \(EXPERIMENT_ARMS_ENABLED\) \{\s+const at = decisionNow\(\);\s+void onIndicatorPoll\(\{/);
  });
  it('the experiment candidate runs the production contract build, not a copy, and applies no baseline cooldown', () => {
    const fn = mb.slice(mb.indexOf('export async function buildIndicatorExperimentCandidate'), mb.indexOf("// ---------------- the Old Indicator's contract build, shared"));
    expect(fn).toMatch(/await buildIndicatorContract\(/);
    expect(fn).not.toMatch(/losingCloseCooldownReason|concurrencyGateReason|logDecision|recordDecisionSnapshot|redis\.|mintTradeSetup|setSlotIfSame/);
    expect(mb).toMatch(/const validated = await buildIndicatorContract\(\{ provider, underlying, exchange, mode, chain, direction, confidence, entryContext, primaryMove, targetMoveFor, expectedHoldHours, ivRank, slPremiumPct, vix \}\);/);
  });
  it('the engine writes only experiment_* tables', () => {
    const eng = read('src/services/experiment-engine.ts');
    const tables = [...eng.matchAll(/INSERT INTO (\w+)/g)].map((x) => x[1]);
    expect(new Set(tables)).toEqual(new Set(['experiment_positions', 'experiment_events', 'experiment_decisions', 'experiment_arms']));
    expect(eng).not.toMatch(/trade_setup:|signals|redis/);
  });
});

describe('durable linkage (2026-10-23)', () => {
  it("a slot evaluation handed another caller's setup is not its own mint", async () => {
    const { isOwnMint } = await import('../setup-mint-lock.js');
    expect(isOwnMint('EXISTING')).toBe(false);
    expect(isOwnMint('BUSY')).toBe(false);
    expect(isOwnMint('MINTED')).toBe(true);
    expect(isOwnMint('UNLOCKED')).toBe(true);
    const src = read('src/services/market-bias.ts');
    expect(src).toMatch(/return \{ setup: minted, minted: ours && minted\.available \};/);
  });

  it('a MINTED slot row carries the trade it minted; any other outcome carries none', async () => {
    const { slotDecisionRow } = await import('../slot-decisions.js');
    const base = { at: T0, symbol: 'TCS', exchange: 'NSE', mode: 'INTRADAY', decisionBarTime: T0, records: [], noTrade: null, versions: { option: null, arbitration: null, optionSelection: null }, signalId: 'sig-1', decisionId: 'dec-1' };
    expect(slotDecisionRow({ ...base, minted: true })).toMatchObject({ outcome: 'MINTED', signalId: 'sig-1', decisionId: 'dec-1' });
    expect(slotDecisionRow({ ...base, minted: false })).toMatchObject({ signalId: null, decisionId: null });
    expect(read('src/services/slot-decisions.ts')).toMatch(/ON CONFLICT \(signal_id\) WHERE signal_id IS NOT NULL DO NOTHING/);
    expect(read('../../database/init/045_experiments_and_linkage.sql')).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_decisions_signal ON slot_decisions \(signal_id\) WHERE signal_id IS NOT NULL/);
  }, 30_000); // the cold import of slot-decisions' module graph takes ~2 s alone and exceeded 5 s under full-suite load
});
