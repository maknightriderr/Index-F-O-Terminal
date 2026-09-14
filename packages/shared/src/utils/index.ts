// ============================================================
// SHARED UTILITIES
// ============================================================

import { TRADING_HOURS, EXCHANGE_HOLIDAYS, MCX_EVENING_SESSION_OPEN } from '../constants/index.js';
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
export function calculateDTE(expiryDate: string): number {
  const now = new Date();
  const expiry = new Date(expiryDate);
  const diffMs = expiry.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Calculate fractional years to expiry (for Black-Scholes).
 */
export function yearsToExpiry(expiryDate: string): number {
  const now = new Date();
  const expiry = new Date(expiryDate);
  const diffMs = expiry.getTime() - now.getTime();
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
  let close = hhmmToMinutes(hours.close);
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
