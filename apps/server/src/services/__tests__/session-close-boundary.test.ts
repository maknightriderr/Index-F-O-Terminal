import { describe, it, expect } from 'vitest';
import { isMarketOpen, minutesSinceSessionOpen, type Exchange } from '@fno/shared';
import { closingGuardReason, minutesToSessionClose } from '../validation-gates.js';

const ist = (s: string) => Date.parse(`${s}+05:30`);

// Seen live on 28 Sep at 23:30:49 IST: isMarketOpen said open for the whole
// close minute while minutesToSessionClose said closed, so neither the session
// gate nor the closing guard refused an intraday setup.
const CLOSES: Array<{ exchange: Exchange; label: string; lastOpen: string; close: string; inCloseMinute: string }> = [
  { exchange: 'NSE', label: 'NSE 15:30', lastOpen: '2026-09-29T15:29:59', close: '2026-09-29T15:30:00', inCloseMinute: '2026-09-29T15:30:45' },
  { exchange: 'BSE', label: 'BSE 15:30', lastOpen: '2026-09-29T15:29:59', close: '2026-09-29T15:30:00', inCloseMinute: '2026-09-29T15:30:45' },
  { exchange: 'MCX', label: 'MCX 23:30 (US DST)', lastOpen: '2026-09-29T23:29:59', close: '2026-09-29T23:30:00', inCloseMinute: '2026-09-29T23:30:49' },
  { exchange: 'MCX', label: 'MCX 23:55 (US winter)', lastOpen: '2026-11-04T23:54:59', close: '2026-11-04T23:55:00', inCloseMinute: '2026-11-04T23:55:30' },
];

describe('session close is exclusive and every gate agrees on it', () => {
  for (const c of CLOSES) {
    it(`${c.label}: open one second before, closed from the close second on`, () => {
      expect(isMarketOpen(c.exchange, ist(c.lastOpen))).toBe(true);
      expect(isMarketOpen(c.exchange, ist(c.close))).toBe(false);
      expect(isMarketOpen(c.exchange, ist(c.inCloseMinute))).toBe(false);
      expect(minutesSinceSessionOpen(c.exchange, ist(c.inCloseMinute))).toBeNull();
    });

    it(`${c.label}: the market-open check and the closing guard's clock never disagree`, () => {
      for (let s = -90; s <= 90; s += 1) {
        const at = ist(c.close) + s * 1000;
        const open = isMarketOpen(c.exchange, at);
        const toClose = minutesToSessionClose(c.exchange, at);
        // Whenever the session counts as open, the closing guard has a clock to read.
        if (open) expect(toClose, `${c.label} at ${s}s`).not.toBeNull();
      }
    });

    it(`${c.label}: in the last open second an intraday setup is refused by the closing guard`, () => {
      const reason = closingGuardReason({
        enabled: true,
        mode: 'INTRADAY',
        exchange: c.exchange,
        minutesToClose: minutesToSessionClose(c.exchange, ist(c.lastOpen)),
        guardMinutes: 60,
      });
      expect(reason?.code).toBe('CLOSING_HOUR');
    });
  }

  it('the open boundary is unchanged: MCX 08:59:59 closed, 09:00:00 open; NSE 09:15:00 open', () => {
    expect(isMarketOpen('MCX', ist('2026-09-29T08:59:59'))).toBe(false);
    expect(isMarketOpen('MCX', ist('2026-09-29T09:00:00'))).toBe(true);
    expect(isMarketOpen('NSE', ist('2026-09-29T09:14:59'))).toBe(false);
    expect(isMarketOpen('NSE', ist('2026-09-29T09:15:00'))).toBe(true);
  });
});
