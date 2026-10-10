import { describe, expect, it } from 'vitest';
import { MISSING, formatAge, formatArrowPercent, formatHold, formatIstTime, formatNumber, formatR, formatRate, formatRupees, formatSignedPercent } from '../format';

describe('format: unknown is never 0', () => {
  it.each([null, undefined, NaN])('shows an em dash for %s', (v) => {
    expect(formatSignedPercent(v as number)).toBe(MISSING);
    expect(formatArrowPercent(v as number)).toBe(MISSING);
    expect(formatR(v as number)).toBe(MISSING);
    expect(formatRupees(v as number)).toBe(MISSING);
    expect(formatNumber(v as number)).toBe(MISSING);
    expect(formatHold(v as number)).toBe(MISSING);
    expect(formatAge(v as number)).toBe(MISSING);
  });
  it('keeps a real zero', () => {
    expect(formatSignedPercent(0)).toBe('0.00%');
    expect(formatR(0)).toBe('0.00R');
  });
});

describe('format: signs', () => {
  it('never doubles the sign (the old "▲ ++1.30%")', () => {
    expect(formatArrowPercent(1.3)).toBe('▲ 1.30%');
    expect(formatArrowPercent(-0.45)).toBe('▼ 0.45%');
    expect(formatArrowPercent(1.3)).not.toContain('+');
    expect(formatSignedPercent(1.3)).toBe('+1.30%');
    expect(formatSignedPercent(-1.3)).toBe('-1.30%');
  });
  it('formats R and rupees', () => {
    expect(formatR(0.371)).toBe('+0.37R');
    expect(formatR(-1.034)).toBe('-1.03R');
    expect(formatRupees(1234.5)).toBe('₹1,234.50');
    expect(formatRupees(1234.5, { signed: true })).toBe('+₹1,234.50');
    expect(formatRupees(-5)).toBe('-₹5.00');
  });
});

describe('format: time and rates', () => {
  it('names the IST zone', () => {
    // 2026-10-13 05:30 UTC = 11:00 IST
    expect(formatIstTime(Date.UTC(2026, 9, 13, 5, 30, 0))).toBe('11:00:00 IST');
    expect(formatIstTime(null)).toBe(MISSING);
  });
  it('formats ages and holds', () => {
    expect(formatAge(42_000)).toBe('42 s ago');
    expect(formatAge(5 * 60_000)).toBe('5 min ago');
    expect(formatHold(45)).toBe('45 min');
    expect(formatHold(125)).toBe('2 h 5 min');
  });
  it('always shows the denominator and refuses to divide by zero', () => {
    expect(formatRate(50, 65)).toBe('76.9% (50 of 65)');
    expect(formatRate(0, 0)).toBe(MISSING);
  });
});
