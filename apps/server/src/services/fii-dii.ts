// ============================================================
// FII/DII DAILY CASH ACTIVITY
// ============================================================
// NSE publishes FII/DII net cash-market buy/sell figures once daily,
// after market close (~5:30-6:30pm IST) — there is no official public
// API for this (Angel One's broker API doesn't carry it either; it's
// exchange-reported, not broker/market data). This fetches NSE's own
// internal endpoint that their website's frontend uses
// (nseindia.com/api/fiidiiTradeReact) — the same unofficial-but-widely
// -used approach every free FII/DII tracker relies on, since NSE
// doesn't publish a supported public API for it. NSE guards this
// behind a cookie/session handshake (a direct request gets rejected)
// and can change its anti-bot measures or response shape without
// notice — this fails soft (returns null) on any error rather than
// ever throwing, the same "don't take a feature down over a flaky
// external dependency" approach this app already applies to broker
// Greeks/VIX quotes elsewhere.
//
// Being EOD-only, this can never be a same-day intraday signal like
// everything else in market-bias.ts/market-scanner.ts — it feeds
// tomorrow's outlook (institutional-flow.ts's sentiment snapshot),
// not live trade-setup scoring.
// ============================================================

import type { FiiDiiActivity } from '@fno/shared';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

const NSE_HOME_URL = 'https://www.nseindia.com/';
const NSE_FII_DII_URL = 'https://www.nseindia.com/api/fiidiiTradeReact';
const FETCH_TIMEOUT_MS = 8000;
// Once-daily data — an hour keeps this from re-hitting NSE on every poll
// while still picking up the evening update within the same session.
const CACHE_TTL_SECONDS = 3600;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface NseFiiDiiRow {
  category: string;
  date: string;
  buyValue: string;
  sellValue: string;
  netValue: string;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseCr(raw: string): number {
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

async function fetchFiiDiiActivity(): Promise<FiiDiiActivity | null> {
  try {
    // NSE rejects a direct hit on the data endpoint without cookies from a
    // real page load first — establish a session, then reuse its cookies.
    const homeRes = await fetchWithTimeout(NSE_HOME_URL, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html' },
    });
    const cookies = homeRes.headers.getSetCookie?.() ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

    const dataRes = await fetchWithTimeout(NSE_FII_DII_URL, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'application/json',
        Referer: NSE_HOME_URL,
        Cookie: cookieHeader,
      },
    });
    if (!dataRes.ok) {
      logger.warn({ status: dataRes.status }, 'FII/DII fetch: NSE returned a non-OK status');
      return null;
    }

    const raw = (await dataRes.json()) as NseFiiDiiRow[];
    const fiiRow = raw.find((r) => /FII|FPI/i.test(r.category));
    const diiRow = raw.find((r) => /DII/i.test(r.category));
    if (!fiiRow || !diiRow) {
      logger.warn({ raw }, 'FII/DII fetch: unexpected response shape from NSE — endpoint may have changed');
      return null;
    }

    return {
      date: fiiRow.date,
      fii: { buyValue: parseCr(fiiRow.buyValue), sellValue: parseCr(fiiRow.sellValue), netValue: parseCr(fiiRow.netValue) },
      dii: { buyValue: parseCr(diiRow.buyValue), sellValue: parseCr(diiRow.sellValue), netValue: parseCr(diiRow.netValue) },
      fetchedAt: Date.now(),
    };
  } catch (err: any) {
    logger.warn({ error: err.message }, 'FII/DII fetch failed — NSE endpoint unreachable or changed shape');
    return null;
  }
}

export async function getFiiDiiActivity(): Promise<FiiDiiActivity | null> {
  return cached('fii_dii:latest', CACHE_TTL_SECONDS, fetchFiiDiiActivity, (value) => value != null);
}
