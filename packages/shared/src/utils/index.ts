// ============================================================
// SHARED UTILITIES
// ============================================================

import { TRADING_HOURS } from '../constants/index.js';
import type { Exchange, OptionType } from '../types/index.js';

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

/**
 * Check if market is currently open for given exchange.
 */
export function isMarketOpen(exchange: Exchange): boolean {
  const hours = TRADING_HOURS[exchange];
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: hours.timezone }));

  const day = ist.getDay();
  if (day === 0 || day === 6) return false; // Weekends

  const [openH, openM] = hours.open.split(':').map(Number);
  const [closeH, closeM] = hours.close.split(':').map(Number);

  const currentMinutes = ist.getHours() * 60 + ist.getMinutes();
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
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
