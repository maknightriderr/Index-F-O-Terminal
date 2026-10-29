import { expect, it } from 'vitest';
import type { StrategyValidationRow } from '@fno/shared';
import { strategyValidationCsv } from '../strategy-validation-csv';
it('exports missing values as blank and preserves losses without enabling formulas in recorded text', () => {
  const row = { strategy: '=1+1', logicVersion: 'v,"1"', sourceVersion: 'old', netR: -3.98, profitFactor: null } as StrategyValidationRow;
  const csv = strategyValidationCsv([row]);
  expect(csv).toContain('"\'=1+1"');
  expect(csv).toContain('"v,""1"""');
  expect(csv).toContain('"-3.98"');
  expect(csv).not.toContain('null');
});
