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

import { CM_SEGMENT, FO_SEGMENT, RISK_FREE_RATE, KNOWN_INDEX_TOKENS, getATMStrike, yearsToExpiry, isExpiryActive, isMarketOpen, minutesSinceSessionOpen } from '@fno/shared';
import type { Exchange, Instrument, OIInterpretation, BiasDirection, FnoScannerRow, Greeks } from '@fno/shared';
import { classifyFuturesOI, calculateGreeksFromPrice } from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { computeChangeOi } from '../lib/oi-baseline.js';
import { inferStrikeInterval } from './option-chain.js';
import { sql } from '../lib/db.js';
import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { stockExpiryInForce, ivClockCorrection } from './iv-history-clock.js';
import { logger } from '../lib/logger.js';

export type { FnoScannerRow };

const NEAR_ATM_STRIKES = 2; // ±2 strikes around ATM — enough for a meaningful near-money PCR/IV without pulling every strike of every stock

interface StockEntry {
  symbol: string;
  eq: Instrument;
  futures: Instrument[];
  options: Instrument[];
}

// --- Shared scan cache ---
// Every reader of the universe scan (F&O Stocks / IV & Greeks / OI pages,
// alerts, chart patterns, institutional flow, the assistant) goes through
// getFnoScan, so they share one cached scan. While the exchange trades it
// lives FNO_SCAN_LIVE_TTL_SECONDS; outside the session the quotes are frozen,
// so it lives FNO_SCAN_CLOSED_TTL_SECONDS instead of re-running a ~20s scan
// every few minutes for nothing. The cache warmer keeps it hot in session.
export const FNO_SCAN_LIVE_TTL_SECONDS = 180;
export const FNO_SCAN_CLOSED_TTL_SECONDS = 30 * 60;

export function fnoScanCacheKey(exchange: Exchange): string {
  return `fno-scanner:${exchange}`;
}

function fnoScanTtl(exchange: Exchange): number {
  return isMarketOpen(exchange) ? FNO_SCAN_LIVE_TTL_SECONDS : FNO_SCAN_CLOSED_TTL_SECONDS;
}

export function getFnoScan(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<FnoScannerRow[]> {
  return cached(fnoScanCacheKey(exchange), fnoScanTtl(exchange), () => scanFnoUniverse(provider, exchange), (rows) => rows.length > 0);
}

/** Recomputes the scan and replaces the cached copy — for the warmer, which refreshes before expiry. */
export async function refreshFnoScan(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<number> {
  const rows = await scanFnoUniverse(provider, exchange);
  if (rows.length > 0) await redis.set(fnoScanCacheKey(exchange), JSON.stringify(rows), 'EX', fnoScanTtl(exchange));
  return rows.length;
}

export async function scanFnoUniverse(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<FnoScannerRow[]> {
  const instruments = await provider.getInstrumentMaster();
  const stocks = buildStockIndex(instruments, exchange);

  if (stocks.length === 0) return [];

  // Round 1: every stock's cash-market quote (price, change%, volume).
  const eqQuotes = await provider.getQuote(CM_SEGMENT[exchange], stocks.map((s) => s.eq.token), 'FULL');
  const eqByToken = new Map(eqQuotes.map((q) => [q.token, q]));

  // One extra quote for the whole scan (not per-stock) — NIFTY's own
  // today's change%, the baseline every stock's relative strength is
  // measured against. A stock up 2% while NIFTY is up 3% is actually
  // underperforming despite the green number; relative strength is what
  // separates "moving with the market" from a genuine standout.
  const niftyToken = KNOWN_INDEX_TOKENS.NIFTY;
  let niftyChangePercent = 0;
  if (exchange === 'NSE' && niftyToken) {
    try {
      const [niftyQuote] = await provider.getQuote(CM_SEGMENT.NSE, [niftyToken], 'FULL');
      if (niftyQuote && niftyQuote.close > 0) {
        niftyChangePercent = ((niftyQuote.ltp - niftyQuote.close) / niftyQuote.close) * 100;
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'F&O scanner: NIFTY baseline quote failed — relative strength will read as raw changePercent');
    }
  }

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

    const nearestExpiry = [...new Set(s.options.map((o) => o.expiry).filter(isExpiryActive))].sort()[0];
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
  const ivInputs: IvInput[] = [];

  for (const { stock, inst: futInst } of nearestFutures) {
    const eqQuote = eqByToken.get(stock.eq.token);
    const futQuote = futByToken.get(futInst.token);
    if (!eqQuote || eqQuote.ltp <= 0 || !futQuote) continue;

    const changePercent = eqQuote.close > 0 ? ((eqQuote.ltp - eqQuote.close) / eqQuote.close) * 100 : 0;
    const futChangePercent = futQuote.close > 0 ? ((futQuote.ltp - futQuote.close) / futQuote.close) * 100 : 0;
    const futuresOi = futQuote.oi ?? 0;
    const futuresChangeOi = await computeChangeOi(futInst.token, futuresOi, exchange);
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
    let atmSpreadPct: number | null = null;

    if (pick) {
      let callOi = 0;
      let putOi = 0;
      for (const s of pick.strikes) {
        if (s.call) callOi += optByToken.get(s.call)?.oi ?? 0;
        if (s.put) putOi += optByToken.get(s.put)?.oi ?? 0;
      }
      pcr = callOi > 0 ? putOi / callOi : 0;

      const atmEntry = pick.strikes.find((s) => s.strike === pick.atmStrike);
      // Measured to the expiry session's close, so expiry day still has a
      // solvable IV (it read 0 all session when this was cut off at midnight).
      const tte = yearsToExpiry(pick.expiry, exchange);
      let callGreeks: Greeks | null = null;
      let putGreeks: Greeks | null = null;
      if (tte > 0) {
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
      // Newton-Raphson can converge to extreme values for illiquid / deep-OTM
      // options — cap at 500% so downstream IV rank / display doesn't get
      // poisoned by a solver artefact.
      const MAX_SANE_IV_PCT = 500;
      if (ceIv > MAX_SANE_IV_PCT) ceIv = 0;
      if (peIv > MAX_SANE_IV_PCT) peIv = 0;
      const ivSamples = [ceIv, peIv].filter((v) => v > 0);
      atmIv = ivSamples.length > 0 ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0;
      // All three ATM Greeks represent the same thing: the average/
      // representative ATM leg, not a 2-leg straddle position — consistent
      // with how they're displayed side-by-side in the IV & Greeks table.
      // (strategy-recommender.ts doubles this back to a straddle reading
      // where it actually needs one.)
      atmGamma = avgOfDefined(callGreeks?.gamma, putGreeks?.gamma);
      atmVega = avgOfDefined(callGreeks?.vega, putGreeks?.vega);
      atmTheta = avgOfDefined(callGreeks?.theta, putGreeks?.theta);

      // Real liquidity signal, not a volume/OI proxy — the SAME bid-ask
      // spread trade-setup/index.ts's naked-long path gates on
      // (MAX_ATM_SPREAD_PCT), computed here from quotes already fetched
      // above for IV/PCR (Round 3), so this costs nothing extra. Average
      // of call+put ATM spread when both quote a genuine two-sided
      // market; whichever one does when only one does; null (not 0 —
      // 0% would misleadingly read as perfectly liquid) when neither
      // does this tick.
      const spreadPctOf = (token: string | undefined): number | null => {
        if (!token) return null;
        const q = optByToken.get(token);
        if (!q || !q.bid || !q.ask || q.bid <= 0 || q.ask <= 0) return null;
        const mid = (q.bid + q.ask) / 2;
        return mid > 0 ? ((q.ask - q.bid) / mid) * 100 : null;
      };
      const spreadSamples = [spreadPctOf(atmEntry?.call), spreadPctOf(atmEntry?.put)].filter((v): v is number => v != null);
      atmSpreadPct = spreadSamples.length > 0 ? Math.round((spreadSamples.reduce((a, b) => a + b, 0) / spreadSamples.length) * 100) / 100 : null;
    }

    const ivSkew = ceIv > 0 && peIv > 0 ? ceIv - peIv : 0;
    const { direction, confidence, score } = lightweightBias(changePercent, oiInterpretation, futuresChangeOiPercent, pcr);

    if (atmIv > 0 && pick) ivInputs.push({ symbol: stock.symbol, expiry: pick.expiry, atmIv, ceIv, peIv, ivSkew });

    rows.push({
      symbol: stock.symbol,
      exchange,
      price: eqQuote.ltp,
      changePercent,
      futuresChangePercent: futChangePercent,
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
      atmSpreadPct,
      direction,
      confidence,
      score,
      relativeStrength: Math.round((changePercent - niftyChangePercent) * 100) / 100,
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
    .filter((i) => isExpiryActive(i.expiry))
    .sort((a, b) => (a.expiry! < b.expiry! ? -1 : a.expiry! > b.expiry! ? 1 : 0))[0];
}

// --- Lightweight bias/score composite ---
// Same -1/0/1 voting shape as the single-asset engine in market-bias.ts,
// but built only from signals already fetched here (price change, futures
// OI buildup, PCR) — no RSI/VWAP/Supertrend, which would need historical
// candles per stock. See the file header for why.

const LIGHT_PRICE_DEADBAND_PCT = 0.3;
const LIGHT_PRICE_FULL_PCT = 2;
const LIGHT_OI_FULL_PCT = 3;
const LIGHT_PCR_BULL = 1.0;
const LIGHT_PCR_BEAR = 0.6;
const LIGHT_DIRECTION_MIN = 0.12;

function lightweightBias(
  changePercent: number,
  oiInterpretation: OIInterpretation,
  futuresChangeOiPercent: number,
  pcr: number
): { direction: BiasDirection; confidence: number; score: number } {
  // Three graded reads instead of three ±1 votes: a +0.31% day and a +4% day
  // used to count the same, so confidence could only be 33, 67 or 100 and a
  // third of the universe read "100%". Each read is scaled to [-1, 1] by how
  // decisive it is, then weighted.
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const priceRead = Math.abs(changePercent) < LIGHT_PRICE_DEADBAND_PCT ? 0 : clamp(changePercent / LIGHT_PRICE_FULL_PCT);
  const oiSign =
    oiInterpretation === 'LONG_BUILDUP' || oiInterpretation === 'SHORT_COVERING'
      ? 1
      : oiInterpretation === 'SHORT_BUILDUP' || oiInterpretation === 'LONG_UNWINDING'
      ? -1
      : 0;
  const oiRead = oiSign * Math.min(1, Math.abs(futuresChangeOiPercent) / LIGHT_OI_FULL_PCT);
  // Near-ATM stock PCR: heavy put OI (writers defending) leans bullish, heavy
  // call OI leans bearish. Stock chains sit lower than index chains, so the
  // bands are wider than the index 1.1/0.85 that almost never fired here.
  const pcrRead = pcr <= 0 ? 0 : pcr >= LIGHT_PCR_BULL ? Math.min(1, (pcr - LIGHT_PCR_BULL) / 0.5 + 0.5) : pcr <= LIGHT_PCR_BEAR ? -Math.min(1, (LIGHT_PCR_BEAR - pcr) / 0.3 + 0.5) : 0;

  const reads = [
    { weight: 0.4, value: priceRead },
    { weight: 0.4, value: oiRead },
    { weight: 0.2, value: pcrRead },
  ];
  const net = reads.reduce((a, r) => a + r.weight * r.value, 0);
  const direction: BiasDirection = net >= LIGHT_DIRECTION_MIN ? 'BULLISH' : net <= -LIGHT_DIRECTION_MIN ? 'BEARISH' : 'NEUTRAL';

  const evidence = reads.reduce((a, r) => a + r.weight * Math.abs(r.value), 0); // 0..1
  let confidence: number;
  if (direction === 'NEUTRAL') {
    confidence = Math.round(100 * (1 - evidence));
  } else {
    const sign = direction === 'BULLISH' ? 1 : -1;
    const agree = reads.reduce((a, r) => a + (Math.sign(r.value) === sign ? r.weight * Math.abs(r.value) : 0), 0);
    const share = evidence > 0 ? agree / evidence : 0;
    confidence = Math.round(100 * share * (0.5 + 0.5 * evidence));
  }
  confidence = Math.max(5, Math.min(95, confidence));
  const score = Math.max(5, Math.min(95, Math.round(50 + net * 45)));

  return { direction, confidence, score };
}

// --- IV Rank (persisted daily to Postgres) ---
// IV Rank needs history, which this terminal has only just started
// collecting — it reads null (shown as "—") for a symbol until at least
// MIN_IV_HISTORY_DAYS snapshots exist, and naturally gets more meaningful
// as the terminal keeps running day over day. At most one row is written
// per symbol per day (checked in bulk below), so intraday scans don't
// flood the table with noise that would skew the range toward "today only".
//
// The minimum is 5, not 2: with only 2 data points, (current-min)/(max-min)
// is mathematically forced to be exactly 0 or 100 for every symbol — every
// consumer of ivRank (the IV & Greeks / F&O Stocks tables, the Strategy
// Scanner's high/low-IV branch, the Alerts spike/crush check) would treat
// that as a genuine extreme and act on it uniformly, which is noise from
// the sample size, not a real signal. See the IV_SPIKE alert incident this
// was first caught from.

const MIN_IV_HISTORY_DAYS = 5;

interface IvRankResult {
  ivRank: number | null;
  ivPercentile: number | null;
}

interface IvInput {
  symbol: string;
  expiry: string;
  atmIv: number;
  ceIv: number;
  peIv: number;
  ivSkew: number;
}

// One IV sample per stock per trading day feeds IV Rank. It's taken from a
// scan at least IV_SAMPLE_MIN_MINUTES into the NSE session: the first scan of
// the day used to be whatever ran first — often just after midnight or
// before the open, off frozen quotes — and the "already sampled today"
// check compared the database's UTC date with the IST date.
const IV_SAMPLE_MIN_MINUTES = 30;

/**
 * IV rank for one symbol, for the option-quality read on a trade setup.
 *
 * The option-quality engine needs to know whether the premium it is about to
 * buy sits high or low in its own trailing year, and the bias engine had no
 * access to that — the rank was computed only inside the F&O scan's batch.
 * This wraps the same batch path for a single symbol and caches the answer
 * for a few minutes, because the rank moves on a daily sample and a bias
 * poll must not pay a database round trip for it every time.
 *
 * Returns null whenever the rank is genuinely unknown (too little recorded
 * history, or the query failed). Null means "no information" and the
 * option-quality engine falls back to the IV-vs-realised read alone; it must
 * never be read as a mid-range rank.
 */
export async function ivRankFor(symbol: string, expiry: string, atmIvPct: number): Promise<number | null> {
  if (!(atmIvPct > 0)) return null;
  const cacheKey = `iv_rank_one:${symbol}:${expiry}:${Math.round(atmIvPct * 10)}`;
  const ranks = await cached(cacheKey, IV_RANK_LOOKUP_TTL_SECONDS, async () => {
    const map = await computeIvRanks([{ symbol, expiry, atmIv: atmIvPct, ceIv: 0, peIv: 0, ivSkew: 0 }]);
    return { ivRank: map.get(symbol)?.ivRank ?? null };
  });
  return ranks?.ivRank ?? null;
}

const IV_RANK_LOOKUP_TTL_SECONDS = 300;

async function computeIvRanks(inputs: IvInput[]): Promise<Map<string, IvRankResult>> {
  const result = new Map<string, IvRankResult>();
  if (inputs.length === 0) return result;

  try {
    await repairIvHistoryClockOnce();
    await dedupeIvHistoryOnce();

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const symbols = inputs.map((r) => r.symbol);
    const minutesIn = minutesSinceSessionOpen('NSE');

    if (minutesIn != null && minutesIn >= IV_SAMPLE_MIN_MINUTES) {
      const existingToday = await sql<{ symbol: string }[]>`
        SELECT DISTINCT symbol FROM iv_history
        WHERE symbol = ANY(${symbols}) AND (time AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date
      `;
      const already = new Set(existingToday.map((r) => r.symbol));

      const toInsert = inputs.filter((r) => !already.has(r.symbol));
      if (toInsert.length > 0) {
        await sql`
          INSERT INTO iv_history ${sql(toInsert.map((r) => ({
            time: new Date(),
            symbol: r.symbol,
            expiry: r.expiry,
            atm_iv: r.atmIv,
            ce_iv: r.ceIv || null,
            pe_iv: r.peIv || null,
            iv_skew: r.ivSkew || null,
          })))}
        `;
      }
    }

    const stats = await sql<{ symbol: string; values: string[] }[]>`
      SELECT symbol, array_agg(atm_iv ORDER BY atm_iv) as values
      FROM iv_history
      WHERE symbol = ANY(${symbols}) AND time > NOW() - INTERVAL '365 days' AND atm_iv IS NOT NULL
      GROUP BY symbol
    `;
    const statsBySymbol = new Map(stats.map((st) => [st.symbol, st.values.map(Number)]));

    for (const { symbol, atmIv } of inputs) {
      const values = statsBySymbol.get(symbol) ?? [];
      if (values.length < MIN_IV_HISTORY_DAYS) {
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

// --- One-time repair of IV history recorded on the old expiry clock ---
// Until 17 Sep 2026 14:20 IST, time to expiry ran to 05:30 IST on expiry
// morning instead of the 15:30 close, so every stored IV was solved with T
// about 10 hours short and read high (most near expiry). For an ATM option
// IV scales with 1/sqrt(T), so each sample is rescaled by
// sqrt(T_old / T_true) at the moment it was recorded. Samples didn't store
// their expiry, so it's rebuilt from the NSE monthly stock-expiry rule: the
// last Thursday of the month until Aug 2025, the last Tuesday from Sep 2025,
// moved back to the previous trading day when that's a holiday.
const IV_CLOCK_FIX_AT = Date.parse('2026-09-17T14:20:00+05:30');
const IV_HISTORY_REPAIR_KEY = 'iv_history:clock_repaired:v1';
const IV_HISTORY_DEDUPE_KEY = 'iv_history:deduped:v2';
let ivRepair: Promise<void> | null = null;

function repairIvHistoryClockOnce(): Promise<void> {
  if (!ivRepair) {
    ivRepair = repairIvHistoryClock().catch((err: any) => {
      logger.warn({ error: err.message }, 'IV history clock repair failed — will retry on the next scan');
      ivRepair = null;
    });
  }
  return ivRepair;
}

let ivDedupe: Promise<void> | null = null;

function dedupeIvHistoryOnce(): Promise<void> {
  if (!ivDedupe) {
    ivDedupe = dedupeIvHistory().catch((err: any) => {
      logger.warn({ error: err.message }, "IV history dedupe failed — will retry on the next scan");
      ivDedupe = null;
    });
  }
  return ivDedupe;
}

/**
 * IV Rank wants ONE sample per stock per trading day. The "already sampled
 * today" guard compared the database's UTC date against an IST date string,
 * so between midnight and 05:30 IST every scan re-inserted the whole universe
 * — about 23,000 rows a day, 264,202 in total by 17 Sep. That filled the
 * Postgres volume (which took the database down) and, worse, made IV Rank a
 * percentile over intraday noise instead of daily samples.
 *
 * The insert path is fixed (IST dates, and only 30+ minutes into a session).
 * This clears the backlog once: keep the last sample of each IST day per
 * symbol — closest to the close, the most settled read — and drop the rest.
 */
async function dedupeIvHistory(): Promise<void> {
  if (await redis.get(IV_HISTORY_DEDUPE_KEY)) return;

  const before = await sql<{ n: string }[]>`SELECT COUNT(*) AS n FROM iv_history`;
  const deleted = await sql`
    DELETE FROM iv_history a
    USING iv_history b
    WHERE a.symbol = b.symbol
      AND (a.time AT TIME ZONE 'Asia/Kolkata')::date = (b.time AT TIME ZONE 'Asia/Kolkata')::date
      AND a.time < b.time
  `;
  const after = await sql<{ n: string }[]>`SELECT COUNT(*) AS n FROM iv_history`;
  // Plain VACUUM (no FULL): returns the space for reuse without locking the table.
  await sql`VACUUM (ANALYZE) iv_history`.catch((err: any) => logger.warn({ error: err.message }, "IV history vacuum skipped"));

  // The plain VACUUM above frees the space for reuse but leaves the file at
  // its bloated size — 481MB of a 500MB volume, which is what took the
  // database down. With the backlog gone (about 800k rows down to ~7k) a one-off
  // VACUUM FULL rewrites the table and returns the disk. It takes an exclusive
  // lock, but only this scanner touches iv_history and it is now tiny.
  await sql`VACUUM FULL iv_history`.catch((err: any) => logger.warn({ error: err.message }, "IV history VACUUM FULL skipped — space stays reusable but the file will not shrink"));

  await redis.set(IV_HISTORY_DEDUPE_KEY, String(Date.now()));
  logger.info(
    { before: Number(before[0]?.n ?? 0), deleted: deleted.count, after: Number(after[0]?.n ?? 0) },
    "IV history deduped to one sample per stock per trading day"
  );
}

async function repairIvHistoryClock(): Promise<void> {
  if (await redis.get(IV_HISTORY_REPAIR_KEY)) return;

  const buckets = await sql<{ bucket: Date; n: string }[]>`
    SELECT date_trunc('minute', time) AS bucket, COUNT(*) AS n
    FROM iv_history
    WHERE time < ${new Date(IV_CLOCK_FIX_AT)} AND expiry IS NULL
    GROUP BY 1 ORDER BY 1
  `;
  let rows = 0;
  let skipped = 0;
  for (const { bucket } of buckets) {
    const at = new Date(bucket).getTime() + 30_000; // mid-minute
    const expiry = stockExpiryInForce(at);
    const factor = ivClockCorrection(at, expiry);
    const from = new Date(bucket);
    const to = new Date(new Date(bucket).getTime() + 60_000);
    if (factor == null) {
      skipped++;
      await sql`UPDATE iv_history SET expiry = ${expiry} WHERE time >= ${from} AND time < ${to} AND expiry IS NULL`;
      continue;
    }
    const updated = await sql`
      UPDATE iv_history SET
        atm_iv = atm_iv * ${factor},
        ce_iv = ce_iv * ${factor},
        pe_iv = pe_iv * ${factor},
        iv_skew = iv_skew * ${factor},
        expiry = ${expiry}
      WHERE time >= ${from} AND time < ${to} AND expiry IS NULL
    `;
    rows += updated.count;
  }
  await redis.set(IV_HISTORY_REPAIR_KEY, String(Date.now()));
  logger.info({ buckets: buckets.length, rows, skipped }, 'IV history rescaled onto the close-anchored expiry clock');
}
