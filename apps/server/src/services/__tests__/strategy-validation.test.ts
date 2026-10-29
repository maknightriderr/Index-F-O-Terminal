import { describe, expect, it } from 'vitest';
import { summarizeStrategyValidation, type ValidationInput } from '../strategy-validation.js';
import { MEASUREMENT_RELIABLE_FROM } from '../measurement-core.js';

const input = (changes: Partial<ValidationInput['trade']> = {}, sourceVersion = 'v1'): ValidationInput => ({
  logicVersion: 'logic1', sourceVersion,
  trade: { id: 't', family: 'OF1', symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', structureType: 'NAKED_LONG',
    mintedAt: MEASUREMENT_RELIABLE_FROM + 3600000, outcome: 'WIN', closeReason: 'TARGET', voided: false, generatedOffSession: false,
    entry: 100, initialStop: 80, target: 101, exitPrice: 101, estimatedCostPct: 2, cost: null, ...changes },
});
const report = (xs: ValidationInput[], complete = true) => summarizeStrategyValidation(xs, ['OF1', 'A3', 'OB1'], complete, 20000, 1);

describe('strategy validation denominators and versions', () => {
  it('classifies WIN labels after costs and includes profitable EXPIRED exits on the same population', () => {
    const r = report([input(), input({ outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 110 }), input({ exitPrice: 102 })]).rows[0];
    expect(r).toMatchObject({ total: 3, measured: 3, profitable: 1, losing: 1, flat: 1, expired: 1, grossR: .65, costR: .3, netR: .35, profitR: .4, lossR: .05, profitFactor: 8, status: 'SMALL_SAMPLE' });
  });
  it('accounts for open, missing cost and excluded records without inventing net values', () => {
    const r = report([input({ outcome: null, exitPrice: null }), input({ estimatedCostPct: null }), input({ voided: true }), input({ exitPrice: null }), input({ estimatedCostPct: -1 })]).rows[0];
    expect(r).toMatchObject({ total: 5, measured: 0, open: 1, missingCost: 2, excluded: 2, netR: null, grossR: null, status: 'NO_MEASURABLE_RESULTS' });
  });
  it('does not pool source versions, modes, exchanges, reliability periods or missing attribution', () => {
    const xs = [input(), input({}, 'v2'), input({ mode: 'POSITIONAL' }), input({ exchange: 'MCX' }), input({ mintedAt: MEASUREMENT_RELIABLE_FROM - 1 }), input({ family: 'UNKNOWN' })];
    expect(report(xs).rows).toHaveLength(6);
    expect(report(xs).rows.some(r => r.strategy === 'UNATTRIBUTED')).toBe(true);
  });
  it('preserves no-data inventory and incomplete history, and never returns infinite PF', () => {
    const empty = report([]);
    expect(empty.inventory).toContain('A3'); expect(empty.rows).toEqual([]);
    expect(report([input({ exitPrice: 110 })], false)).toMatchObject({ complete: false, rows: [{ profitFactor: null, noLosses: true }] });
  });
  it('30 trades in one session are still insufficient; covered positive results remain unproven', () => {
    expect(report(Array.from({ length: 30 }, () => input({ exitPrice: 110 }))).rows[0].status).toBe('SMALL_SAMPLE');
    const xs = Array.from({ length: 30 }, (_, i) => input({ exitPrice: 110, mintedAt: MEASUREMENT_RELIABLE_FROM + i * 86400000 }));
    expect(report(xs).rows[0].status).toBe('POSITIVE_UNPROVEN');
  });
});
