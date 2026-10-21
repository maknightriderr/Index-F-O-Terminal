// ============================================================
// DHAN QUOTES (QUOTE_PROVIDER=DHAN, 2026-10-21)
// ============================================================
// Angel One refused its quote endpoint ~40 times a minute through the 21 Oct
// session (it takes 50 instruments a call), which slowed every read behind it.
// The Dhan Data API subscription serves the same exchange quotes, up to 1,000
// instruments a call at 1 call a second. With QUOTE_PROVIDER=DHAN, the Angel
// One provider's getQuote / getLTP send what Dhan can serve here and keep the
// rest on Angel One. Data only: no order API is ever called.
//
// What Dhan serves: a token whose Dhan security id names the SAME contract,
// checked one by one against both instrument masters each day (Angel One's
// token and Dhan's id are the exchange's own number for equities, futures and
// options: on 21 Oct, 37,910 of 37,910 NSE options agreed on expiry, strike
// and side). Index tokens differ between the two and are never routed. A token
// Dhan does not answer for, a failed call, a rejected token or a rate limit:
// Angel One serves it, as before.
//
// Requests are merged: everything waiting when the next call is allowed goes
// in one call (a person's request first), so many small reads cost one call.
//
// Differences from an Angel One quote, both recorded on the quote (source):
// Dhan gives the last trade time but not the exchange feed time
// (exchangeTimestamp stays absent), and the previous close is taken as
// last price − net change.
// ============================================================

import axios from 'axios';
import type { ExchangeSegment, Instrument } from '@fno/shared';
import type { ProviderQuote } from '../interface.js';
import { logger } from '../../lib/logger.js';
import { isInteractiveRequest } from '../../lib/request-priority.js';
import { currentCaller, recordBrokerCall } from '../../lib/broker-call-stats.js';
import { dhanSession, markDhanTokenRejected } from '../../services/dhan-session.js';

export const DHAN_QUOTE_URL = 'https://api.dhan.co/v2/marketfeed/quote';
export const DHAN_SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const MAX_INSTRUMENTS_PER_CALL = 1000;
/** Dhan allows 1 quote call a second; a small margin. */
const MIN_CALL_INTERVAL_MS = 1100;
const RATE_LIMIT_PAUSE_MS = 10_000;

export type QuoteProvider = 'ANGEL' | 'DHAN';
export function parseQuoteProvider(raw: string | undefined): QuoteProvider {
  return raw?.trim().toUpperCase() === 'DHAN' ? 'DHAN' : 'ANGEL';
}
export const QUOTE_PROVIDER: QuoteProvider = parseQuoteProvider(process.env.QUOTE_PROVIDER);

/** Our exchange segment → Dhan's request key, and the scrip master's (exchange, segment) columns. */
export const DHAN_QUOTE_SEGMENT: Readonly<Record<ExchangeSegment, { key: string; exch: string; seg: string }>> = Object.freeze({
  NSE_CM: { key: 'NSE_EQ', exch: 'NSE', seg: 'E' },
  NSE_FO: { key: 'NSE_FNO', exch: 'NSE', seg: 'D' },
  BSE_CM: { key: 'BSE_EQ', exch: 'BSE', seg: 'E' },
  BSE_FO: { key: 'BSE_FNO', exch: 'BSE', seg: 'D' },
  MCX_FO: { key: 'MCX_COMM', exch: 'MCX', seg: 'M' },
});

type InstrumentIdentity = Pick<Instrument, 'token' | 'symbol' | 'exchange' | 'segment' | 'instrumentType' | 'strike' | 'optionType' | 'expiry'>;

/**
 * Pure: per segment, the tokens Dhan's scrip master lists as the same contract
 * (equity: the trading symbol; future: the expiry date; option: expiry, strike
 * and side). Anything else, every index among it, stays off Dhan.
 */
export function verifiedDhanTokens(csv: string, instruments: readonly InstrumentIdentity[]): Map<ExchangeSegment, Set<string>> {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',');
  const col = (name: string) => head.indexOf(name);
  const [ex, seg, id, ts, exp, strike, opt] = ['SEM_EXM_EXCH_ID', 'SEM_SEGMENT', 'SEM_SMST_SECURITY_ID', 'SEM_TRADING_SYMBOL', 'SEM_EXPIRY_DATE', 'SEM_STRIKE_PRICE', 'SEM_OPTION_TYPE'].map(col);
  const out = new Map<ExchangeSegment, Set<string>>();
  if ([ex, seg, id, ts, exp, strike, opt].some((c) => c < 0)) return out;
  const wanted = new Set(Object.values(DHAN_QUOTE_SEGMENT).map((s) => `${s.exch}|${s.seg}`));
  const rows = new Map<string, string[]>();
  for (let k = 1; k < lines.length; k++) {
    const r = lines[k].split(',');
    if (wanted.has(`${r[ex]}|${r[seg]}`)) rows.set(`${r[ex]}|${r[seg]}|${r[id]}`, r);
  }
  for (const i of instruments) {
    if (i.instrumentType === 'INDEX') continue;
    const segment = `${i.exchange}_${i.segment}` as ExchangeSegment;
    const map = DHAN_QUOTE_SEGMENT[segment];
    if (!map) continue;
    const r = rows.get(`${map.exch}|${map.seg}|${i.token}`);
    if (!r) continue;
    let same: boolean;
    if (i.segment === 'CM') {
      const dash = i.symbol.lastIndexOf('-');
      same = r[ts] === i.symbol || (dash > 0 && r[ts] === i.symbol.slice(0, dash));
    } else {
      same = !!i.expiry && r[exp].slice(0, 10) === i.expiry;
      if (same && i.optionType) same = r[opt] === i.optionType && i.strike != null && Math.abs(Number(r[strike]) - i.strike) < 0.005;
    }
    if (!same) continue;
    if (!out.has(segment)) out.set(segment, new Set());
    out.get(segment)!.add(i.token);
  }
  return out;
}

/** Pure: Dhan's "dd/MM/yyyy HH:mm:ss" (IST) last trade time, epoch ms; its 1980 placeholder and junk → undefined. */
export function parseDhanTradeTime(raw: unknown): number | undefined {
  const m = typeof raw === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim()) : null;
  if (!m || Number(m[3]) < 2000) return undefined;
  const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`);
  return Number.isFinite(t) ? t : undefined;
}

const num = (v: unknown): number | undefined => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const levels = (side: unknown) => (Array.isArray(side) ? side : []).map((d: any) => ({ price: num(d?.price) ?? 0, quantity: num(d?.quantity) ?? 0, orders: num(d?.orders) ?? 0 }));

/** Pure: one instrument of Dhan's quote response as the provider's quote. */
export function quoteFromDhan(token: string, item: any, now: number): ProviderQuote {
  const ltp = num(item?.last_price) ?? 0;
  const netChange = num(item?.net_change);
  const prevClose = netChange != null && ltp > 0 ? Math.round((ltp - netChange) * 100) / 100 : num(item?.ohlc?.close) ?? 0;
  const buy = levels(item?.depth?.buy);
  const sell = levels(item?.depth?.sell);
  const lastTrade = parseDhanTradeTime(item?.last_trade_time);
  return {
    token,
    ltp,
    open: num(item?.ohlc?.open) ?? 0,
    high: num(item?.ohlc?.high) ?? 0,
    low: num(item?.ohlc?.low) ?? 0,
    close: prevClose,
    volume: num(item?.volume) ?? 0,
    oi: num(item?.oi),
    netChange,
    percentChange: netChange != null && prevClose > 0 ? (netChange / prevClose) * 100 : undefined,
    avgPrice: num(item?.average_price),
    bid: buy[0]?.price,
    ask: sell[0]?.price,
    bidQty: buy[0]?.quantity,
    askQty: sell[0]?.quantity,
    depth: item?.depth ? { buy, sell } : undefined,
    timestamp: now,
    ...(lastTrade != null ? { lastTradeTimestamp: lastTrade } : {}),
    source: 'DHAN',
  };
}

// ---------------- routing table (refreshed daily) ----------------

let routable: Map<ExchangeSegment, Set<string>> = new Map();
let routableOn: string | null = null;
let routableLoading: Promise<void> | null = null;
const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Builds today's table in the background; until it exists nothing is routed. */
function refreshRoutable(getInstruments: () => Promise<Instrument[]>, now: number): void {
  if (routableOn === istDate(now) || routableLoading) return;
  routableLoading = (async () => {
    try {
      const [res, instruments] = await Promise.all([axios.get<string>(DHAN_SCRIP_MASTER_URL, { responseType: 'text', timeout: 60_000 }), getInstruments()]);
      routable = verifiedDhanTokens(res.data, instruments);
      routableOn = istDate(now);
      logger.info({ segments: Object.fromEntries([...routable].map(([s, set]) => [s, set.size])) }, 'Dhan quotes: contracts verified against both instrument masters');
    } catch (err: any) {
      logger.warn({ error: err?.message }, 'Dhan quotes: instrument check failed — quotes stay on Angel One');
    } finally {
      routableLoading = null;
    }
  })();
}

/** Tests only. */
export function setRoutableForTest(table: Map<ExchangeSegment, Set<string>>, day: string): void {
  routable = table;
  routableOn = day;
}

// ---------------- the merged-call queue ----------------

interface Pending {
  segment: ExchangeSegment;
  tokens: string[];
  caller: string;
  resolve: (quotes: Map<string, ProviderQuote>) => void;
}

const queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastCallAt = 0;
let pausedUntil = 0;

function schedule(): void {
  if (timer || queue.length === 0) return;
  const wait = Math.max(0, lastCallAt + MIN_CALL_INTERVAL_MS - Date.now(), pausedUntil - Date.now());
  timer = setTimeout(() => {
    timer = null;
    void flush().finally(schedule);
  }, wait);
}

async function flush(): Promise<void> {
  const batch: Pending[] = [];
  let count = 0;
  while (queue.length && (batch.length === 0 || count + queue[0].tokens.length <= MAX_INSTRUMENTS_PER_CALL)) {
    const p = queue.shift()!;
    batch.push(p);
    count += p.tokens.length;
  }
  if (batch.length === 0) return;
  const body: Record<string, number[]> = {};
  for (const p of batch) {
    const key = DHAN_QUOTE_SEGMENT[p.segment].key;
    body[key] = [...new Set([...(body[key] ?? []), ...p.tokens.map(Number)])];
  }
  const session = dhanSession();
  lastCallAt = Date.now();
  let data: any = null;
  let outcome: 'OK' | 'RATE_LIMITED' | 'FAILED' = 'FAILED';
  if (session) {
    try {
      const res = await axios.post(DHAN_QUOTE_URL, body, {
        headers: { 'access-token': session.accessToken, 'client-id': session.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 10_000,
      });
      data = res.data?.data ?? null;
      outcome = data ? 'OK' : 'FAILED';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) markDhanTokenRejected(session.accessToken);
      if (status === 429) {
        outcome = 'RATE_LIMITED';
        pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      }
      logger.warn({ error: err?.message, status: status ?? null, instruments: count }, 'Dhan quotes: call failed — these quotes go to Angel One');
    }
  }
  recordBrokerCall('DHAN', 'quote', 'merged', outcome);
  const now = Date.now();
  for (const p of batch) {
    const bySeg = data?.[DHAN_QUOTE_SEGMENT[p.segment].key] ?? {};
    const out = new Map<string, ProviderQuote>();
    for (const t of p.tokens) if (bySeg[t] && num(bySeg[t].last_price) != null) out.set(t, quoteFromDhan(t, bySeg[t], now));
    recordBrokerCall('DHAN', 'quoteServed', p.caller, out.size > 0 ? 'OK' : 'FAILED');
    p.resolve(out);
  }
}

/**
 * The tokens Dhan can serve right now are fetched from it (merged with every
 * other waiting request); returns what it answered. The caller fetches the
 * rest from Angel One. Never throws.
 */
export async function dhanQuotes(segment: ExchangeSegment, tokens: readonly string[], getInstruments: () => Promise<Instrument[]>): Promise<Map<string, ProviderQuote>> {
  if (QUOTE_PROVIDER !== 'DHAN' || !dhanSession() || Date.now() < pausedUntil) return new Map();
  refreshRoutable(getInstruments, Date.now());
  const ok = routable.get(segment);
  const mine = ok ? [...new Set(tokens.filter((t) => ok.has(t)))] : [];
  if (mine.length === 0) return new Map();
  const chunks: string[][] = [];
  for (let i = 0; i < mine.length; i += MAX_INSTRUMENTS_PER_CALL) chunks.push(mine.slice(i, i + MAX_INSTRUMENTS_PER_CALL));
  const caller = currentCaller();
  const interactive = isInteractiveRequest();
  const parts = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<Map<string, ProviderQuote>>((resolve) => {
          const p: Pending = { segment, tokens: chunk, caller, resolve };
          if (interactive) queue.unshift(p);
          else queue.push(p);
          schedule();
        })
    )
  );
  return new Map(parts.flatMap((m) => [...m]));
}
