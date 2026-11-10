// OI trap history (10 Nov): the chain snapshot 12-20 minutes old, closest to 15, feeds the OI trap's change reads.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/db.js', () => ({ sql: () => { throw new Error('no SQL'); } }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
const { oiTrapHistory, resetOiTrapHistory } = await import('../option-chain.js');

const strikes = (put: number) => [{ strike: 8500, distanceFromSpot: 0, call: { oi: 900 } as never, put: { oi: put } as never }];
const M = 60_000;

describe('oiTrapHistory', () => {
  it('returns the snapshot nearest 15 minutes old within 12-20 minutes, none before', () => {
    resetOiTrapHistory();
    const k = 'MCX:CRUDEOIL:2026-11-17';
    expect(oiTrapHistory(k, 0, 8250, strikes(2000))).toBeNull();
    oiTrapHistory(k, 5 * M, 8260, strikes(2010));
    oiTrapHistory(k, 9 * M, 8270, strikes(2020));
    expect(oiTrapHistory(k, 11 * M, 8280, strikes(2030))).toBeNull(); // nothing 12-20 min old yet
    expect(oiTrapHistory(k, 21 * M, 8300, strikes(2040))).toMatchObject({ at: 5 * M, spot: 8260 }); // 16 min old beats 12 and 21
    expect(oiTrapHistory(k, 21 * M + 5_000, 8301, strikes(2040))).toMatchObject({ at: 5 * M }); // < 10 s since the last: not stored again
  });
});
