// ============================================================
// DOC-1 (audit 2026-10-18): labels and stamps that mislead, and the gate chains that could drift apart.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/db.js', () => ({ sql: Object.assign(() => Promise.resolve([]), { json: (v: unknown) => v }) }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const F = await import('../../config/trading-flags.js');
const E = await import('../setup-events.js');
const MB = await import('../momentum-break-live.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f: string) => readFileSync(path.join(SRC, f), 'utf8');

describe('the stamp says what each switch actually does', () => {
  const on = { STRUCTURAL_STOP: true, LOCATION_GATE: true, ROOM_GATE: false, CONCURRENCY_CAP: false, CLOSING_GUARD: true, RICH_IV_RR: true };
  it('rich-IV admission is active while location remains evidence only', () => {
    const e = F.effectiveTradingFlags(on, 'EVIDENCE');
    expect(e.RICH_IV_RR).toMatchObject({ on: true, effect: 'ACTIVE' });
    expect(e.RICH_IV_RR.why).toMatch(/net-payoff floor/);
    expect(e.LOCATION_GATE).toMatchObject({ on: true, effect: 'INERT' });
    expect(e.LOCATION_GATE.why).toMatch(/EVIDENCE/);
    expect(e.STRUCTURAL_STOP).toMatchObject({ on: true, effect: 'ACTIVE' });
    expect(e.ROOM_GATE).toMatchObject({ on: false, effect: 'OFF' });
  });
  it('LEGACY location mode enforces the location gate', () => {
    expect(F.effectiveTradingFlags(on, 'LEGACY').LOCATION_GATE).toMatchObject({ on: true, effect: 'ACTIVE' });
  });
  it('the live stamp carries it next to the raw flags', () => {
    const s = F.liveLogicStamp();
    expect(Object.keys(s.effectiveFlags ?? {}).sort()).toEqual(Object.keys(s.flags).sort());
  });
});

describe('"no opposite-side pool" is NO_TARGET, not LOW_RR', () => {
  it('a LOW_RR stage without a T1 is NO_TARGET; with a T1 too close it stays LOW_RR', () => {
    expect(E.setupEventTypeOf('LOW_RR', null)).toBe('NO_TARGET');
    expect(E.setupEventTypeOf('LOW_RR', 24930)).toBe('LOW_RR');
    expect(E.setupEventTypeOf('ENTRY_MINTED', null)).toBe('TRADED');
    expect(E.setupEventTypeOf('CONFIRMED', 1)).toBe('CONFIRMED');
  });
  it('the per-setup card reads NO_TARGET rows; grading leaves them out (no T1 to grade against)', () => {
    expect(read('services/signal-diagnostics.ts')).toMatch(/'LOW_RR', 'NO_TARGET', 'LATE', 'MISSED', 'INVALIDATED'/);
    expect(read('services/setup-events-grading.ts')).not.toMatch(/NO_TARGET/);
  });
});

describe('the cost model and the record format have different names', () => {
  it('COST-3.0 is the model; COSTREC-1.1 the record format', () => {
    expect(F.COST_VERSION).toBe('COST-3.0');
    expect(read('services/trade-costs.ts')).toMatch(/export const COST_RECORD_VERSION = 'COSTREC-1\.1';/);
  });
});

describe('the gate chains cannot drift apart', () => {
  const mb = read('services/market-bias.ts');
  it('the shared safety chain is riskOff, feed, session, cooldown, reliability, concurrency, in that order', () => {
    const order: string[] = [];
    const tag = (code: string) => ({ code, reason: code });
    const all = { riskOff: 'RISK_OFF', feedBlock: 'NO_QUOTE', session: tag('SESSION'), cooldown: tag('POST_LOSS_COOLDOWN'), reliability: 'RELIABILITY_FILTER', concurrency: tag('CONCURRENT_EXPOSURE') } as const;
    const keys = ['riskOff', 'feedBlock', 'session', 'cooldown', 'reliability', 'concurrency'] as const;
    let g: any = { ...all };
    for (const k of keys) {
      order.push(MB.safetyRefusal(g)!.code);
      g = { ...g, [k]: null };
    }
    expect(order).toEqual(['RISK_OFF', 'NO_QUOTE', 'SESSION', 'POST_LOSS_COOLDOWN', 'RELIABILITY_FILTER', 'CONCURRENT_EXPOSURE']);
    expect(MB.safetyRefusal(g)).toBeNull();
  });
  it('momentum and all three structure resolvers use that one shared chain', () => {
    expect(mb.match(/safetyRefusal\(\{ riskOff, feedBlock, session, cooldown, reliability, concurrency \}\)/g)?.length).toBe(3);
    expect(mb).toMatch(/triggerRefusal\(\{ riskOff, feedBlock, session, cooldown, reliability, concurrency \}, trigger, at, spot\)/);
  });
  it('the consensus (Old Indicator) chain keeps the shared gates in the same relative order', () => {
    const start = mb.indexOf('const refusal: GateRefusal | null =');
    const chain = mb.slice(start, mb.indexOf(';', mb.indexOf('concurrencyGateReason(', start)));
    const at = (needle: string) => {
      const i = chain.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const pos = [at("code: 'RISK_OFF'"), at("code: 'NO_QUOTE'"), at('sessionGateReason('), at('losingCloseCooldownReason('), at("code: 'RELIABILITY_FILTER'"), at('concurrencyGateReason(')];
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });
});
