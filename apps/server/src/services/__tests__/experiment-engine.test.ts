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

  it('a failing candidate builder never throws into the poll', async () => {
    await expect(E.onIndicatorPoll(poll({ buildCandidate: async () => { throw new Error('boom'); } }))).resolves.toBeUndefined();
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
  });
});
