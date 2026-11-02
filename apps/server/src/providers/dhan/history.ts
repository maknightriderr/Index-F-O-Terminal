// ============================================================
// DHAN CANDLES (2 Nov 2026)
// ============================================================
// Angel One's candle endpoint was the terminal's bottleneck in the 2 Nov session: ~18 rate-limit retries a minute and
// requests refused after three retries (HTTP 403), so the fresh-start engine and the bias engine often had no bars.
// The Dhan Data API (already subscribed for quotes and the order-flow feed) serves the same exchange candles from a
// separate rate budget. A request goes to Dhan when the contract is verified identical on both masters (the same
// daily check the Dhan quotes use) and the interval/range is one Dhan serves; anything else, a failure or a rate
// limit, returns null and the caller asks Angel One exactly as before. Data only: no order API is ever called.
// ============================================================

import axios from 'axios';
import type { CandleInterval, ExchangeSegment, HistoricalParams, Instrument, OHLCV } from '@fno/shared';
import { logger } from '../../lib/logger.js';
import { currentCaller, recordBrokerCall } from '../../lib/broker-call-stats.js';
import { dhanSession, markDhanTokenRejected } from '../../services/dhan-session.js';
import { DHAN_QUOTE_SEGMENT, QUOTE_PROVIDER, dhanRoutable } from './quotes.js';

export const DHAN_INTRADAY_URL = 'https://api.dhan.co/v2/charts/intraday';
/** Dhan Data APIs allow 5 calls a second; one call at most every 300 ms leaves room for jitter. */
export const DHAN_HISTORY_MIN_INTERVAL_MS = 300;
const RATE_LIMIT_PAUSE_MS = 10_000;
/** Dhan serves at most 90 days of intraday candles per call. */
const MAX_RANGE_DAYS = 90;

/** HISTORY_PROVIDER=ANGEL turns Dhan candles off; otherwise they follow the Dhan data subscription (QUOTE_PROVIDER=DHAN). */
export const DHAN_HISTORY_ENABLED = (process.env.HISTORY_PROVIDER ?? '').trim().toUpperCase() !== 'ANGEL' && QUOTE_PROVIDER === 'DHAN';

const INTERVAL: Partial<Record<CandleInterval, string>> = { ONE_MINUTE: '1', FIVE_MINUTE: '5', FIFTEEN_MINUTE: '15', ONE_HOUR: '60' };
const INSTRUMENT: Record<string, string> = { OPTIDX: 'OPTIDX', FUTIDX: 'FUTIDX', OPTSTK: 'OPTSTK', FUTSTK: 'FUTSTK', EQ: 'EQUITY', FUTCOM: 'FUTCOM', OPTFUT: 'OPTFUT' };

/** "YYYY-MM-DD HH:mm" (IST, Angel format) or an ISO instant → epoch ms; null when unreadable. */
export function parseRequestTime(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - 19_800_000;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
/** Epoch ms → "YYYY-MM-DD HH:mm:ss" in IST (Dhan's request format). */
export function dhanTime(ms: number): string {
  const d = new Date(ms + 19_800_000), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
/** Epoch seconds → "YYYY-MM-DDTHH:mm:ss+05:30", the shape Angel One candles carry. */
export function istIso(sec: number): string {
  return `${dhanTime(sec * 1000).replace(' ', 'T')}+05:30`;
}

/** Dhan's column arrays → candles, dropping rows with a missing or non-positive price. */
export function candlesFromDhan(data: any): OHLCV[] {
  const ts: unknown[] = Array.isArray(data?.timestamp) ? data.timestamp : [];
  const out: OHLCV[] = [];
  ts.forEach((t, i) => {
    const o = Number(data.open?.[i]), h = Number(data.high?.[i]), l = Number(data.low?.[i]), c = Number(data.close?.[i]), v = Number(data.volume?.[i] ?? 0);
    if (typeof t !== 'number' || !Number.isFinite(t) || ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return;
    out.push({ timestamp: istIso(t), open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  });
  return out;
}

let types: { day: string; byKey: Map<string, string> } | null = null;
async function instrumentType(segment: ExchangeSegment, token: string, getInstruments: () => Promise<Instrument[]>): Promise<string | null> {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (!types || types.day !== day) {
    const byKey = new Map<string, string>();
    for (const x of await getInstruments()) byKey.set(`${x.exchange}_${x.segment}:${x.token}`, x.instrumentType);
    types = { day, byKey };
  }
  return INSTRUMENT[types.byKey.get(`${segment}:${token}`) ?? ''] ?? null;
}

/** Requests waiting for a Dhan slot; beyond this the request goes straight to Angel One instead of queueing. */
export const DHAN_HISTORY_MAX_PENDING = 20;
let pending = 0;
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
let pausedUntil = 0;

/** Candles from Dhan, or null when Dhan cannot or did not serve them (the caller then uses Angel One). Never throws. */
export async function dhanCandles(params: HistoricalParams, getInstruments: () => Promise<Instrument[]>): Promise<OHLCV[] | null> {
  if (!DHAN_HISTORY_ENABLED || Date.now() < pausedUntil) return null;
  const interval = INTERVAL[params.interval];
  const from = parseRequestTime(params.fromDate), to = parseRequestTime(params.toDate);
  if (!interval || from == null || to == null || to <= from || to - from > MAX_RANGE_DAYS * 86_400_000) return null;
  const segment = `${params.exchange}_${params.segment === 'FO' || params.exchange === 'MCX' ? 'FO' : 'CM'}` as ExchangeSegment;
  if (!DHAN_QUOTE_SEGMENT[segment] || !dhanRoutable(segment, params.token, getInstruments)) return null;
  const session = dhanSession();
  if (!session) return null;
  let instrument: string | null;
  try { instrument = await instrumentType(segment, params.token, getInstruments); } catch { return null; }
  if (!instrument || pending >= DHAN_HISTORY_MAX_PENDING) return null;
  pending++;
  const run = async (): Promise<OHLCV[] | null> => {
    const wait = Math.max(0, lastCallAt + DHAN_HISTORY_MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (Date.now() < pausedUntil) return null;
    lastCallAt = Date.now();
    try {
      const res = await axios.post(DHAN_INTRADAY_URL, { securityId: params.token, exchangeSegment: DHAN_QUOTE_SEGMENT[segment].key, instrument, interval, oi: false, fromDate: dhanTime(from), toDate: dhanTime(to) }, {
        headers: { 'access-token': session.accessToken, 'client-id': session.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 15_000,
      });
      const candles = candlesFromDhan(res.data);
      recordBrokerCall('DHAN', 'candles', currentCaller(), candles.length ? 'OK' : 'FAILED');
      return candles.length ? candles : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) markDhanTokenRejected(session.accessToken);
      if (status === 429) pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      recordBrokerCall('DHAN', 'candles', currentCaller(), status === 429 ? 'RATE_LIMITED' : 'FAILED');
      logger.warn({ error: err?.message, status: status ?? null, token: params.token, interval: params.interval }, 'Dhan candles: call failed — Angel One serves this request');
      return null;
    }
  };
  // One call at a time, paced; a failure never blocks the next.
  const next = chain.then(run, run).finally(() => { pending--; });
  chain = next.catch(() => null);
  return next;
}

/** Tests only. */
export function resetDhanHistoryForTest(): void { chain = Promise.resolve(); lastCallAt = 0; pausedUntil = 0; types = null; pending = 0; }
