// ============================================================
// DHAN OPTION GREEKS (2 Nov 2026)
// ============================================================
// Angel One's optionGreek endpoint refuses calls ("Access denied because of exceeding access rate", HTTP 403) many
// times a session, which leaves the option chain on the internal Black-Scholes engine only. Dhan's option chain API
// (same Data API subscription) returns each strike's IV and Greeks for an index underlying. This module asks Dhan
// first for NSE/BSE indices whose Dhan security id is listed in Dhan's scrip master; anything else (stocks, MCX, an
// unknown index, a failure or a rate limit) returns null and the caller asks Angel One exactly as before.
// Data only: no order API is ever called.
// ============================================================

import axios from 'axios';
import type { Instrument } from '@fno/shared';
import type { ProviderGreeksData } from '../interface.js';
import { logger } from '../../lib/logger.js';
import { currentCaller, recordBrokerCall } from '../../lib/broker-call-stats.js';
import { dhanSession, markDhanTokenRejected } from '../../services/dhan-session.js';
import { QUOTE_PROVIDER, dhanIndexId } from './quotes.js';

export const DHAN_OPTION_CHAIN_URL = 'https://api.dhan.co/v2/optionchain';
/** Dhan allows one option-chain call every 3 seconds; 3.2 s leaves room for jitter. */
export const DHAN_GREEKS_MIN_INTERVAL_MS = 3200;
const RATE_LIMIT_PAUSE_MS = 30_000;
const MAX_PENDING = 4;

/** GREEKS_PROVIDER=ANGEL turns Dhan Greeks off; otherwise they follow the Dhan data subscription (QUOTE_PROVIDER=DHAN). */
export const DHAN_GREEKS_ENABLED = (process.env.GREEKS_PROVIDER ?? '').trim().toUpperCase() !== 'ANGEL' && QUOTE_PROVIDER === 'DHAN';

const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN);

/** Pure: Dhan's option-chain response → per-strike Greeks rows in the provider's shape. Junk rows are dropped. */
export function greeksFromDhanChain(data: any, name: string, expiry: string): ProviderGreeksData[] {
  const oc = data?.data?.oc ?? data?.oc;
  if (!oc || typeof oc !== 'object') return [];
  const out: ProviderGreeksData[] = [];
  for (const [k, row] of Object.entries<any>(oc)) {
    const strikePrice = Number(k);
    if (!Number.isFinite(strikePrice) || strikePrice <= 0) continue;
    for (const [side, optionType] of [['ce', 'CE'], ['pe', 'PE']] as const) {
      const leg = row?.[side];
      const g = leg?.greeks;
      if (!leg || !g) continue;
      const iv = num(leg.implied_volatility), delta = num(g.delta), gamma = num(g.gamma), theta = num(g.theta), vega = num(g.vega), ltp = num(leg.last_price);
      if (![iv, delta, gamma, theta, vega].every(Number.isFinite) || iv <= 0) continue;
      out.push({ name, expiry, strikePrice, optionType, ltp: Number.isFinite(ltp) ? ltp : 0, iv, delta, gamma, theta, vega });
    }
  }
  return out;
}

let pending = 0;
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
let pausedUntil = 0;

/** Greeks from Dhan, or null when Dhan cannot or did not serve them (the caller then uses Angel One). Never throws. */
export async function dhanGreeks(name: string, expiry: string, getInstruments: () => Promise<Instrument[]>): Promise<ProviderGreeksData[] | null> {
  if (!DHAN_GREEKS_ENABLED || Date.now() < pausedUntil || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const id = dhanIndexId(name, getInstruments);
  const session = dhanSession();
  if (!id || !session || pending >= MAX_PENDING) return null;
  pending++;
  const run = async (): Promise<ProviderGreeksData[] | null> => {
    const wait = Math.max(0, lastCallAt + DHAN_GREEKS_MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (Date.now() < pausedUntil) return null;
    lastCallAt = Date.now();
    try {
      const res = await axios.post(DHAN_OPTION_CHAIN_URL, { UnderlyingScrip: Number(id), UnderlyingSeg: 'IDX_I', Expiry: expiry }, {
        headers: { 'access-token': session.accessToken, 'client-id': session.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 15_000,
      });
      const rows = greeksFromDhanChain(res.data, name, expiry);
      recordBrokerCall('DHAN', 'optionGreeks', currentCaller(), rows.length ? 'OK' : 'FAILED');
      return rows.length ? rows : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) markDhanTokenRejected(session.accessToken);
      if (status === 429) pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      recordBrokerCall('DHAN', 'optionGreeks', currentCaller(), status === 429 ? 'RATE_LIMITED' : 'FAILED');
      logger.warn({ error: err?.message, status: status ?? null, name, expiry }, 'Dhan Greeks: call failed — Angel One serves this request');
      return null;
    }
  };
  const next = chain.then(run, run).finally(() => { pending--; });
  chain = next.catch(() => null);
  return next;
}
