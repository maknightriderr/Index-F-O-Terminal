// 18 Nov (owner): an ended paper trade never shows as live; every trade carries its date, result and reason.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/db.js', () => ({ sql: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { istDateLabel, paperReasonText, paperResult } from '@fno/shared';
import { endedTradeSetup } from '../read-only-views.js';

const NOV16 = Date.parse('2026-11-16T07:42:00Z'), NOV18 = Date.parse('2026-11-18T06:00:00Z');

describe('paper result', () => {
  it('result from state, reason and net R', () => {
    expect(paperResult({ open: true })).toBe('OPEN');
    expect(paperResult({ open: false, state: 'EXPIRED', closeReason: 'SESSION_ENDED', netR: -0.75 })).toBe('EXPIRED');
    expect(paperResult({ open: false, state: 'WIN', netR: 0.9 })).toBe('PROFIT');
    expect(paperResult({ open: false, state: 'LOSS', netR: -1.1 })).toBe('LOSS');
    expect(paperResult({ open: false, netPnl: -3489 })).toBe('LOSS');
    expect(paperResult({ open: false, state: 'WIN' })).toBe('PROFIT');
    expect(paperReasonText('STOP_LOSS')).toBe('Stop loss hit');
    expect(paperReasonText('SESSION_ENDED')).toMatch(/Session ended/);
    expect(paperReasonText('SOMETHING_NEW')).toBe('Something new');
    expect(paperReasonText(null)).toBeNull();
    expect(istDateLabel(NOV16)).toBe('16 Nov 2026');
  });
});

describe('symbol page: an ended paper trade is not shown as live', () => {
  const held = { available: true, generatedAt: NOV16, signalId: 'abc', strike: 295, side: 'PE' };
  it('an INTRADAY trade from an earlier session is ended, with its date and reason', () => {
    const e = endedTradeSetup(held, 'INTRADAY', NOV18, null)!;
    expect(e.available).toBe(false);
    expect(e.reason).toMatch(/16 Nov 2026/);
    expect(e.reason).toMatch(/EXPIRED/);
    expect(e.reason).toMatch(/Session ended/);
  });
  it('a recorded outcome ends it the same day, with the result', () => {
    const e = endedTradeSetup({ ...held, generatedAt: NOV18 - 3_600_000 }, 'INTRADAY', NOV18, { outcome: 'LOSS', closeReason: 'STOP_LOSS', exitTime: NOV18, netR: null })!;
    expect(e.available).toBe(false);
    expect(e.reason).toMatch(/LOSS — Stop loss hit/);
  });
  it('a live trade of today with no outcome stays live; a positional one is not ended by the date', () => {
    const today = { ...held, generatedAt: NOV18 - 3_600_000 };
    expect(endedTradeSetup(today, 'INTRADAY', NOV18, { outcome: null, closeReason: null, exitTime: null, netR: null })).toBe(today);
    expect(endedTradeSetup(held, 'POSITIONAL', NOV18, null)).toBe(held);
    expect(endedTradeSetup({ available: false }, 'INTRADAY', NOV18, null)).toEqual({ available: false });
  });
});
