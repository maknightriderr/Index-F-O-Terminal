// ============================================================
// History fetcher — interval, per-exchange chunking, file names,
// truncation check. Pure helpers only; nothing here touches the network.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  chunkDaysFor,
  chunkLooksTruncated,
  chunkRange,
  MAX_CHUNK_DAYS,
  MCX_5M_CHUNK_DAYS,
  parseFetchArgs,
  snapshotFileName,
} from '../fetch-history.js';

const DAY = 24 * 60 * 60 * 1000;

describe('fetch-history interval support', () => {
  it('15m keeps its shipped 60-day chunks on every exchange', () => {
    for (const ex of ['NSE', 'BSE', 'MCX'] as const) expect(chunkDaysFor(ex, 'FIFTEEN_MINUTE')).toBe(MAX_CHUNK_DAYS);
  });

  it('5m chunks: NSE/BSE 60 days, MCX 40 days', () => {
    expect(chunkDaysFor('NSE', 'FIVE_MINUTE')).toBe(60);
    expect(chunkDaysFor('BSE', 'FIVE_MINUTE')).toBe(60);
    expect(chunkDaysFor('MCX', 'FIVE_MINUTE')).toBe(40);
    expect(MCX_5M_CHUNK_DAYS).toBe(40);
  });

  it('a 6-month MCX 5m range splits into 40-day windows that never overlap', () => {
    const to = new Date('2026-09-29T18:00:00Z');
    const from = new Date(to.getTime() - 6 * 30.5 * DAY);
    const chunks = chunkRange(from, to, chunkDaysFor('MCX', 'FIVE_MINUTE'));
    expect(chunks.length).toBe(5);
    for (const c of chunks) expect(c.to.getTime() - c.from.getTime()).toBeLessThanOrEqual(40 * DAY);
    for (let k = 1; k < chunks.length; k++) expect(chunks[k].from.getTime()).toBeGreaterThan(chunks[k - 1].to.getTime());
    expect(chunks.at(-1)!.to.getTime()).toBe(to.getTime());
  });

  it('5m files get a .5m suffix; 15m files keep their names', () => {
    expect(snapshotFileName('NIFTY_INDEX')).toBe('NIFTY_INDEX.json');
    expect(snapshotFileName('NIFTY_INDEX', 'FIFTEEN_MINUTE')).toBe('NIFTY_INDEX.json');
    expect(snapshotFileName('NIFTY_INDEX', 'FIVE_MINUTE')).toBe('NIFTY_INDEX.5m.json');
    expect(snapshotFileName('CRUDEOIL', 'FIVE_MINUTE')).toBe('CRUDEOIL.5m.json');
  });

  it('flags a chunk whose first bar starts well after the chunk start (the broker kept only the newest bars)', () => {
    const from = new Date('2026-06-01T03:30:00Z');
    expect(chunkLooksTruncated(from, '2026-06-01T09:15:00+05:30', 3000)).toBe(false);
    // A weekend / holiday lead is fine.
    expect(chunkLooksTruncated(from, '2026-06-04T09:15:00+05:30', 3000)).toBe(false);
    expect(chunkLooksTruncated(from, '2026-06-20T09:15:00+05:30', 3000)).toBe(true);
    // An empty chunk is reported by its count, not as truncation.
    expect(chunkLooksTruncated(from, null, 0)).toBe(false);
  });

  it('parses --interval and --months; names are upper-cased', () => {
    expect(parseFetchArgs([])).toEqual({ interval: 'FIFTEEN_MINUTE', months: null, names: new Set() });
    const a = parseFetchArgs(['--interval=5m', '--months=6', 'nifty_index', 'GOLD']);
    expect(a.interval).toBe('FIVE_MINUTE');
    expect(a.months).toBe(6);
    expect([...a.names]).toEqual(['NIFTY_INDEX', 'GOLD']);
    expect(() => parseFetchArgs(['--interval=1m'])).toThrow(/interval/);
    expect(() => parseFetchArgs(['--months=0'])).toThrow(/months/);
  });
});
