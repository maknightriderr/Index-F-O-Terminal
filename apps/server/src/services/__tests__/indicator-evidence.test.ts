// ============================================================
// INDICATOR ENGINE — confidence is evidence, not a gate (EVIDENCE mode)
// ============================================================
// 1. confidence 74 does not reject an otherwise valid setup;
// 2. confidence 90 does not create a trade by itself;
// 3. risk and cost checks still reject;
// 4. only one indicator decision path runs at runtime (EVIDENCE);
// 5. LEGACY restores the old 75 floor exactly.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTradeSetup } from '@fno/analytics';
import { setupConfidenceRefusal } from '../validation-gates.js';
import {
  INDICATOR_CONFIDENCE_MODE,
  INDICATOR_EVIDENCE_LOGIC_SUFFIX,
  parseIndicatorConfidenceMode,
  logicStamp,
  liveLogicStamp,
  STRUCTURE_LOGIC_VERSION,
  LOGIC_VERSION,
} from '../../config/trading-flags.js';
import { evaluateGateDiagnostics } from '../gate-diagnostics.js';
import { fixtureStrikes, strikesWith, ATM, LOT } from './trade-setup-fixtures.js';

const MIN = 75; // market-bias.ts MIN_SETUP_CONFIDENCE (protected)
const LEGACY_REASON_74 =
  'Confidence 74/100 is below the 75 a setup needs. Below that bar the recorded trades lost 6.6R across 34 of them, and 85% of the weakest band expired without touching either level.';

describe('EVIDENCE: confidence never refuses on its own', () => {
  it('confidence 74 passes the confidence gate; so do 10 and 0', () => {
    for (const c of [74, 10, 0]) expect(setupConfidenceRefusal({ mode: 'EVIDENCE', confidence: c, minConfidence: MIN })).toBeNull();
  });

  it('a valid setup at confidence 60 builds exactly like the same setup at 80 (only the narrative differs)', () => {
    const args = (confidence: number) => [fixtureStrikes(), ATM, 'BULLISH', confidence, 100, undefined, 14, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: 5, confidenceGate: false }] as Parameters<typeof buildTradeSetup>;
    const low = buildTradeSetup(...args(60));
    const high = buildTradeSetup(...args(80));
    expect(high.available).toBe(true);
    expect(low.available).toBe(true);
    const geometry = (s: typeof low) => ({ strike: s.strike, side: s.side, entry: s.entry, stopLoss: s.stopLoss, target: s.target, riskReward: s.riskReward, estimatedCostPct: s.estimatedCostPct });
    expect(geometry(low)).toEqual(geometry(high));
  });
});

describe('confidence does not create a trade', () => {
  it('confidence 90 with no direction is still NEUTRAL_BIAS', () => {
    const s = buildTradeSetup(fixtureStrikes(), ATM, 'NEUTRAL', 90, 100, undefined, null, 3, LOT, null, { confidenceGate: false });
    expect(s).toMatchObject({ available: false, noTradeCode: 'NEUTRAL_BIAS' });
  });
  it('the confidence gate only ever refuses or passes; it never approves a setup', () => {
    expect(setupConfidenceRefusal({ mode: 'EVIDENCE', confidence: 90, minConfidence: MIN })).toBeNull();
    expect(setupConfidenceRefusal({ mode: 'LEGACY', confidence: 90, minConfidence: MIN })).toBeNull();
  });
});

describe('risk and execution checks still reject', () => {
  it('a wide option spread is refused at confidence 90 and at 60', () => {
    for (const confidence of [90, 60]) {
      const s = buildTradeSetup(strikesWith({ ltp: 100, bid: 94, ask: 106, volume: 20000, oi: 300000 }), ATM, 'BULLISH', confidence, 70, undefined, 16, 2, 75, 30, { tickSize: 0.05, expectedHoldHours: 3, confidenceGate: false });
      expect(s.available).toBe(false);
      expect(s.noTradeCode).not.toBe('LOW_SETUP_QUALITY');
    }
  });
  it('a move too small to pay for the risk is refused regardless of confidence', () => {
    const s = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 95, 20, undefined, null, 3, LOT, null, { confidenceGate: false });
    expect(s.available).toBe(false);
    expect(s.noTradeCode).not.toBe('LOW_SETUP_QUALITY');
  });
});

describe('one runtime path: EVIDENCE', () => {
  it('EVIDENCE is the default and the runtime mode', () => {
    expect(parseIndicatorConfidenceMode(undefined).value).toBe('EVIDENCE');
    expect(parseIndicatorConfidenceMode('').value).toBe('EVIDENCE');
    expect(parseIndicatorConfidenceMode('nonsense')).toEqual({ value: 'EVIDENCE', rejected: 'nonsense' });
    expect(INDICATOR_CONFIDENCE_MODE).toBe('EVIDENCE');
  });

  it('the live chain has exactly one confidence decision, through the mode switch, and no inline 75 comparison', () => {
    const src = readFileSync(fileURLToPath(new URL('../market-bias.ts', import.meta.url)), 'utf8');
    expect(src.match(/setupConfidenceRefusal\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/confidence < MIN_SETUP_CONFIDENCE/);
    expect(src).toMatch(/INDICATOR_CONFIDENCE_MODE === 'EVIDENCE' \? \{ confidenceGate: false \}/);
    // The protected constant stays byte-identical for rollback.
    expect(src).toContain('MIN_SETUP_CONFIDENCE = 75');
  });

  it('EVIDENCE trades carry their own logic version; positional stamps are unchanged', () => {
    expect(liveLogicStamp().logicVersion.startsWith(`${STRUCTURE_LOGIC_VERSION}${INDICATOR_EVIDENCE_LOGIC_SUFFIX}`)).toBe(true);
    expect(liveLogicStamp().indicator?.confidenceMode).toBe('EVIDENCE');
    expect(logicStamp().logicVersion).toBe(LOGIC_VERSION);
  });

  it('the gate diagnostics still record the 75 comparison, marked not enforced', () => {
    const rows = evaluateGateDiagnostics(
      {
        direction: 'BULLISH',
        mode: 'INTRADAY',
        confidence: 70,
        riskOffReason: null,
        feedBlockReason: null,
        sessionRefusal: null,
        minutesSinceOpen: 120,
        positioningRefusal: null,
        positioningVotes: null,
        losingClose: null,
        reliability: { evaluated: true, reason: null },
        liveRefusalCode: null,
        thresholds: { minSetupConfidence: 75, confidenceGateEnforced: false, openingSettleMinutes: 5, openingGuardMinutes: 60, postLossSettleMinutes: 15, postLossMinConfidence: 80, maxSameDirectionLossesPerDay: 2 },
      } as never,
      Date.now()
    );
    const row = rows.find((r) => r.gate === 'LOW_SETUP_QUALITY')!;
    expect(row.threshold).toMatchObject({ enforced: false });
    expect(row.reason).toMatch(/not enforced/);
  });
});

describe('LEGACY restores the old 75 floor exactly', () => {
  it('74 is refused with the exact old reason; 75 passes', () => {
    expect(setupConfidenceRefusal({ mode: 'LEGACY', confidence: 74, minConfidence: MIN })).toEqual({ code: 'LOW_SETUP_QUALITY', reason: LEGACY_REASON_74 });
    expect(setupConfidenceRefusal({ mode: 'LEGACY', confidence: 75, minConfidence: MIN })).toBeNull();
    expect(parseIndicatorConfidenceMode('legacy').value).toBe('LEGACY');
  });
  it('the option builder keeps its 65 floor unless told otherwise (the golden snapshots pin this)', () => {
    expect(buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 60, 100, undefined, null, 3, LOT, null, {})).toMatchObject({ available: false, noTradeCode: 'LOW_SETUP_QUALITY' });
  });
  it('a LEGACY stamp has no evidence suffix', () => {
    const stamp = logicStamp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { indicator: { confidenceMode: 'LEGACY' } });
    expect(stamp.logicVersion).toBe(LOGIC_VERSION);
  });
});
