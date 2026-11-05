import { describe, expect, it } from 'vitest';
import type { FreshBar } from '@fno/analytics';
import { fillFreshGaps } from '../fresh-start/context.js';

const open = Date.parse('2026-11-02T09:00:00+05:30'); // MCX session open
const bar = (min: number, close: number, availableAt = open + (min + 1) * 60000): FreshBar => ({ time: open + min * 60000, availableAt, open: close, high: close + 1, low: close - 1, close, volume: 10 });

describe('no-trade gap filling (2 Nov: MISSING_BARS was the top refusal)', () => {
  it('fills a short gap with flat zero-volume bars at the previous close, available only when the next bar was', () => {
    const out = fillFreshGaps([bar(0, 100), bar(3, 105)], 60000, 'MCX');
    expect(out.map((b) => (b.time - open) / 60000)).toEqual([0, 1, 2, 3]);
    expect(out[1]).toMatchObject({ open: 100, high: 100, low: 100, close: 100, volume: 0, availableAt: bar(3, 105).availableAt });
  });
  it('leaves a gap with a price jump (an outage) and the tail unfilled', () => {
    const out = fillFreshGaps([bar(0, 100), bar(10, 105)], 60000, 'MCX');
    expect(out).toHaveLength(2);
  });
  it('fills a long quiet gap (thin futures, 5 Nov) only while the price did not jump across it, up to an hour', () => {
    expect(fillFreshGaps([bar(0, 100), bar(30, 100.2)], 60000, 'MCX')).toHaveLength(31);
    expect(fillFreshGaps([bar(0, 100), bar(61, 100)], 60000, 'MCX')).toHaveLength(62);
    expect(fillFreshGaps([bar(0, 100), bar(62, 100)], 60000, 'MCX')).toHaveLength(2);
    const five = (k: number, c: number): FreshBar => ({ time: open + k * 300000, availableAt: open + (k + 1) * 300000, open: c, high: c, low: c, close: c, volume: 1 });
    expect(fillFreshGaps([five(0, 100), five(8, 100.3)], 300000, 'MCX')).toHaveLength(9);
    expect(fillFreshGaps([five(0, 100), five(8, 101)], 300000, 'MCX')).toHaveLength(2);
  });
  it('fills a quiet opening minute from the first traded price when nothing earlier is loaded', () => {
    const out = fillFreshGaps([bar(2, 101)], 60000, 'MCX');
    expect(out.map((b) => (b.time - open) / 60000)).toEqual([0, 1, 2]);
    expect(out[0]).toMatchObject({ close: 101, volume: 0 });
  });
  it('allows at most 2 missing five-minute bars', () => {
    const five = (k: number, c: number): FreshBar => ({ time: open + k * 300000, availableAt: open + (k + 1) * 300000, open: c, high: c, low: c, close: c, volume: 1 });
    expect(fillFreshGaps([five(0, 1), five(3, 2)], 300000, 'MCX')).toHaveLength(4);
    expect(fillFreshGaps([five(0, 1), five(4, 2)], 300000, 'MCX')).toHaveLength(2); // a 100% jump: not quiet
  });
});
