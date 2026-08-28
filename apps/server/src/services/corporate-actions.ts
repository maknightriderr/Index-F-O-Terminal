// ============================================================
// CORPORATE ACTIONS SERVICE
// ============================================================
// Dividends, bonuses, splits, rights issues, buybacks — sourced from
// NSE's own public corporate-actions API (no key, free), the same one
// nseindia.com's own "Corporate Filings" page uses. NSE blocks bare
// API requests without session cookies from a prior page visit (its
// bot-protection layer) — visiting the homepage first and forwarding
// the cookies it sets is the standard, verified workaround.
//
// Angel One's broker API has no corporate-actions endpoint of its own
// (it's a trading API, not a corporate-data one), so this is a
// separate, independent data source from the rest of the app.
// ============================================================

import axios from 'axios';
import type { CorporateAction, CorporateActionType } from '@fno/shared';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

const NSE_BASE = 'https://www.nseindia.com';
const NSE_REFERER = `${NSE_BASE}/companies-listing/corporate-filings-actions`;
// A real browser UA — NSE's bot-protection rejects the default axios/node UA outright.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Corporate actions don't change intraday — a multi-hour cache keeps this
// well clear of NSE's own rate limiting without ever showing stale-feeling
// data (nobody expects a dividend calendar to update minute-to-minute).
const CACHE_TTL_SECONDS = 6 * 60 * 60;
// NSE's session cookies expire; refresh well before they plausibly would
// rather than finding out via a failed request.
const COOKIE_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

let cookieJar: string | null = null;
let cookieJarFetchedAt = 0;

async function ensureCookies(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cookieJar && now - cookieJarFetchedAt < COOKIE_REFRESH_INTERVAL_MS) {
    return cookieJar;
  }

  // The homepage itself commonly answers with a 403 to a bare/automated
  // request (the same bot-protection layer), but it still sets the cookies
  // the API call needs regardless of that status — so the response body/
  // status here is ignored, only the Set-Cookie headers matter.
  const response = await axios.get(NSE_BASE, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    validateStatus: () => true,
  });
  const setCookie = response.headers['set-cookie'];
  if (!setCookie || setCookie.length === 0) {
    throw new Error('NSE did not return session cookies from homepage visit');
  }
  cookieJar = setCookie.map((c) => c.split(';')[0]).join('; ');
  cookieJarFetchedAt = now;
  return cookieJar;
}

async function fetchRaw(symbol?: string): Promise<any[]> {
  const url = `${NSE_BASE}/api/corporates-corporateActions?index=equities${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`;
  const requestHeaders = (cookie: string) => ({
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Referer: NSE_REFERER,
    Cookie: cookie,
  });

  const cookies = await ensureCookies();
  let response = await axios.get(url, { headers: requestHeaders(cookies), validateStatus: () => true });

  if (response.status !== 200 || !Array.isArray(response.data)) {
    // Cookies can go stale server-side before our own refresh window is
    // up — one forced refresh + retry before giving up, rather than
    // caching a hard failure for the full TTL on a transient session blip.
    logger.warn({ symbol, status: response.status }, 'NSE corporate actions request failed, retrying with fresh cookies');
    const freshCookies = await ensureCookies(true);
    response = await axios.get(url, { headers: requestHeaders(freshCookies), validateStatus: () => true });
  }

  if (response.status !== 200 || !Array.isArray(response.data)) {
    throw new Error(`NSE corporate actions request failed (status ${response.status})`);
  }
  return response.data;
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseNseDate(d: string | null | undefined): string | null {
  if (!d || d === '-') return null;
  const m = d.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1]}`;
}

function classify(subject: string): CorporateActionType {
  const s = subject.toUpperCase();
  if (s.includes('BONUS')) return 'BONUS';
  if (s.includes('SPLIT') || s.includes('SUB-DIVISION') || s.includes('SUBDIVISION')) return 'SPLIT';
  if (s.includes('RIGHTS')) return 'RIGHTS';
  if (s.includes('BUYBACK') || s.includes('BUY BACK')) return 'BUYBACK';
  if (s.includes('DIVIDEND')) return 'DIVIDEND';
  return 'OTHER';
}

function mapRow(row: any): CorporateAction | null {
  const exDate = parseNseDate(row.exDate);
  if (!exDate || !row.symbol) return null;
  return {
    symbol: row.symbol,
    company: row.comp ?? row.symbol,
    type: classify(row.subject ?? ''),
    purpose: (row.subject ?? '').trim(),
    exDate,
    recordDate: parseNseDate(row.recDate),
  };
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Market-wide upcoming corporate actions (dividend/bonus/split/rights/
 * buyback) across all NSE equities, ex-date today or later, nearest first.
 */
export async function getUpcomingCorporateActions(): Promise<CorporateAction[]> {
  return cached(
    'corporate-actions:market',
    CACHE_TTL_SECONDS,
    async () => {
      const raw = await fetchRaw();
      const today = todayIso();
      return raw
        .map(mapRow)
        .filter((a): a is CorporateAction => a != null && a.exDate >= today)
        .sort((a, b) => a.exDate.localeCompare(b.exDate));
    },
    (value) => value.length > 0
  );
}

/** Full corporate-action history (past + future) for one symbol, most recent first. */
export async function getCorporateActionsForSymbol(symbol: string): Promise<CorporateAction[]> {
  return cached(
    `corporate-actions:symbol:${symbol}`,
    CACHE_TTL_SECONDS,
    async () => {
      const raw = await fetchRaw(symbol);
      return raw
        .map(mapRow)
        .filter((a): a is CorporateAction => a != null)
        .sort((a, b) => b.exDate.localeCompare(a.exDate));
    },
    (value) => value.length > 0
  );
}
