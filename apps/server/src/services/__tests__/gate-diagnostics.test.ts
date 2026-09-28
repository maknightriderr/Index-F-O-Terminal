import { describe, it, expect } from 'vitest';
import {
  evaluateGateDiagnostics,
  firstFailingGate,
  gateForRefusalCode,
  LIVE_CHAIN_GATES,
  type GateEvaluationInputs,
} from '../gate-diagnostics.js';

// The live thresholds are passed in by market-bias.ts; these mirror today's
// values only so the fixtures read naturally. The module holds no copy.
const THRESHOLDS = {
  minSetupConfidence: 75,
  openingSettleMinutes: 5,
  openingGuardMinutes: 60,
  postLossSettleMinutes: 15,
  postLossMinConfidence: 80,
  maxSameDirectionLossesPerDay: 2,
};

function base(overrides: Partial<GateEvaluationInputs> = {}): GateEvaluationInputs {
  return {
    direction: 'BULLISH',
    mode: 'INTRADAY',
    confidence: 82,
    riskOffReason: null,
    feedBlockReason: null,
    sessionRefusal: null,
    minutesSinceOpen: 120,
    positioningRefusal: null,
    positioningVotes: { futuresOi: 1, pcr: 0, optionOiFlow: 1 },
    losingClose: { settleTtlSeconds: -2, lostToday: false, sameDirectionLossCount: 0, sameSideCooldownTtlSeconds: -2 },
    reliability: { evaluated: true, reason: null },
    liveRefusalCode: null,
    thresholds: THRESHOLDS,
    ...overrides,
  };
}

/**
 * A re-statement of the live `??` chain's ORDER over the same inputs, used
 * only to derive what the live refusal would be for a fixture. The test then
 * checks the diagnostic agrees with it and never changes it.
 */
function liveChainCode(i: GateEvaluationInputs): string | null {
  if (i.riskOffReason) return 'RISK_OFF';
  if (i.feedBlockReason) return 'NO_QUOTE';
  if (i.sessionRefusal) return i.sessionRefusal.code;
  if (i.confidence < i.thresholds.minSetupConfidence) return 'LOW_SETUP_QUALITY';
  if (i.positioningRefusal) return 'POSITIONING_CONFLICT';
  const lc = i.losingClose;
  if (lc && i.direction !== 'NEUTRAL') {
    if (lc.settleTtlSeconds > 0) return 'POST_LOSS_COOLDOWN';
    if (lc.lostToday && i.confidence < i.thresholds.postLossMinConfidence) return 'POST_LOSS_COOLDOWN';
    if (lc.sameDirectionLossCount >= i.thresholds.maxSameDirectionLossesPerDay) return 'DIRECTION_LOCKED';
    if (lc.sameSideCooldownTtlSeconds > 0) return 'SAME_SYMBOL_SIDE';
  }
  if (i.reliability.evaluated && i.reliability.reason) return 'RELIABILITY_FILTER';
  return null;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

describe('gate diagnostics — observation only', () => {
  it('produces exactly one row per live-chain gate per decision', () => {
    const rows = evaluateGateDiagnostics(base(), 1_000);
    expect(rows).toHaveLength(LIVE_CHAIN_GATES.length);
    expect(new Set(rows.map((r) => r.gate))).toEqual(new Set(LIVE_CHAIN_GATES));
    for (const r of rows) {
      expect(['PASS', 'FAIL', 'NOT_EVALUATED']).toContain(r.status);
      expect(r.timestamp).toBe(1_000);
      expect(r.input_values).toBeTypeOf('object');
    }
  });

  it('all gates pass on a clean decision, and none is marked deciding', () => {
    const rows = evaluateGateDiagnostics(base(), 1);
    expect(rows.every((r) => r.status === 'PASS')).toBe(true);
    expect(rows.some((r) => r.was_deciding_gate)).toBe(false);
    expect(firstFailingGate(rows)).toBeNull();
  });

  it('shows every gate that would have refused, not only the first', () => {
    const inputs = base({
      riskOffReason: 'Trading is switched off manually (test).',
      confidence: 60,
      positioningRefusal: { code: 'POSITIONING_CONFLICT', reason: 'all against' },
      losingClose: { settleTtlSeconds: 300, lostToday: true, sameDirectionLossCount: 2, sameSideCooldownTtlSeconds: 900 },
      reliability: { evaluated: false, reason: null }, // live chain skips it while RISK_OFF holds
    });
    inputs.liveRefusalCode = liveChainCode(inputs);
    const rows = evaluateGateDiagnostics(inputs, 1);
    const status = Object.fromEntries(rows.map((r) => [r.gate, r.status]));
    expect(status).toMatchObject({
      RISK_OFF: 'FAIL',
      NO_QUOTE: 'PASS',
      OPENING_HOUR: 'PASS',
      LOW_SETUP_QUALITY: 'FAIL',
      POSITIONING_CONFLICT: 'FAIL',
      POST_LOSS_COOLDOWN: 'FAIL',
      DIRECTION_LOCKED: 'FAIL',
      SAME_SYMBOL_SIDE: 'FAIL',
      RELIABILITY_FILTER: 'NOT_EVALUATED',
    });
    // Exactly one deciding gate, and it is the one the live chain chose.
    const deciding = rows.filter((r) => r.was_deciding_gate);
    expect(deciding).toHaveLength(1);
    expect(deciding[0].gate).toBe('RISK_OFF');
  });

  it('never alters the live refusal: the first failing gate matches the live chain for every single-gate fixture', () => {
    const fixtures: Partial<GateEvaluationInputs>[] = [
      { riskOffReason: 'off' },
      { feedBlockReason: 'stale quote' },
      { sessionRefusal: { code: 'OPENING_HOUR', reason: 'settling' }, minutesSinceOpen: 20 },
      { sessionRefusal: { code: 'MARKET_CLOSED', reason: 'closed' }, minutesSinceOpen: null },
      { confidence: 74 },
      { positioningRefusal: { code: 'POSITIONING_CONFLICT', reason: 'x' }, positioningVotes: { futuresOi: -1, pcr: -1, optionOiFlow: -1 } },
      { losingClose: { settleTtlSeconds: 120, lostToday: true, sameDirectionLossCount: 0, sameSideCooldownTtlSeconds: 0 } },
      { confidence: 78, losingClose: { settleTtlSeconds: 0, lostToday: true, sameDirectionLossCount: 0, sameSideCooldownTtlSeconds: 0 } },
      { losingClose: { settleTtlSeconds: 0, lostToday: false, sameDirectionLossCount: 2, sameSideCooldownTtlSeconds: 0 } },
      { losingClose: { settleTtlSeconds: 0, lostToday: false, sameDirectionLossCount: 0, sameSideCooldownTtlSeconds: 600 } },
      { reliability: { evaluated: true, reason: 'ex-date tomorrow' } },
    ];
    for (const f of fixtures) {
      const inputs = base(f);
      const live = liveChainCode(inputs);
      inputs.liveRefusalCode = live;
      const snapshot = JSON.stringify(inputs);
      const frozen = deepFreeze(inputs);

      const rows = evaluateGateDiagnostics(frozen, 1);

      // Inputs are untouched — the diagnostic reads, it does not write.
      expect(JSON.stringify(frozen)).toBe(snapshot);
      // The refusal code it was handed is still exactly what the live chain produced.
      expect(frozen.liveRefusalCode).toBe(live);
      // And the independent evaluation agrees with the live chain's answer.
      expect(firstFailingGate(rows)).toBe(gateForRefusalCode(live));
      expect(rows.filter((r) => r.was_deciding_gate).map((r) => r.gate)).toEqual([gateForRefusalCode(live)]);
    }
  });

  it('says NOT_EVALUATED rather than PASS when a gate had no input', () => {
    const rows = evaluateGateDiagnostics(base({ direction: 'NEUTRAL', positioningVotes: null, losingClose: null }), 1);
    const status = Object.fromEntries(rows.map((r) => [r.gate, r.status]));
    expect(status.POSITIONING_CONFLICT).toBe('NOT_EVALUATED');
    expect(status.POST_LOSS_COOLDOWN).toBe('NOT_EVALUATED');
    expect(status.DIRECTION_LOCKED).toBe('NOT_EVALUATED');
    expect(status.SAME_SYMBOL_SIDE).toBe('NOT_EVALUATED');
  });

  it('maps MARKET_CLOSED onto the session (OPENING_HOUR) gate', () => {
    expect(gateForRefusalCode('MARKET_CLOSED')).toBe('OPENING_HOUR');
    expect(gateForRefusalCode('RISK_OFF')).toBe('RISK_OFF');
    expect(gateForRefusalCode(null)).toBeNull();
    expect(gateForRefusalCode('SOMETHING_ELSE')).toBeNull();
  });
});
