// ============================================================
// INDICATOR ENGINE — location is measured, executable room is the blocker
// ============================================================
// 1. The location-score calculation is unchanged (pinned).
// 2. A low score alone does not kill a valid candidate in EVIDENCE mode.
// 3. Truly insufficient target room is still refused — by the risk layer.
// 4. Neither confidence nor location is a universal hard gate.
// 5. One runtime path; LEGACY restores the old POOR_LOCATION gate exactly.
// 6. Net R:R is measured from stored decision-time prices only.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTradeSetup } from '@fno/analytics';
import { assessLocation, type StructuralLevel } from '../location-quality.js';
import { locationGateReason, setupConfidenceRefusal, netRiskReward } from '../validation-gates.js';
import {
  INDICATOR_LOCATION_MODE,
  INDICATOR_CONFIDENCE_MODE,
  TRADING_FLAGS,
  TRADING_PARAMS,
  locationGateEnforced,
  parseIndicatorConfidenceMode,
  liveLogicStamp,
  logicStamp,
  LOGIC_VERSION,
  STRUCTURE_LOGIC_VERSION,
} from '../../config/trading-flags.js';
import { fixtureStrikes, ATM, LOT } from './trade-setup-fixtures.js';

const level = (price: number, kind: StructuralLevel['kind'], strengthPct?: number): StructuralLevel => ({ price, kind, ...(strengthPct != null ? { strengthPct } : {}) });

describe('the location score is unchanged', () => {
  const base = { spot: 100, direction: 'BULLISH' as const, atrPoints: 10 };
  it('pins every branch of assessLocation', () => {
    // Cramped (0.5 ATR ahead) −30, close support behind (0.3 ATR) +15 → 35.
    expect(assessLocation({ ...base, levels: [level(105, 'PIVOT'), level(97, 'VWAP')] }).score).toBe(35);
    // Clear air (2.5 ATR ahead) +25 → 75.
    expect(assessLocation({ ...base, levels: [level(125, 'DAY_HIGH')] }).score).toBe(75);
    // Workable (1.2 ATR) +5, nothing behind for 4 ATR −10 → 45.
    expect(assessLocation({ ...base, levels: [level(112, 'PIVOT'), level(60, 'PREV_DAY_LOW')] }).score).toBe(45);
    // A strong OI wall 0.5 ATR ahead: −30 and −15 → 5.
    expect(assessLocation({ ...base, levels: [level(105, 'OI_WALL', 80)] }).score).toBe(5);
    // No level ahead: unknown room → 50.
    expect(assessLocation({ ...base, levels: [] }).score).toBe(50);
    // Bearish mirrors it.
    expect(assessLocation({ ...base, direction: 'BEARISH', levels: [level(95, 'PIVOT')] }).score).toBe(20);
  });
  it('records the measurements behind the score', () => {
    const a = assessLocation({ ...base, levels: [level(105, 'PIVOT'), level(97, 'VWAP')] });
    expect(a).toMatchObject({ aheadAtr: 0.5, behindAtr: 0.3, nearestAhead: { kind: 'PIVOT', price: 105 }, nearestBehind: { kind: 'VWAP', price: 97 } });
    expect(a.reasons[0]).toMatch(/0\.50 ATR under pivot/);
  });
  it('the old threshold stays 40', () => {
    expect(TRADING_PARAMS.LOCATION_GATE_MIN_SCORE).toBe(40);
  });
});

describe('EVIDENCE: a low location score alone does not refuse', () => {
  it('the runtime mode is EVIDENCE and the gate is not enforced', () => {
    expect(INDICATOR_LOCATION_MODE).toBe('EVIDENCE');
    expect(parseIndicatorConfidenceMode(undefined).value).toBe('EVIDENCE');
    expect(locationGateEnforced()).toBe(false);
    expect(locationGateEnforced('EVIDENCE', true)).toBe(false);
  });
  it('a score of 5 passes the location step in EVIDENCE mode', () => {
    expect(locationGateReason({ enabled: locationGateEnforced('EVIDENCE', true), locationScore: 5, minScore: 40, locationReason: 'x' })).toBeNull();
  });
});

describe('insufficient executable room is still refused, by the risk layer', () => {
  it('a target move too short for the stop is refused on reward:risk, at any location', () => {
    const s = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 90, 20, undefined, null, 3, LOT, null, { confidenceGate: false });
    expect(s.available).toBe(false);
    expect(['REWARD_RISK_TOO_LOW', 'COST_EXCEEDS_EDGE', 'UNREALISTIC_TARGET']).toContain(s.noTradeCode);
  });
  it('the same contract with real room builds', () => {
    const s = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 90, 100, undefined, 14, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: 5, confidenceGate: false });
    expect(s.available).toBe(true);
    expect(s.riskReward!).toBeGreaterThanOrEqual(1.5);
  });
});

describe('neither confidence nor location is a universal gate', () => {
  it('both default to EVIDENCE and neither refuses on its own', () => {
    expect(INDICATOR_CONFIDENCE_MODE).toBe('EVIDENCE');
    expect(setupConfidenceRefusal({ mode: 'EVIDENCE', confidence: 40, minConfidence: 75 })).toBeNull();
    expect(locationGateReason({ enabled: locationGateEnforced(), locationScore: 10, minScore: 40 })).toBeNull();
  });
  it('the live chain has one location decision, through the mode switch', () => {
    const src = readFileSync(fileURLToPath(new URL('../market-bias.ts', import.meta.url)), 'utf8');
    expect(src.match(/locationGateReason\(/g)).toHaveLength(1);
    expect(src).toMatch(/locationGateReason\(\{\s*enabled: locationGateEnforced\(\),/);
    expect(src).not.toMatch(/enabled: TRADING_FLAGS\.LOCATION_GATE/);
  });
  it('trades carry both evidence suffixes; positional stamps are unchanged', () => {
    expect(liveLogicStamp().logicVersion).toBe(`${STRUCTURE_LOGIC_VERSION}+indicator-evidence.1+location-evidence.1`);
    expect(liveLogicStamp().indicator).toEqual({ confidenceMode: 'EVIDENCE', locationMode: 'EVIDENCE' });
    expect(logicStamp().logicVersion).toBe(LOGIC_VERSION);
  });
});

describe('LEGACY restores the old POOR_LOCATION gate exactly', () => {
  it('enforced only in LEGACY with LOCATION_GATE on, with the old refusal', () => {
    expect(locationGateEnforced('LEGACY', true)).toBe(true);
    expect(locationGateEnforced('LEGACY', false)).toBe(false);
    expect(TRADING_FLAGS.LOCATION_GATE).toBe(true); // the old switch keeps its default for rollback
    const r = locationGateReason({ enabled: locationGateEnforced('LEGACY', true), locationScore: 35, minScore: 40, locationReason: 'Entering 0.50 ATR under pivot at 105.' });
    expect(r).toEqual({
      code: 'POOR_LOCATION',
      reason: 'Location score 35/100 is below 40 — entering into the level ahead rather than away from support. Entering 0.50 ATR under pivot at 105. Recorded setups below 40 ran a profit factor of 0.93 against 2.35 at 60 and above.',
    });
    expect(locationGateReason({ enabled: true, locationScore: 40, minScore: 40 })).toBeNull();
  });
  it('a LEGACY location stamp has no location suffix', () => {
    const stamp = logicStamp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { indicator: { confidenceMode: 'LEGACY', locationMode: 'LEGACY' } });
    expect(stamp.logicVersion).toBe(LOGIC_VERSION);
  });
});

describe('net R:R is measured from stored decision-time prices', () => {
  it('matches the builder\'s own formula and is below gross', () => {
    const s = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 90, 100, undefined, 14, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: 5, confidenceGate: false });
    const net = netRiskReward(s)!;
    const cost = s.entry! * (s.estimatedCostPct! / 100);
    expect(net).toBeCloseTo((s.target! - s.entry! - cost) / (s.entry! - s.stopLoss! + cost), 2);
    expect(net).toBeLessThan(s.riskReward!);
  });
  it('null without prices, or for a spread', () => {
    expect(netRiskReward({ entry: null, stopLoss: 1, target: 2, estimatedCostPct: 1 })).toBeNull();
    expect(netRiskReward({ structureType: 'SPREAD', entry: 10, stopLoss: 5, target: 20, estimatedCostPct: 1 })).toBeNull();
  });
});
