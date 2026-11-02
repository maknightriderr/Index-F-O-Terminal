import { describe, expect, it } from 'vitest';
import type { Instrument } from '@fno/shared';
import { discoverFreshMarkets, freshIndexKey } from '../fresh-start/markets.js';
import { freshOperationalEvidence } from '../fresh-start/operational-evidence.js';
import { freshAdapterState } from '../fresh-start/adapter-state.js';
import { FRESH_BOOK_ROTATION_MS } from '../fresh-start/worker.js';

const day = '2026-10-30';
const ins = (o: Partial<Instrument>): Instrument => ({ token: '1', symbol: 'X', name: 'X', exchange: 'NSE', segment: 'FO', instrumentType: 'FUTIDX', expiry: '2026-11-24', lotSize: 20, tickSize: 0.05, isFnO: true, ...o });

describe('2 Nov audit follow-ups', () => {
  it('finds a BSE index spot whose master name differs only by spacing (SENSEX50 vs "SENSEX 50")', () => {
    expect(freshIndexKey('SENSEX 50')).toBe('SENSEX50');
    const master = [
      ins({ token: '10', name: 'SENSEX50', symbol: 'SENSEX50FUT', exchange: 'BSE' }),
      ins({ token: '11', name: 'SENSEX50', symbol: 'SENSEX50CE', exchange: 'BSE', instrumentType: 'OPTIDX', optionType: 'CE', strike: 25000, expiry: '2026-11-03' }),
      ins({ token: '99919999', name: 'SENSEX 50', symbol: 'SENSEX 50', exchange: 'BSE', segment: 'CM', instrumentType: 'INDEX', expiry: undefined, lotSize: 1 }),
    ];
    const ref = discoverFreshMarkets(master, day).references.find((r) => r.name === 'SENSEX50');
    expect(ref?.spot).toEqual({ token: '99919999', exchangeSegment: 'BSE_CM' });
  });
  it('admits an unmapped stock into one shared conservative risk group instead of blocking it', () => {
    const master = [
      ins({ token: '20', name: 'ZZUNMAPPED', symbol: 'ZZUNMAPPED-EQ', segment: 'CM', instrumentType: 'EQ', expiry: undefined, lotSize: 1 }),
      ins({ token: '21', name: 'ZZUNMAPPED', symbol: 'ZZCE', instrumentType: 'OPTSTK', optionType: 'CE', strike: 100 }),
    ];
    const ref = discoverFreshMarkets(master, day).references.find((r) => r.name === 'ZZUNMAPPED')!;
    expect(ref.riskGroup).toBe('NSE_SECTOR:UNMAPPED');
    expect(ref.capabilityBlockers).not.toContain('BLOCKED_SECTOR_MAPPING');
  });
  it('logs which references are waiting and on what', () => {
    const state = { ...freshAdapterState, referenceBlockers: [{ id: 'a', name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', codes: ['WAITING_FOR_EXACT_REFERENCES'], signalAgeMs: 4321.4, spotAgeMs: null }, { id: 'b', name: 'TCS', market: 'NSE_STOCK_OPTIONS', codes: [] }] };
    expect(freshOperationalEvidence(state as never).references).toEqual([{ name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', codes: ['WAITING_FOR_EXACT_REFERENCES'], signalAgeMs: 4321, spotAgeMs: null }]);
  });
  it('rotates option books every 2 minutes, not 30 s', () => {
    expect(FRESH_BOOK_ROTATION_MS).toBe(120_000);
  });
});
