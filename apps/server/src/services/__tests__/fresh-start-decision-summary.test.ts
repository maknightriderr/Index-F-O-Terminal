import { describe, expect, it } from 'vitest';
import { istDayStart } from '../fresh-start/decision-summary.js';

describe('fresh-start decision summary window', () => {
  it('starts at 00:00 IST of the current Indian day', () => {
    expect(istDayStart(Date.parse('2026-11-02T12:00:00Z')).toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(istDayStart(Date.parse('2026-11-01T19:00:00Z')).toISOString()).toBe('2026-11-01T18:30:00.000Z');
  });
});
