// ============================================================
// SHARED UTILITIES
// ============================================================

import { TRADING_HOURS, EXCHANGE_HOLIDAYS, MCX_EVENING_SESSION_OPEN, MCX_US_DST_CLOSE } from '../constants/index.js';
import type { Exchange, ExchangeHoliday, OptionType } from '../types/index.js';

/**
 * Format a number as Indian Rupee currency.
 */
export function formatINR(value: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format a number with Indian locale grouping (lakhs/crores).
 */
export function formatIndianNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format large numbers as abbreviated (e.g., 1.5L, 2.3Cr).
 */
export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (Math.abs(value) >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

/**
 * Format a percentage.
 */
export function formatPercent(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Get change color class based on positive/negative.
 */
export function getChangeColor(value: number): 'positive' | 'negative' | 'neutral' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

/**
 * Calculate Days To Expiry from expiry date string.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-17" -> "17 Sep 2026". Returns the input unchanged if it isn't a YYYY-MM-DD date. */
export function formatExpiryDate(expiry: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!match) return expiry;
  return `${Number(match[3])} ${MONTHS_SHORT[Number(match[2]) - 1]} ${match[1]}`;
}

/**
 * Calendar days from today (IST) to the expiry date: 0 on expiry day, 1 the
 * day before. Never negative.
 */
export function calculateDTE(expiryDate: string, at: Date | number = Date.now()): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    const diffMs = new Date(expiryDate).getTime() - new Date(at).getTime();
    return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  }
  const today = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const days = Math.round((Date.parse(`${expiryDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / (24 * 60 * 60 * 1000));
  return Math.max(0, days);
}

/**
 * The moment a contract expiring on `expiryDate` stops trading: its
 * exchange's close that day (15:30 IST for NSE/BSE, 23:30/23:55 for MCX).
 * `new Date("2026-09-17")` is UTC midnight — 05:30 IST on expiry morning —
 * which zeroed time-to-expiry for the whole expiry session (every Greek and
 * IV read 0) and cut 10-18h off it on every other day, overstating IV.
 */
export function expiryTimestamp(expiryDate: string, exchange: Exchange = 'NSE'): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return new Date(expiryDate).getTime();
  const session = getSessionWindow(exchange, expiryDate);
  if (session) return session.close;
  return istWallClockMs(expiryDate, getSessionCloseTime(exchange, istWallClockMs(expiryDate, '12:00')));
}

/**
 * Calculate fractional years to expiry (for Black-Scholes), measured to the
 * exchange's close on the expiry date.
 */
export function yearsToExpiry(expiryDate: string, exchange: Exchange = 'NSE', at: Date | number = Date.now()): number {
  const diffMs = expiryTimestamp(expiryDate, exchange) - new Date(at).getTime();
  return Math.max(0, diffMs / (1000 * 60 * 60 * 24 * 365.25));
}

/**
 * Today's date in IST as YYYY-MM-DD — the boundary this app uses to decide
 * whether a listed contract's expiry has already passed.
 */
export function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * True if a contract's expiry (YYYY-MM-DD) hasn't already passed. Angel
 * One's scrip master doesn't drop a contract the instant it expires — a
 * just-expired row can stay listed (with a dead/zero quote) for a day or
 * more — so any "pick the nearest expiry" selection needs this filter
 * BEFORE sorting, or it can silently select a dead contract that happens
 * to sort first. Caught live: this exact gap dropped CRUDEOIL from the
 * Indices page and, unfiltered elsewhere, could feed stale option/futures
 * data into PCR, Greeks, and OI reads across the app.
 */
export function isExpiryActive(expiry: string | null | undefined): boolean {
  return !!expiry && expiry >= todayIST();
}

/**
 * Determine ATM strike from spot price and strike interval.
 */
export function getATMStrike(spotPrice: number, strikeInterval: number): number {
  return Math.round(spotPrice / strikeInterval) * strikeInterval;
}

/**
 * Classify a strike as ITM, ATM, or OTM.
 */
export function classifyStrike(
  strike: number,
  spotPrice: number,
  optionType: OptionType,
  strikeInterval: number
): 'ITM' | 'ATM' | 'OTM' {
  const atm = getATMStrike(spotPrice, strikeInterval);
  if (Math.abs(strike - atm) < strikeInterval * 0.5) return 'ATM';
  if (optionType === 'CE') {
    return strike < spotPrice ? 'ITM' : 'OTM';
  } else {
    return strike > spotPrice ? 'ITM' : 'OTM';
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Calendar date, weekday (0 = Sunday) and minutes past midnight in the exchange's own timezone at `at`. */
function exchangeClock(exchange: Exchange, at: Date | number): { date: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TRADING_HOURS[exchange].timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * True on dates when the US is on daylight saving time — from the second
 * Sunday of March up to (not including) the first Sunday of November.
 * Date-level on purpose: the US switches at 2am on a Sunday, when MCX is
 * shut anyway, so the Monday after is the first session affected.
 */
function isUsDaylightSavingDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const nthSunday = (m: number, n: number): number => {
    const firstWeekday = new Date(Date.UTC(year, m - 1, 1)).getUTCDay();
    return 1 + ((7 - firstWeekday) % 7) + (n - 1) * 7;
  };
  const key = month * 100 + day;
  return key >= 300 + nthSunday(3, 2) && key < 1100 + nthSunday(11, 1);
}

/**
 * The session's closing time (HH:MM, exchange timezone) on the date of `at`.
 * MCX's evening session follows US trading hours: it runs to 23:55 while
 * the US is on daylight saving time, and to 23:30 otherwise — a fixed
 * 23:30 wrongly treated the last 25 minutes of every summer session as
 * closed.
 */
export function getSessionCloseTime(exchange: Exchange, at: Date | number = Date.now()): string {
  if (exchange !== 'MCX') return TRADING_HOURS[exchange].close;
  return isUsDaylightSavingDate(exchangeClock(exchange, at).date) ? MCX_US_DST_CLOSE : TRADING_HOURS.MCX.close;
}

// Every exchange here trades on Asia/Kolkata (TRADING_HOURS[*].timezone),
// which has no DST, so a fixed offset turns an IST wall-clock into epoch ms.
const IST_OFFSET = '+05:30';
const istWallClockMs = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00${IST_OFFSET}`);

function shiftIstDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00${IST_OFFSET}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export interface SessionWindow {
  /** IST calendar date (YYYY-MM-DD). */
  date: string;
  /** Session open / close, epoch ms. */
  open: number;
  close: number;
}

/** The trading session on an IST calendar date, or null when the exchange doesn't trade that day. Honours partial MCX holidays and MCX's US-DST close. */
export function getSessionWindow(exchange: Exchange, date: string): SessionWindow | null {
  const noon = istWallClockMs(date, '12:00');
  const { weekday } = exchangeClock(exchange, noon);
  if (weekday === 0 || weekday === 6) return null;

  let open = TRADING_HOURS[exchange].open;
  let close = getSessionCloseTime(exchange, noon);
  const holiday = EXCHANGE_HOLIDAYS[exchange][date];
  if (holiday) {
    if (holiday.closed === 'FULL') return null;
    if (holiday.closed === 'MORNING') open = MCX_EVENING_SESSION_OPEN;
    else close = MCX_EVENING_SESSION_OPEN;
  }
  return { date, open: istWallClockMs(date, open), close: istWallClockMs(date, close) };
}

/** The most recent session that has opened by `at` — still running, or the last one to have closed. Null only if none in the past two weeks. */
export function getLatestSessionWindow(exchange: Exchange, at: Date | number = Date.now()): SessionWindow | null {
  const atMs = new Date(at).getTime();
  let date = exchangeClock(exchange, atMs).date;
  for (let i = 0; i < 14; i++) {
    const window = getSessionWindow(exchange, date);
    if (window && window.open <= atMs) return window;
    date = shiftIstDate(date, -1);
  }
  return null;
}

/** The exchange's holiday on the calendar date of `at`, if any (including partial MCX closures). */
export function getExchangeHoliday(exchange: Exchange, at: Date | number = Date.now()): ExchangeHoliday | null {
  return EXCHANGE_HOLIDAYS[exchange][exchangeClock(exchange, at).date] ?? null;
}

/**
 * Minutes since the live session opened, or null when there's no live
 * session at `at` — weekend, full holiday, outside trading hours, or the
 * half of the day an MCX partial holiday shuts (on a morning closure the
 * session opens at 17:00, so "minutes since open" counts from there).
 */
export function minutesSinceSessionOpen(exchange: Exchange, at: Date | number = Date.now()): number | null {
  const hours = TRADING_HOURS[exchange];
  const { date, weekday, minutes } = exchangeClock(exchange, at);
  if (weekday === 0 || weekday === 6) return null;

  let open = hhmmToMinutes(hours.open);
  let close = hhmmToMinutes(getSessionCloseTime(exchange, at));
  const holiday = EXCHANGE_HOLIDAYS[exchange][date];
  if (holiday) {
    if (holiday.closed === 'FULL') return null;
    if (holiday.closed === 'MORNING') open = hhmmToMinutes(MCX_EVENING_SESSION_OPEN);
    else close = hhmmToMinutes(MCX_EVENING_SESSION_OPEN);
  }

  if (minutes < open || minutes > close) return null;
  return minutes - open;
}

/**
 * Check if the market is open for the given exchange — now, or at `at`.
 * Holiday-aware via EXCHANGE_HOLIDAYS.
 */
export function isMarketOpen(exchange: Exchange, at: Date | number = Date.now()): boolean {
  return minutesSinceSessionOpen(exchange, at) != null;
}

/**
 * Get current IST timestamp.
 */
export function getISTTimestamp(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  });
}

/**
 * Parse Angel One date format to ISO string.
 */
export function parseAngelDate(dateStr: string): string {
  // Angel One uses formats like "25JAN2024" or "2024-01-25"
  if (dateStr.includes('-')) return dateStr;

  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04',
    MAY: '05', JUN: '06', JUL: '07', AUG: '08',
    SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };

  const day = dateStr.slice(0, 2);
  const month = months[dateStr.slice(2, 5).toUpperCase()] ?? '01';
  const year = dateStr.slice(5);
  return `${year}-${month}-${day}`;
}

/**
 * Generate a unique ID.
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Deep clone an object.
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Debounce a function.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

/**
 * Throttle a function.
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  intervalMs: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      fn(...args);
    }
  };
}
