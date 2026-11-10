// Owner, 10 Nov: an uncertain DATA release blocks ±30 min (±15 min when another row of the same release is confirmed);
// an uncertain speech keeps ±2 h. Fixture: the 10 Nov US CPI rows (13:30Z).
import { describe, expect, it } from 'vitest';
import { FreshFreeGlobalEvents } from '../fresh-start/free-global-events.js';

const AT = Date.parse('2026-11-10T13:30:00Z'), M = 60_000;
const row = (id: string, title: string, uncertain: boolean, at = AT, currency = 'USD') => ({ id, at, currency, title, status: 'scheduled', movedFrom: null, uncertain });
function source(events: ReturnType<typeof row>[], now: number) {
  const s = new FreshFreeGlobalEvents() as any;
  s.now = () => now; s.qualifiedAt = now - 1;
  s.snapshot = { id: 'x', fetchedAt: now - 1, expiresAt: now + 3_600_000, events, uncertainDays: [] };
  return s as FreshFreeGlobalEvents;
}
const blocked = (events: ReturnType<typeof row>[], now: number) => source(events, now).blocking(now, 'COMMODITY').length > 0;

describe('free global event window', () => {
  const cpi = [row('1', 'Consumer Price Index MoM', false), row('2', 'Consumer Price Index YoY', true)];
  it('CPI with one confirmed row blocks ±15 min only', () => {
    expect(blocked(cpi, AT - 90 * M)).toBe(false); // 17:30 IST: was blocked under ±2 h
    expect(blocked(cpi, AT - 10 * M)).toBe(true);
    expect(blocked(cpi, AT + 20 * M)).toBe(false);
  });
  it('an uncertain data release alone blocks ±30 min', () => {
    const only = [row('2', 'Consumer Price Index YoY', true)];
    expect(blocked(only, AT - 25 * M)).toBe(true);
    expect(blocked(only, AT - 45 * M)).toBe(false);
  });
  it('an uncertain speech keeps ±2 h', () => {
    expect(blocked([row('3', "Fed's Chair Powell speech", true)], AT - 100 * M)).toBe(true);
  });
});
