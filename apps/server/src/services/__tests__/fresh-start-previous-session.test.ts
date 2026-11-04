import { describe, expect, it } from 'vitest';
import { freshPreviousSessionUsable } from '../fresh-start/context.js';

const s = { open: Date.parse('2026-11-03T03:30:00Z'), close: Date.parse('2026-11-03T18:00:00Z') }; // MCX 09:00–23:30 IST
const bars = (skip: (i: number) => boolean) => Array.from({ length: (s.close - s.open) / 300000 }, (_, i) => i).filter((i) => !skip(i)).map((i) => ({ time: s.open + i * 300000, availableAt: s.open + (i + 1) * 300000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));

describe('previous-session high/low usability (4 Nov: SWEEP_NO_PREVIOUS_SESSION)', () => {
  it('accepts a session with a few no-trade gaps', () => {
    expect(freshPreviousSessionUsable(bars((i) => i % 20 === 7), s)).toBe(true);
  });
  it('refuses a session with too little coverage or a missing start or end', () => {
    expect(freshPreviousSessionUsable(bars((i) => i % 4 === 0), s)).toBe(false);
    expect(freshPreviousSessionUsable(bars((i) => i < 8), s)).toBe(false);
    expect(freshPreviousSessionUsable(bars((i) => i > 165), s)).toBe(false);
    expect(freshPreviousSessionUsable([], s)).toBe(false);
  });
});
