import { expect, it } from 'vitest';
import { buildTradeSetup } from '@fno/analytics';
import { fixtureStrikes, ATM, LOT } from './trade-setup-fixtures.js';
const build = (move: number, admission: boolean, extra: any = {}) => buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, .3, null, 5, LOT, 10, { rrGate: false, flags: { structuralStop: true }, payoffAdmission: admission, ...extra });
it('refuses small projected rewards at the original stop and exposes a non-tradeable plan', () => {
  const legacy = build(30, false), guarded = build(30, true, { plan: true });
  expect(legacy.available).toBe(true);
  expect(guarded).toMatchObject({ available: false, noTradeCode: 'REWARD_RISK_TOO_LOW', requiredRiskReward: 1.5 });
  expect(guarded.rrPlan?.stopLoss).toBe(legacy.stopLoss);
  expect(guarded.rrPlan?.target).toBe(legacy.target);
});
it('retains qualifying geometry unchanged instead of increasing targets or tightening stops', () => {
  const legacy = build(200, false), guarded = build(200, true);
  expect(guarded.available).toBe(true);
  expect([guarded.entry, guarded.stopLoss, guarded.target]).toEqual([legacy.entry, legacy.stopLoss, legacy.target]);
});
it('refuses a stop clipped ahead of structural invalidation even if target payoff passes', () => {
  const context = { spot: 25000, nearestBehindLevel: 24800 };
  expect(build(200, false, context)).toMatchObject({ available: true, stopBeforeStructure: true });
  expect(build(200, true, context)).toMatchObject({ available: false, noTradeCode: 'INVALID_TRADE_GEOMETRY', stopBeforeStructure: true });
});
it('enforces the existing higher rich-IV floor without pooling the policy with display-only history', () => {
  expect(build(120, true).available).toBe(true);
  expect(build(120, true, { flags: { structuralStop: true, richIvRr: true }, ivVsHv: 'RICH' })).toMatchObject({ available: false, requiredRiskReward: 2 });
});
it('does not let a displayed rounded 1.50 ratio admit a sub-threshold trade', () => {
  let low = 30, high = 200;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (build(mid, true).available) high = mid; else low = mid;
  }
  const below = build(low - .0001, true, { plan: true });
  expect(below).toMatchObject({ available: false, noTradeCode: 'REWARD_RISK_TOO_LOW' });
  expect(below.rrPlan?.riskRewardNet).toBe(1.5);
  expect(build(high + .0001, true).available).toBe(true);
});
