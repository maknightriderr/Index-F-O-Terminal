// ============================================================
// F&O STOCK UNIVERSE SCANNER
// ============================================================
// Live price/OI/PCR/IV/bias for every NSE equity that has F&O
// contracts (~180-200 stocks) — the data behind the F&O Stocks
// page and the Dashboard's F&O Market Activity table.
//
// Deliberately quote-only: no historical-candle or broker-Greeks
// calls anywhere in this file. Those two endpoints are the ones
// Angel One rate-limits hard (see market-bias.ts) — doing that per
// stock across ~180 stocks would trip the same 403s we already
// fixed once. IV here comes from our own Black-Scholes engine off
// live LTP, and bias/score are a lighter OI+PCR+price composite,
// not the full RSI/VWAP/Supertrend engine used for a single asset's
// deep-dive tab — that trade-off is what keeps a full-universe scan
// to ~40 quote requests instead of thousands.
// ============================================================

import { CM_SEGMENT, FO_SEGMENT, RISK_FREE_RATE, getATMStrike, calculateDTE, yearsToExpiry } from '@fno/shared';
import type { Exchange, Instrument, OIInterpretation, BiasDirection, FnoScannerRow, Greeks } from '@fno/shared';
import { classifyFuturesOI, calculateGreeksFromPrice } from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { computeChangeOi } from '../lib/oi-baseline.js';
import { inferStrikeInterval } from './option-chain.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export type { FnoScannerRow };

const NEAR_ATM_STRIKES = 2; // ±2 strikes around ATM — enough for a meaningful near-money PCR/IV without pulling every strike of every stock

interface StockEntry {
  symbol: string;
  eq: Instrument;
  futures: Instrument[];
  options: Instrument[];
}

export async function scanFnoUniverse(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<FnoScannerRow[]> {
  const instruments = await provider.getInstrumentMaster();
  const stocks = buildStockIndex(instruments, exchange);

  if (stocks.length === 0) return [];

  // Round 1: every stock's cash-market quote (price, change%, volume).
  const eqQuotes = await provider.getQuote(CM_SEGMENT[exchange], stocks.map((s) => s.eq.token), 'FULL');
  const eqByToken = new Map(eqQuotes.map((q) => [q.token, q]));

  // Round 2: each stock's nearest-expiry futures contract.
  const nearestFutures = stocks
    .map((s) => ({ stock: s, inst: nearestExpiryInstrument(s.futures) }))
    .filter((x): x is { stock: StockEntry; inst: Instrument } => !!x.inst);
  const futQuotes = await provider.getQuote(FO_SEGMENT[exchange], nearestFutures.map((f) => f.inst.token), 'FULL');
  const futByToken = new Map(futQuotes.map((q) => [q.token, q]));

  // Round 3: near-ATM option strikes, resolved per-stock now that spot prices are known.
  interface Pick {
    symbol: string;
    expiry: string;
    atmStrike: number;
    strikes: Array<{ strike: number; call?: string; put?: string }>;
  }
  const picks: Pick[] = [];
  for (const s of stocks) {
    const spot = eqByToken.get(s.eq.token)?.ltp;
    if (!spot || spot <= 0) continue;

    const nearestExpiry = [...new Set(s.options.map((o) => o.expiry).filter((e): e is string => !!e))].sort()[0];
    if (!nearestExpiry) continue;

    const forExpiry = s.options.filter((o) => o.expiry === nearestExpiry && o.strike !== undefined);
    const allStrikes = Array.from(new Set(forExpiry.map((o) => o.strike!))).sort((a, b) => a - b);
    if (allStrikes.length === 0) continue;

    const interval = inferStrikeInterval(allStrikes);
    const atmStrike = getATMStrike(spot, interval);
    const atmIdx = allStrikes.reduce(
      (best, strike, i) => (Math.abs(strike - atmStrike) < Math.abs(allStrikes[best] - atmStrike) ? i : best),
      0
    );
    const selected = new Set(allStrikes.slice(Math.max(0, atmIdx - NEAR_ATM_STRIKES), atmIdx + NEAR_ATM_STRIKES + 1));

    const byStrike = new Map<number, { strike: number; call?: string; put?: string }>();
    for (const o of forExpiry) {
      if (!selected.has(o.strike!)) continue;
      const entry = byStrike.get(o.strike!) ?? { strike: o.strike! };
      if (o.optionType === 'CE') entry.call = o.token;
      else if (o.optionType === 'PE') entry.put = o.token;
      byStrike.set(o.strike!, entry);
    }

    picks.push({ symbol: s.symbol, expiry: nearestExpiry, atmStrike, strikes: Array.from(byStrike.values()) });
  }

  const allOptionTokens = picks.flatMap((p) => p.strikes.flatMap((s) => [s.call, s.put].filter((t): t is string => !!t)));
  const optQuotes = allOptionTokens.length > 0 ? await provider.getQuote(FO_SEGMENT[exchange], allOptionTokens, 'FULL') : [];
  const optByToken = new Map(optQuotes.map((q) => [q.token, q]));

  const pickBySymbol = new Map(picks.map((p) => [p.symbol, p]));
  const now = Date.now();

  const rows: FnoScannerRow[] = [];
  const ivInputs: Array<{ symbol: string; atmIv: number; ceIv: number; peIv: number; ivSkew: number }> = [];

  for (const { stock, inst: futInst } of nearestFutures) {
    const eqQuote = eqByToken.get(stock.eq.token);
    const futQuote = futByToken.get(futInst.token);
    if (!eqQuote || eqQuote.ltp <= 0 || !futQuote) continue;

    const changePercent = eqQuote.close > 0 ? ((eqQuote.ltp - eqQuote.close) / eqQuote.close) * 100 : 0;
    const futChangePercent = futQuote.close > 0 ? ((futQuote.ltp - futQuote.close) / futQuote.close) * 100 : 0;
    const futuresOi = futQuote.oi ?? 0;
    const futuresChangeOi = await computeChangeOi(futInst.token, futuresOi);
    const previousOi = futuresOi - futuresChangeOi;
    const futuresChangeOiPercent = previousOi > 0 ? (futuresChangeOi / previousOi) * 100 : 0;
    const oiInterpretation = classifyFuturesOI({ priceChange: futChangePercent, oiChange: futuresChangeOi });

    const pick = pickBySymbol.get(stock.symbol);
    let pcr = 0;
    let atmIv = 0;
    let ceIv = 0;
    let peIv = 0;
    let atmGamma = 0;
    let atmTheta = 0;
    let atmVega = 0;

    if (pick) {
      let callOi = 0;
      let putOi = 0;
      for (const s of pick.strikes) {
        if (s.call) callOi += optByToken.get(s.call)?.oi ?? 0;
        if (s.put) putOi += optByToken.get(s.put)?.oi ?? 0;
      }
      pcr = callOi > 0 ? putOi / callOi : 0;

      const atmEntry = pick.strikes.find((s) => s.strike === pick.atmStrike);
      const dte = calculateDTE(pick.expiry);
      const tte = yearsToExpiry(pick.expiry);
      let callGreeks: Greeks | null = null;
      let putGreeks: Greeks | null = null;
      if (dte > 0) {
        for (const [token, type] of [[atmEntry?.call, 'CE'], [atmEntry?.put, 'PE']] as const) {
          if (!token) continue;
          const q = optByToken.get(token);
          if (!q || q.ltp <= 0) continue;
          const greeks = calculateGreeksFromPrice(q.ltp, eqQuote.ltp, pick.atmStrike, tte, type, RISK_FREE_RATE);
          if (greeks.iv <= 0) continue;
          if (type === 'CE') callGreeks = greeks;
          else putGreeks = greeks;
        }
      }
      ceIv = callGreeks ? callGreeks.iv * 100 : 0;
      peIv = putGreeks ? putGreeks.iv * 100 : 0;
      const ivSamples = [ceIv, peIv].filter((v) => v > 0);
      atmIv = ivSamples.length > 0 ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0;
      atmGamma = avgOfDefined(callGreeks?.gamma, putGreeks?.gamma);
      atmVega = avgOfDefined(callGreeks?.vega, putGreeks?.vega);
      atmTheta = (callGreeks?.theta ?? 0) + (putGreeks?.theta ?? 0);
    }

    const ivSkew = ceIv > 0 && peIv > 0 ? ceIv - peIv : 0;
    const { direction, confidence, score } = lightweightBias(changePercent, oiInterpretation, pcr);

    if (atmIv > 0) ivInputs.push({ symbol: stock.symbol, atmIv, ceIv, peIv, ivSkew });

    rows.push({
      symbol: stock.symbol,
      exchange,
      price: eqQuote.ltp,
      changePercent,
      volume: eqQuote.volume,
      futuresOi,
      futuresChangeOi,
      futuresChangeOiPercent,
      oiInterpretation,
      pcr,
      atmIv,
      ceIv,
      peIv,
      ivSkew,
      ivRank: null, // filled in below
      ivPercentile: null, // filled in below
      atmGamma,
      atmTheta,
      atmVega,
      direction,
      confidence,
      score,
      timestamp: now,
    });
  }

  const ivRanks = await computeIvRanks(ivInputs);
  for (const row of rows) {
    const r = ivRanks.get(row.symbol);
    row.ivRank = r?.ivRank ?? null;
    row.ivPercentile = r?.ivPercentile ?? null;
  }

  return rows.sort((a, b) => b.score - a.score);
}

function avgOfDefined(a?: number, b?: number): number {
  if (a != null && b != null) return (a + b) / 2;
  return a ?? b ?? 0;
}

// --- Universe indexing ---

function buildStockIndex(instruments: Instrument[], exchange: Exchange): StockEntry[] {
  const byUnderlying = new Map<string, { futures: Instrument[]; options: Instrument[] }>();

  for (const inst of instruments) {
    if (inst.exchange !== exchange) continue;
    if (inst.instrumentType !== 'FUTSTK' && inst.instrumentType !== 'OPTSTK') continue;
    const key = inst.underlying || inst.symbol;
    const entry = byUnderlying.get(key) ?? { futures: [], options: [] };
    if (inst.instrumentType === 'FUTSTK') entry.futures.push(inst);
    else entry.options.push(inst);
    byUnderlying.set(key, entry);
  }

  const eqByUnderlying = new Map<string, Instrument>();
  for (const inst of instruments) {
    if (inst.exchange !== exchange || inst.instrumentType !== 'EQ') continue;
    const key = inst.underlying || inst.symbol;
    if (byUnderlying.has(key) && !eqByUnderlying.has(key)) eqByUnderlying.set(key, inst);
  }

  const stocks: StockEntry[] = [];
  for (const [symbol, { futures, options }] of byUnderlying) {
    const eq = eqByUnderlying.get(symbol);
    if (!eq || futures.length === 0 || options.length === 0) continue;
    stocks.push({ symbol, eq, futures, options });
  }
  return stocks;
}

function nearestExpiryInstrument(instruments: Instrument[]): Instrument | undefined {
  return [...instruments]
    .filter((i) => i.expiry)
    .sort((a, b) => (a.expiry! < b.expiry! ? -1 : a.expiry! > b.expiry! ? 1 : 0))[0];
}

// --- Lightweight bias/score composite ---
// Same -1/0/1 voting shape as the single-asset engine in market-bias.ts,
// but built only from signals already fetched here (price change, futures
// OI buildup, PCR) — no RSI/VWAP/Supertrend, which would need historical
// candles per stock. See the file header for why.

function lightweightBias(
  changePercent: number,
  oiInterpretation: OIInterpretation,
  pcr: number
): { direction: BiasDirection; confidence: number; score: number } {
  const priceVote = changePercent > 0.3 ? 1 : changePercent < -0.3 ? -1 : 0;
  const oiVote =
    oiInterpretation === 'LONG_BUILDUP' || oiInterpretation === 'SHORT_COVERING'
      ? 1
      : oiInterpretation === 'SHORT_BUILDUP' || oiInterpretation === 'LONG_UNWINDING'
      ? -1
      : 0;
  const pcrVote = pcr > 1.1 ? 1 : pcr < 0.85 ? -1 : 0;

  const votes = [priceVote, oiVote, pcrVote];
  const sum = votes.reduce((a, b) => a + b, 0);
  const direction: BiasDirection = sum > 0 ? 'BULLISH' : sum < 0 ? 'BEARISH' : 'NEUTRAL';

  const agreement =
    direction === 'BULLISH'
      ? votes.filter((v) => v === 1).length
      : direction === 'BEARISH'
      ? votes.filter((v) => v === -1).length
      : votes.filter((v) => v === 0).length;
  const confidence = Math.round((agreement / votes.length) * 100);
  const score = Math.max(5, Math.min(95, Math.round(50 + sum * 15)));

  return { direction, confidence, score };
}

// --- IV Rank (persisted daily to Postgres) ---
// IV Rank needs history, which this terminal has only just started
// collecting — it reads null (shown as "—") for a symbol until at least
// two days of snapshots exist, and naturally gets more meaningful as the
// terminal keeps running day over day. At most one row is written per
// symbol per day (checked in bulk below), so intraday scans don't flood
// the table with noise that would skew the range toward "today only".

interface IvRankResult {
  ivRank: number | null;
  ivPercentile: number | null;
}

async function computeIvRanks(
  inputs: Array<{ symbol: string; atmIv: number; ceIv: number; peIv: number; ivSkew: number }>
): Promise<Map<string, IvRankResult>> {
  const result = new Map<string, IvRankResult>();
  if (inputs.length === 0) return result;

  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const symbols = inputs.map((r) => r.symbol);

    const existingToday = await sql<{ symbol: string }[]>`
      SELECT DISTINCT symbol FROM iv_history WHERE symbol = ANY(${symbols}) AND time::date = ${today}
    `;
    const already = new Set(existingToday.map((r) => r.symbol));

    const toInsert = inputs.filter((r) => !already.has(r.symbol));
    if (toInsert.length > 0) {
      await sql`
        INSERT INTO iv_history ${sql(toInsert.map((r) => ({
          time: new Date(),
          symbol: r.symbol,
          atm_iv: r.atmIv,
          ce_iv: r.ceIv || null,
          pe_iv: r.peIv || null,
          iv_skew: r.ivSkew || null,
        })))}
      `;
    }

    const stats = await sql<{ symbol: string; values: string[] }[]>`
      SELECT symbol, array_agg(atm_iv ORDER BY atm_iv) as values
      FROM iv_history
      WHERE symbol = ANY(${symbols}) AND time > NOW() - INTERVAL '365 days' AND atm_iv IS NOT NULL
      GROUP BY symbol
    `;
    const statsBySymbol = new Map(stats.map((s) => [s.symbol, s.values.map(Number)]));

    for (const { symbol, atmIv } of inputs) {
      const values = statsBySymbol.get(symbol) ?? [];
      if (values.length < 2) {
        result.set(symbol, { ivRank: null, ivPercentile: null });
        continue;
      }
      const min = values[0];
      const max = values[values.length - 1];
      const ivRank = max === min ? null : Math.round(Math.max(0, Math.min(100, ((atmIv - min) / (max - min)) * 100)));
      const countLE = values.filter((v) => v <= atmIv).length;
      const ivPercentile = Math.round((countLE / values.length) * 100);
      result.set(symbol, { ivRank, ivPercentile });
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'IV rank batch computation failed — returning nulls');
    for (const { symbol } of inputs) result.set(symbol, { ivRank: null, ivPercentile: null });
  }

  return result;
}
