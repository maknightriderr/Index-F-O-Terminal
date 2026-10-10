// ============================================================
// READ-ONLY VIEWS — what a page may read without causing anything
// ============================================================
// Opening or refreshing a page used to be able to run the decision engine and
// write: GET /api/market/bias/:symbol runs buildMarketBias (which can mint a
// paper trade and writes decision / slot / option-plan records), and GET
// /api/market-scanner computed a fresh scan on a cache miss (a bias per
// finalist — 105 decision rows on 10 Oct from one page visit).
//
// These readers answer the same questions from what the background jobs have
// ALREADY recorded: Redis caches, the last-known copies those jobs now keep,
// and SELECTs. They never call the engine or the provider, never register
// interest (noteBiasRequest), never scan, never write. When nothing has been
// recorded they say so (`source: 'NONE'` + the reason) instead of computing.
// ============================================================

import type { BiasSnapshot, Exchange, FiiDiiActivity, FnoScannerRow, MarketScanResult, ReadOnlyMeta, ReadSource, TradingMode } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

// Keys the background jobs write (kept here as the single place a reader looks).
export const fnoScanLastKey = (exchange: string): string => `fno-scanner:last:${exchange}`;
export const FNO_SCAN_LAST_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MARKET_SCAN_LATEST_KEY = 'market_scan:latest';
export const MARKET_SCAN_LAST_KEY = 'market_scan:last';
export const MARKET_SCAN_LAST_TTL_SECONDS = 3 * 24 * 60 * 60;
export const biasResultKey = (exchange: string, symbol: string, mode: string): string => `bias_result:${exchange}:${symbol}:${mode}`;
/** The same result, kept 2 days by the engine for display only (the 5-minute cache above expires after the close). */
export const biasLastKey = (exchange: string, symbol: string, mode: string): string => `bias_last:${exchange}:${symbol}:${mode}`;
/** The engine's own cache lifetime for a bias result (market-bias.ts BIAS_RESULT_CACHE_TTL_SECONDS). */
export const BIAS_RESULT_CACHE_TTL_SECONDS = 5 * 60;

export function readMeta(source: ReadSource, asOf: number | null, now: number, unavailableReason?: string): ReadOnlyMeta {
  return {
    readOnly: true,
    source,
    asOf,
    ageSeconds: asOf != null ? Math.max(0, Math.round((now - asOf) / 1000)) : null,
    ...(unavailableReason ? { unavailableReason } : {}),
    timestamp: now,
  };
}

async function getJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err: any) {
    logger.warn({ error: err.message, key }, 'Read-only view: cache read failed');
    return null;
  }
}

// ---------------- F&O universe scan ----------------

/** The newest F&O scan already recorded: the live cache, else the last-known copy. Never recomputes. */
export async function readFnoScan(exchange: Exchange, now = Date.now()): Promise<{ data: FnoScannerRow[]; meta: ReadOnlyMeta }> {
  const live = await getJson<FnoScannerRow[]>(`fno-scanner:${exchange}`);
  if (live && live.length > 0) {
    const asOf = Math.max(...live.map((r) => r.timestamp || 0)) || null;
    return { data: live, meta: readMeta('CACHE', asOf, now) };
  }
  const last = await getJson<{ at: number; rows: FnoScannerRow[] }>(fnoScanLastKey(exchange));
  if (last?.rows?.length) return { data: last.rows, meta: readMeta('LAST_KNOWN', last.at ?? null, now) };
  return { data: [], meta: readMeta('NONE', null, now, 'No F&O scan has been recorded yet (the background scan runs while the exchange is open).') };
}

// ---------------- market scanner ----------------

/** The newest market scan already recorded (live cache, else last known). Never runs a scan. */
export async function readMarketScan(now = Date.now()): Promise<{ data: MarketScanResult | null; meta: ReadOnlyMeta }> {
  const live = await getJson<MarketScanResult>(MARKET_SCAN_LATEST_KEY);
  if (live) return { data: live, meta: readMeta('CACHE', live.scannedAt ?? null, now) };
  const last = await getJson<MarketScanResult>(MARKET_SCAN_LAST_KEY);
  if (last) return { data: last, meta: readMeta('LAST_KNOWN', last.scannedAt ?? null, now) };
  return { data: null, meta: readMeta('NONE', null, now, 'No market scan has been recorded yet (the background scan runs every 5 minutes while NSE is open).') };
}

// ---------------- bias ----------------

interface CachedBiasResult {
  bias?: { direction?: string; confidence?: number; regime?: string; timestamp?: number; inputs?: Record<string, unknown> };
  score?: { score?: number };
}

/** Pure: the snapshot of the engine's cached result. */
export function snapshotFromCachedResult(symbol: string, exchange: Exchange, mode: TradingMode, result: CachedBiasResult): BiasSnapshot {
  const b = result.bias ?? {};
  const inputs = (b.inputs ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    symbol,
    exchange,
    mode,
    direction: (b.direction as BiasSnapshot['direction']) ?? null,
    confidence: num(b.confidence),
    regime: b.regime ?? null,
    origin: 'ENGINE_CACHE',
    assessedAt: num(b.timestamp),
    pcr: num(inputs.pcr),
    vix: num(inputs.vix),
    underlyingPrice: num(inputs.spot) ?? num(inputs.underlyingPrice),
    result,
    reason: null,
  };
}

/**
 * The last assessment of a symbol: the engine's cached result when it is still cached, else the last
 * decision record (a SELECT). Never builds a bias, never registers the symbol for background warming.
 */
export async function readBiasSnapshot(symbol: string, exchange: Exchange, mode: TradingMode, now = Date.now()): Promise<{ data: BiasSnapshot | null; meta: ReadOnlyMeta }> {
  const cached = await getJson<CachedBiasResult>(biasResultKey(exchange, symbol, mode));
  if (cached?.bias) {
    const snap = snapshotFromCachedResult(symbol, exchange, mode, cached);
    return { data: snap, meta: readMeta('CACHE', snap.assessedAt, now) };
  }
  const last = await getJson<CachedBiasResult>(biasLastKey(exchange, symbol, mode));
  if (last?.bias) {
    const snap = snapshotFromCachedResult(symbol, exchange, mode, last);
    return { data: snap, meta: readMeta('LAST_KNOWN', snap.assessedAt, now) };
  }
  try {
    const rows = await sql<
      { time: Date; regime: string | null; bias: string | null; confidence: string | null; pcr: string | null; vix: string | null; underlying_price: string | null; reason: string | null }[]
    >`
      SELECT time, regime, bias, confidence, pcr, vix, underlying_price, reason
      FROM decision_snapshots
      WHERE symbol = ${symbol} AND exchange = ${exchange} AND mode = ${mode}
      ORDER BY time DESC LIMIT 1
    `;
    const r = rows[0];
    if (r) {
      const n = (v: string | null) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
      const at = new Date(r.time).getTime();
      const data: BiasSnapshot = {
        symbol,
        exchange,
        mode,
        direction: (r.bias as BiasSnapshot['direction']) ?? null,
        confidence: n(r.confidence),
        regime: r.regime,
        origin: 'LAST_DECISION_RECORD',
        assessedAt: at,
        pcr: n(r.pcr),
        vix: n(r.vix),
        underlyingPrice: n(r.underlying_price),
        result: null,
        reason: r.reason,
      };
      return { data, meta: readMeta('DATABASE', at, now) };
    }
  } catch (err: any) {
    logger.warn({ error: err.message, symbol }, 'Read-only view: last decision lookup failed');
  }
  return { data: null, meta: readMeta('NONE', null, now, 'No assessment has been recorded for this symbol yet.') };
}

// ---------------- FII / DII ----------------

/** The latest FII/DII figures already recorded (cache, else the newest history row). Never calls NSE. */
export async function readLatestFiiDii(now = Date.now()): Promise<{ data: FiiDiiActivity | null; meta: ReadOnlyMeta }> {
  const live = await getJson<FiiDiiActivity>('fii_dii:latest');
  if (live) return { data: live, meta: readMeta('CACHE', live.fetchedAt ?? null, now) };
  try {
    const rows = await sql<{ date: string; fii_buy: string; fii_sell: string; fii_net: string; dii_buy: string; dii_sell: string; dii_net: string; fetched_at: Date }[]>`
      SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, fetched_at FROM fii_dii_history ORDER BY fetched_at DESC LIMIT 1
    `;
    const r = rows[0];
    if (r) {
      const at = new Date(r.fetched_at).getTime();
      return {
        data: {
          date: r.date,
          fii: { buyValue: Number(r.fii_buy), sellValue: Number(r.fii_sell), netValue: Number(r.fii_net) },
          dii: { buyValue: Number(r.dii_buy), sellValue: Number(r.dii_sell), netValue: Number(r.dii_net) },
          fetchedAt: at,
        },
        meta: readMeta('DATABASE', at, now),
      };
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Read-only view: latest FII/DII lookup failed');
  }
  return { data: null, meta: readMeta('NONE', null, now, 'No FII/DII figures have been recorded yet.') };
}
