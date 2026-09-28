// ============================================================
// GOLDEN / CHARACTERIZATION TESTS — buildTradeSetup
// ============================================================
// Captured against the code as it stood BEFORE the validation-review fixes
// (origin/main 339e235), before any trade-setup logic was edited. The
// snapshot file under __snapshots__/ is the frozen record of that behaviour.
//
// Every call passes NO validation-review inputs and NO flags, which is
// exactly "all new flags OFF". If any of these snapshots changes, the
// flag-OFF path is no longer byte-identical to the old engine — that is a
// regression, not a snapshot to update.
//
// The case matrix and its fabricated fixtures live in trade-setup-fixtures.ts.
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildTradeSetup } from '@fno/analytics';
import { GOLDEN_CASES } from './trade-setup-fixtures.js';

describe('buildTradeSetup golden outputs (pre-validation-review behaviour, all new flags OFF)', () => {
  it('covers available setups and every reachable refusal code', () => {
    const results = Object.values(GOLDEN_CASES).map((c) => buildTradeSetup(...c()));
    const codes = new Set(results.map((r) => (r.available ? 'AVAILABLE' : r.noTradeCode ?? 'NO_CODE')));
    // A matrix that only exercised one branch would prove very little.
    for (const expected of ['AVAILABLE', 'REWARD_RISK_TOO_LOW', 'COST_EXCEEDS_EDGE', 'LOW_SETUP_QUALITY', 'NEUTRAL_BIAS', 'NO_QUOTE', 'WIDE_SPREAD', 'LOW_OPTION_LIQUIDITY', 'UNREALISTIC_TARGET']) {
      expect(codes, `branch ${expected}`).toContain(expected);
    }
  });

  for (const [name, args] of Object.entries(GOLDEN_CASES)) {
    it(name, () => {
      expect(buildTradeSetup(...args())).toMatchSnapshot();
    });
  }
});
