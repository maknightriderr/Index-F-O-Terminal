// ============================================================
// IV HISTORY CLOCK
// ============================================================
// Pure helpers for rescaling IV samples recorded before time to expiry was
// anchored to the exchange close (see repairIvHistoryClock in
// fno-scanner.ts). No I/O, so they can be tested in isolation.
// ============================================================

import { getSessionWindow, expiryTimestamp } from '@fno/shared';

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** NSE monthly stock-option expiry for a calendar month (m is 1-12). */
export function monthlyStockExpiry(y: number, m: number): string {
  const weekday = y > 2025 || (y === 2025 && m >= 9) ? 2 : 4; // Tuesday from Sep 2025, Thursday before
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let d = lastDay;
  while (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== weekday) d--;
  let date = isoDate(y, m, d);
  // Holiday: the previous trading day (only years in the holiday calendar can be checked; weekends always can).
  for (let i = 0; i < 7; i++) {
    const dt = new Date(`${date}T12:00:00Z`);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6 && (getSessionWindow('NSE', date) || y < 2026)) break;
    dt.setUTCDate(dt.getUTCDate() - 1);
    date = dt.toISOString().slice(0, 10);
  }
  return date;
}

/** The monthly expiry a scan at `at` would have picked: this month's, or next month's once this month's has passed. */
export function stockExpiryInForce(at: number): string {
  const ist = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [y, m] = ist.split('-').map(Number);
  const thisMonth = monthlyStockExpiry(y, m);
  if (ist <= thisMonth) return thisMonth;
  return m === 12 ? monthlyStockExpiry(y + 1, 1) : monthlyStockExpiry(y, m + 1);
}

/** sqrt(T_old / T_true): the factor that moves an IV solved on the old clock onto the close-anchored one. Null if it can't apply. */
export function ivClockCorrection(at: number, expiry: string): number | null {
  const oldEnd = new Date(expiry).getTime(); // the old clock: UTC midnight
  const trueEnd = expiryTimestamp(expiry, 'NSE');
  const tOld = oldEnd - at;
  const tTrue = trueEnd - at;
  if (!(tOld > 0) || !(tTrue > 0)) return null;
  return Math.sqrt(tOld / tTrue);
}

