import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// 2 Nov: with the evaluator gated behind legacy entries, SENSEX and the MCX workspaces showed "Waiting for the live
// signal engine" all session and ops-monitor raised ENGINE_STALE for them. It must run regardless of legacy entries
// (its legacy setups are vetoed inside market-bias), while the positional stock scan stays legacy-only.
describe('background bias evaluator registration', () => {
  const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
  it('registers backgroundBiasEvaluator outside the legacy-entries gate', () => {
    const gate = source.match(/\.\.\.\(legacyEntriesAllowed\(\) \? \[(.*?)\] : \[\]\)/s);
    expect(gate).not.toBeNull();
    expect(gate![1]).toContain('positionalStockScan');
    expect(gate![1]).not.toContain('backgroundBiasEvaluator');
    expect(source).toContain("timerService('backgroundBiasEvaluator'");
  });
});
