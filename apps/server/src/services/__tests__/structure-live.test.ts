// ============================================================
// STRUCTURE — live wiring: lifecycle state, fills, slot, flags, schema
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateStructureSession, prepareMomentumSeries, STRUCTURE_VARIANTS, type MomentumBar } from '@fno/analytics';
import {
  advanceLiveState,
  fillCandidate,
  isAlertFresh,
  structureBlock,
  structureSequenceRefusal,
  structureStateKey,
  watchlistRows,
  type LiveLifecycle,
  type LiveState,
} from '../structure-live.js';
import { confirmedMessage } from '../setup-lifecycle.js';
import { isTriggerTrade, triggerSlotAction, STRUCTURE_STRATEGY, TRIGGER_STRATEGIES } from '../momentum-break-live.js';
import { strategyFamilyOf } from '../loss-attribution-model.js';
import { strategyFamilyOfSetup } from '../backtesting.js';
import { classifyRefusal } from '../research-contract.js';
import { gateForRefusalCode } from '../gate-diagnostics.js';
import { exitReasonFromCloseReason } from '../exit-reason.js';
import { invalidationReasonFromCloseReason } from '../invalidation-reason.js';
import {
  CONSENSUS_SETUPS_DEFAULT,
  LOGIC_VERSION,
  STRUCTURE_DEFAULT,
  STRUCTURE_LOGIC_VERSION,
  STRUCTURE_PARAM_DEFAULTS,
  TRADING_FLAG_DEFAULTS,
  TRADING_PARAM_DEFAULTS,
  COVERAGE_LAG_FLAG_DEFAULTS,
  COVERAGE_LAG_PARAM_DEFAULTS,
  MOMENTUM_BREAK_PARAM_DEFAULTS,
  FNO_VALIDATION_PARAM_DEFAULTS,
  liveLogicStamp,
  logicStamp,
  parseStructureSymbols,
  readConsensusSetupsFlag,
  readStructureFlag,
  readStructureParams,
  structureEnabledFor,
} from '../../config/trading-flags.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const BAR = 15 * 60 * 1000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
const TODAY = '2026-01-20';

// The same fabricated scenario as structure-engine.test.ts, condensed.
function bars(extra: MomentumBar[] = []): MomentumBar[] {
  const out: MomentumBar[] = [];
  let prev = 100.5;
  const push = (time: number, open: number, close: number) => {
    out.push({ time, open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, close, volume: 1000 });
    prev = close;
  };
  for (const d of ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16']) {
    for (let k = 0; k < 25; k++) push(at(d, '09:15') + k * BAR, prev, k % 2 === 0 ? 100 : 100.5);
  }
  const prevCloses = [100, 99.5, 99, 98.5, 98, 97.5, 97.2, 97.5, 98, 98.5, 99, 99.5, 100, 100.5, 101, 101.5, 101.8, 101.5, 101.2, 101.0, 101.2, 101.0, 101.2, 101.0, 101.2];
  prevCloses.forEach((c, k) => push(at('2026-01-19', '09:15') + k * BAR, prev, c));
  [101.3, 101.0, 101.3, 101.0, 101.3, 101.0].forEach((c, k) => push(at(TODAY, '09:15') + k * BAR, prev, c));
  const t = (k: number) => at(TODAY, '10:45') + k * BAR;
  out.push(
    { time: t(0), open: 101.0, high: 102.3, low: 100.9, close: 101.6, volume: 1000 },
    { time: t(1), open: 101.6, high: 101.7, low: 100.1, close: 100.2, volume: 1000 },
    { time: t(2), open: 100.2, high: 100.6, low: 99.9, close: 100.3, volume: 1000 }
  );
  return [...out, ...extra];
}
const V = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-NOGUARD')!;
const evalAt = (b: MomentumBar[], i = b.length - 1) => evaluateStructureSession(prepareMomentumSeries(b), i, V);
const advance = (prev: LiveState | null, b: MomentumBar[], i = b.length - 1, spot: number | null = 100.3) =>
  advanceLiveState({ prev, evaluation: evalAt(b, i), exchange: 'NSE', underlying: 'NIFTY', mode: 'INTRADAY', day: TODAY, now: at(TODAY, '11:31'), spot });

describe('lifecycle state (Redis structure_setup:*)', () => {
  it('lives under its own prefix, never the paper-trade slot', () => {
    expect(structureStateKey('NSE', 'NIFTY', 'INTRADAY')).toBe('structure_setup:NSE:NIFTY:INTRADAY');
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/setup-lifecycle.ts'), 'utf-8');
    expect(src).not.toMatch(/trade_setup:/);
    expect(src).not.toMatch(/INSERT INTO signals/);
    expect(src).toMatch(/INSERT INTO setup_lifecycle_events/);
  });

  it('records each engine transition exactly once across polls', () => {
    const b = bars();
    const first = advance(null, b, b.length - 2); // after the displacement: DEVELOPING
    expect(first.events.filter((e) => e.lifecycleId.includes('BEARISH')).map((e) => e.toState)).toEqual(['DEVELOPING']);
    const again = advance(first.state, b, b.length - 2);
    expect(again.events.filter((e) => !e.lifecycleId.includes('WATCH'))).toHaveLength(0);
    const next = advance(again.state, b); // the gap bar: CONFIRMED
    const confirmed = next.events.filter((e) => e.toState === 'CONFIRMED');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ fromState: 'DEVELOPING', entry: 100.6, t1: 97, poolKind: 'PREV_DAY_HIGH' });
  });

  it('a new session starts empty; a live outcome survives re-reads', () => {
    const b = bars();
    const s1 = advance(null, b).state;
    const lc = s1.lifecycles.find((l) => l.direction === 'BEARISH')!;
    lc.live = { outcome: 'REFUSED', code: 'RISK_OFF', reason: 'x', at: 1 };
    const s2 = advance(s1, b).state;
    expect(s2.lifecycles.find((l) => l.id === lc.id)?.live?.code).toBe('RISK_OFF');
    const tomorrow = advanceLiveState({ prev: s2, evaluation: evalAt(b), exchange: 'NSE', underlying: 'NIFTY', mode: 'INTRADAY', day: '2026-01-21', now: 0, spot: null });
    expect(tomorrow.state.lifecycles.every((l) => l.live == null)).toBe(true);
  });

  it('block and watchlist show the running lifecycle per direction', () => {
    const { state } = advance(null, bars());
    const block = structureBlock(state, { enabled: true, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY' });
    expect(block.current.BEARISH?.stage).toBe('CONFIRMED');
    expect(watchlistRows(state).map((r) => `${r.direction}:${r.stage}`)).toContain('BEARISH:CONFIRMED');
    expect(structureBlock(null, { enabled: true, symbol: 'X', exchange: 'NSE', mode: 'INTRADAY' }).lifecycles).toEqual([]);
  });
});

describe('the fill and its gate', () => {
  const state = advance(null, bars()).state;
  it('a CONFIRMED limit fills when the live price reaches it — and only between stop and T1', () => {
    expect(fillCandidate(state, 100.3, null)).toBeNull(); // below the 100.6 limit (bearish)
    expect(fillCandidate(state, 100.7, null)?.direction).toBe('BEARISH');
    expect(fillCandidate(state, 103, null)).toBeNull(); // through the stop
  });
  it('never offers a lifecycle twice', () => {
    const copy: LiveState = JSON.parse(JSON.stringify(state));
    copy.lifecycles.forEach((l) => (l.live = { outcome: 'MINTED', code: null, reason: null, at: 1 }));
    expect(fillCandidate(copy, 100.7, null)).toBeNull();
  });
  it('STRUCTURE_SEQUENCE: through the stop, at T1, or T1 closer than 1.5R from the fill refuses', () => {
    const lc = state.lifecycles.find((l) => l.direction === 'BEARISH') as LiveLifecycle;
    expect(structureSequenceRefusal(lc, 100.7)).toBeNull();
    expect(structureSequenceRefusal(lc, lc.stop! + 0.01)?.code).toBe('STRUCTURE_SEQUENCE');
    expect(structureSequenceRefusal(lc, 96.9)?.code).toBe('STRUCTURE_SEQUENCE');
    expect(structureSequenceRefusal(lc, 98)?.reason).toMatch(/only .*R away/);
    expect(gateForRefusalCode('STRUCTURE_SEQUENCE')).toBe('STRUCTURE_SEQUENCE');
    expect(classifyRefusal('STRUCTURE_SEQUENCE')).toBe('REFUSED');
  });
  it('the CONFIRMED alert is fresh-only and reads plainly', () => {
    expect(isAlertFresh(1_000_000, 1_000_000 + 10 * 60_000, 30)).toBe(true);
    expect(isAlertFresh(1_000_000, 1_000_000 + 45 * 60_000, 30)).toBe(false);
    const lc = state.lifecycles.find((l) => l.direction === 'BEARISH')!;
    const msg = confirmedMessage(state, lc, (s) => s);
    expect(msg).toMatch(/STRUCTURE CONFIRMED — NIFTY BEARISH/);
    expect(msg).toMatch(/Limit 100.6/);
    expect(msg).toMatch(/never gates/);
  });
});

describe('the shared slot, generalised to families', () => {
  const structureTrade = { direction: 'BEARISH', strategy: STRUCTURE_STRATEGY, structure: { direction: 'BEARISH' as const, sweepExtreme: 102.3, fillAt: at(TODAY, '11:37') } };
  it('a STRUCTURE setup is a trigger trade (exempt from BIAS_REVERSED)', () => {
    expect(TRIGGER_STRATEGIES).toEqual(['MOMENTUM_BREAK', 'STRUCTURE']);
    expect(isTriggerTrade(structureTrade)).toBe(true);
    expect(triggerSlotAction({ stored: structureTrade, trigger: null, lastClosedBar: { time: at(TODAY, '11:30'), close: 100 } })).toEqual({ kind: 'HOLD_TRIGGER' });
  });
  it('SWEEP_RECLAIMED: a bar closing after the fill back beyond the sweep extreme', () => {
    expect(triggerSlotAction({ stored: structureTrade, trigger: null, lastClosedBar: { time: at(TODAY, '11:30'), close: 102.4 } })).toEqual({ kind: 'CLOSE', reason: 'SWEEP_RECLAIMED' });
    // A bar that closed before the fill cannot reclaim it.
    expect(triggerSlotAction({ stored: structureTrade, trigger: null, lastClosedBar: { time: at(TODAY, '11:00'), close: 102.4 } })).toEqual({ kind: 'HOLD_TRIGGER' });
  });
  it('an opposite structure fill closes whatever the slot holds (TRIGGER_REVERSAL)', () => {
    const consensus = { direction: 'BULLISH', strategy: null };
    expect(triggerSlotAction({ stored: consensus, trigger: null, lastClosedBar: null, others: [{ family: 'STRUCTURE', direction: 'BEARISH' }] })).toEqual({ kind: 'CLOSE', reason: 'TRIGGER_REVERSAL' });
    expect(triggerSlotAction({ stored: consensus, trigger: null, lastClosedBar: null, others: [{ family: 'STRUCTURE', direction: 'BULLISH' }] })).toEqual({ kind: 'CONSENSUS_FLOW' });
  });
  it('SWEEP_RECLAIMED is a structural invalidation exit everywhere it is classified', () => {
    expect(exitReasonFromCloseReason('SWEEP_RECLAIMED')).toBe('INVALIDATED');
    expect(invalidationReasonFromCloseReason('SWEEP_RECLAIMED')).toBe('UNDERLYING_STRUCTURAL_INVALIDATION');
  });
  it('the by-strategy splits are three-way', () => {
    expect(strategyFamilyOf({ setupFamily: 'SWEEP_FVG' })).toBe('STRUCTURE');
    expect(strategyFamilyOf({ setupFamily: 'MOMENTUM' })).toBe('MOMENTUM_BREAK');
    expect(strategyFamilyOf({ setupFamily: 'REVERSAL' })).toBe('CONSENSUS');
    expect(strategyFamilyOfSetup({ strategy: 'STRUCTURE' } as any)).toBe('STRUCTURE');
    expect(strategyFamilyOfSetup({ strategy: null } as any)).toBe('CONSENSUS');
  });
});

describe('flags, stamp and schema', () => {
  it('STRUCTURE defaults ON; CONSENSUS_SETUPS follows the failed out-of-sample bar (ON); both env-configurable', () => {
    expect(STRUCTURE_DEFAULT).toBe(true);
    expect(CONSENSUS_SETUPS_DEFAULT).toBe(true);
    expect(readStructureFlag({})).toBe(true);
    expect(readStructureFlag({ STRUCTURE: 'off' })).toBe(false);
    expect(readConsensusSetupsFlag({ CONSENSUS_SETUPS: '0' })).toBe(false);
    expect(readStructureParams({})).toEqual(STRUCTURE_PARAM_DEFAULTS);
    expect(STRUCTURE_PARAM_DEFAULTS).toMatchObject({ STRUCTURE_DISP_MULT: 1, STRUCTURE_OPENING_GUARD: 0 });
  });
  it('STRUCTURE_SYMBOLS: empty = every evaluated symbol; INTRADAY only', () => {
    const all = parseStructureSymbols('');
    expect(all.all).toBe(true);
    expect(structureEnabledFor('BSE', 'NSE', 'INTRADAY', true, all)).toBe(true);
    expect(structureEnabledFor('BSE', 'NSE', 'POSITIONAL', true, all)).toBe(false);
    expect(structureEnabledFor('BSE', 'NSE', 'INTRADAY', false, all)).toBe(false);
    const some = parseStructureSymbols('NIFTY:NSE');
    expect(structureEnabledFor('NIFTY', 'NSE', 'INTRADAY', true, some)).toBe(true);
    expect(structureEnabledFor('GOLD', 'MCX', 'INTRADAY', true, some)).toBe(false);
  });
  it('the structure version is stamped only while its flag is on', () => {
    const extras = (enabled: boolean) => ({
      structure: { enabled, consensusSetups: true, params: STRUCTURE_PARAM_DEFAULTS, symbols: { all: true, symbols: [] } },
      fnoValidation: { enabled: true, params: FNO_VALIDATION_PARAM_DEFAULTS },
    });
    const on = logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS, COVERAGE_LAG_FLAG_DEFAULTS, COVERAGE_LAG_PARAM_DEFAULTS, [], false, MOMENTUM_BREAK_PARAM_DEFAULTS, [], extras(true));
    expect(on.logicVersion).toBe(STRUCTURE_LOGIC_VERSION);
    expect(STRUCTURE_LOGIC_VERSION).toBe('2026-09-29.structure.1');
    expect(on.structure?.consensusSetups).toBe(true);
    const off = logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS, COVERAGE_LAG_FLAG_DEFAULTS, COVERAGE_LAG_PARAM_DEFAULTS, [], false, MOMENTUM_BREAK_PARAM_DEFAULTS, [], extras(false));
    expect(off.logicVersion).toBe(LOGIC_VERSION);
    expect(liveLogicStamp().logicVersion).toBe(STRUCTURE_LOGIC_VERSION);
  });
  it('CONSENSUS_OFF is classified as not eligible', () => {
    expect(classifyRefusal('CONSENSUS_OFF')).toBe('NOT_ELIGIBLE');
  });
  it('migration 027 is idempotent, registered for boot, and keeps lifecycle rows out of signals', () => {
    const sqlText = readFileSync(path.join(REPO_ROOT, 'database/init/027_setup_lifecycle.sql'), 'utf-8');
    const statements = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const st of statements) expect(st).toMatch(/IF NOT EXISTS/);
    expect(sqlText).toMatch(/CREATE TABLE IF NOT EXISTS setup_lifecycle_events/);
    expect(sqlText).not.toMatch(/\bsignals\b\s*\(/);
    const ensure = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/ensure-capture-schema.ts'), 'utf-8');
    expect(ensure).toContain("'027_setup_lifecycle.sql'");
  });
  it('the decision log carries positioningBaseline and regimeSource (F6)', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    const logCalls = src.split('logDecision({').slice(1);
    expect(logCalls.length).toBeGreaterThanOrEqual(4);
    const withF6 = logCalls.filter((c) => c.slice(0, 1200).includes('regimeSource: entryContext?.regimeSource ?? null'));
    expect(withF6.length).toBeGreaterThanOrEqual(4);
  });
});
