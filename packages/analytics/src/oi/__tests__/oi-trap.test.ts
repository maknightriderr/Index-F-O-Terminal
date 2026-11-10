// OI trapping (10 Nov, owner): a trap needs spot at / through the wall, moving into it, and the wall's OI falling.
import { describe, expect, it } from 'vitest';
import type { OptionChainStrike } from '@fno/shared';
import { analyzeOiTrap } from '../index.js';

const leg = (oi: number) => ({ oi } as unknown as NonNullable<OptionChainStrike['call']>);
const chain = (rows: Array<[number, number, number]>): OptionChainStrike[] => rows.map(([strike, callOi, putOi]) => ({ strike, distanceFromSpot: 0, call: leg(callOi), put: leg(putOi) }));
// CRUDEOIL-like: the put wall at 8500 was written before yesterday's fall; spot is now 8300.
const now = chain([[8200, 100, 400], [8300, 300, 600], [8400, 500, 700], [8500, 900, 2000], [8600, 1200, 300]]);
const hist = (spot: number, put8500: number, call8600 = 1200) => ({ at: 0, spot, oi: [{ strike: 8500, callOi: 900, putOi: put8500 }, { strike: 8600, callOi: call8600, putOi: 300 }] });

describe('analyzeOiTrap', () => {
  it('spot below the put wall but rising = RECOVERING, never a downside trap (the 10 Nov CRUDEOIL case)', () => {
    const t = analyzeOiTrap(now, 8300, hist(8250, 2000));
    expect(t.put).toMatchObject({ active: false, state: 'RECOVERING', strike: 8500, spotMovePct: 0.61 });
    expect(t.summary).toContain('not a downside signal');
  });
  it('spot falling through the put wall with its OI unwinding >= 5% = TRAPPED', () => {
    const t = analyzeOiTrap(now, 8480, hist(8560, 2200));
    expect(t.put).toMatchObject({ active: true, state: 'TRAPPED', wallOiChangePct: -9.09 });
    expect(t.summary).toContain('accelerate downside');
  });
  it('spot falling into the put wall while its OI grows = DEFENDED', () => {
    expect(analyzeOiTrap(now, 8490, hist(8560, 1800)).put).toMatchObject({ active: false, state: 'DEFENDED', wallOiChangePct: 11.11 });
  });
  it('call side mirrors: rising through the call wall with its OI falling = TRAPPED', () => {
    expect(analyzeOiTrap(now, 8610, hist(8540, 2000, 1400)).call).toMatchObject({ active: true, state: 'TRAPPED' });
  });
  it('no chain from ~15 min ago: nothing active (NO_HISTORY); away from the walls: CLEAR', () => {
    expect(analyzeOiTrap(now, 8480, null).put).toMatchObject({ active: false, state: 'NO_HISTORY' });
    expect(analyzeOiTrap(now, 8550, null).put).toMatchObject({ active: false, state: 'CLEAR' });
  });
});
