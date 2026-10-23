import { describe, it, expect } from 'vitest';
import { experimentRollbackBlockers } from '../experiment-rollback.js';
import { armFor } from '../experiment-arms.js';

describe('V2 compatibility and conservative downgrade readiness', () => {
  it.each(['IND-V2-INVALIDATION-1.0', 'IND-V2-INVALIDATION-1.1'])('keeps the reader for %s', (version) => {
    expect(armFor('V2', version)?.invalidationExit).toBe(true);
  });
  const row = { id: 'v2', arm: 'V2', arm_version: 'IND-V2-INVALIDATION-1.1', official_status: 'CLOSED', sim_status: 'CLOSED' };
  it.each([
    ['OPEN', 'OPEN'], ['OPEN', 'NOT_OPENED'], ['CLOSED', 'OPEN'], ['CLOSED', 'EXIT_PENDING'],
    ['UNKNOWN', 'CLOSED'], ['CLOSED', 'UNKNOWN'], [null, 'CLOSED'], ['CLOSED', null],
  ])('blocks downgrade for official=%s, simulation=%s', (official_status, sim_status) => {
    expect(experimentRollbackBlockers([{ ...row, official_status, sim_status }])).toHaveLength(1);
  });
  it('clears only fully settled or never-simulated positions, without modifying history', () => {
    const rows = [row, { ...row, id: 'old', arm_version: 'IND-V2-INVALIDATION-1.0', sim_status: 'NOT_OPENED' }];
    const before = JSON.stringify(rows);
    expect(experimentRollbackBlockers(rows)).toEqual([]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
