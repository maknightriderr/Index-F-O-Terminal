import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshAngelTime } from '../fresh-start/worker.js';

describe('fresh-start candle request time format (2 Nov audit)', () => {
  it('formats epoch ms as Angel One "YYYY-MM-DD HH:mm" in IST', () => {
    expect(freshAngelTime(Date.parse('2026-11-02T03:45:00Z'))).toBe('2026-11-02 09:15');
    expect(freshAngelTime(Date.parse('2026-11-01T19:00:00Z'))).toBe('2026-11-02 00:30');
  });
  it('never sends ISO timestamps to the candle API (they were rejected with HTTP 400)', () => {
    const src = readFileSync(new URL('../fresh-start/worker.ts', import.meta.url), 'utf8');
    const context = src.slice(src.indexOf('private async context('), src.indexOf('private async context(') + 1200);
    expect(context).not.toContain('toISOString');
    expect(context).toContain('freshAngelTime(');
  });
});
