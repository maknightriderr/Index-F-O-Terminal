// ============================================================
// MARKET BIAS / REGIME / INTELLIGENCE SCORE ENGINE
// ============================================================
// A rule-based composite over live technicals (RSI/VWAP/Supertrend/
// ADX/MACD/Bollinger from @fno/analytics), live futures OI buildup,
// and live option chain PCR/OI concentration. Every number here is
// derived from real data — there is no ML model or external signal
// source, so treat it as a transparent heuristic scanner, not a
// prediction. All the underlying values are exposed in `reasoning`
// and `inputs` so the composite is auditable, not a black box.
// ============================================================

import {
  rsi,
  vwap,
  supertrend,
  adx,
  atr,
  macd,
  bollingerBands,
  getOIDescription,
  buildTradeSetup,
} from '@fno/analytics';
import type {
  Exchange,
  MarketBias,
  IntelligenceScore,
  MarketRegime,
  BiasDirection,
  OHLCV,
  TradeSetup,
} from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken, buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

// Angel One rate-limits historical-candle and Greeks requests far more
// strictly than quotes (a burst of these returns a flat 403) — cache
// longer than the bias poll interval (60s) so repeat polls for the same
// symbol reuse the last fetch instead of re-hitting the broker.
const HISTORICAL_CACHE_TTL_SECONDS = 90;

export interface MarketBiasResult {
  bias: MarketBias;
  score: IntelligenceScore;
  tradeSetup: TradeSetup;
}

type Vote = -1 | 0 | 1;

export async function buildMarketBias(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<MarketBiasResult> {
  const spotToken = await resolveSpotToken(provider, underlying, exchange);

  const now = new Date();
  const toDate = formatAngelDateTime(now);
  const from15m = formatAngelDateTime(new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));
  const from1h = formatAngelDateTime(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  // Angel One's historical-candle endpoint trips a strict per-second limit
  // (a flat 403) when hit with two concurrent requests — sequence these two
  // rather than firing them together via Promise.all. Each is still cached
  // for HISTORICAL_CACHE_TTL_SECONDS, so this only costs the extra
  // round-trip latency on a cache miss, not on every poll.
  const nonEmpty = (candles: OHLCV[]) => candles.length > 0;

  const candles15m = await cached(
    `hist:${exchange}:${spotToken}:15m`,
    HISTORICAL_CACHE_TTL_SECONDS,
    () => provider.getHistoricalData({ exchange, token: spotToken, interval: 'FIFTEEN_MINUTE', fromDate: from15m, toDate }),
    nonEmpty
  );
  const candles1h = await cached(
    `hist:${exchange}:${spotToken}:1h`,
    HISTORICAL_CACHE_TTL_SECONDS,
    () => provider.getHistoricalData({ exchange, token: spotToken, interval: 'ONE_HOUR', fromDate: from1h, toDate }),
    nonEmpty
  );

  const [chain, futures] = await Promise.all([
    buildOptionChain(provider, underlying, exchange).catch((err) => {
      logger.warn({ error: err.message, underlying }, 'Market bias: option chain unavailable, scoring without it');
      return null;
    }),
    buildFuturesData(provider, underlying, exchange).catch((err) => {
      logger.warn({ error: err.message, underlying }, 'Market bias: futures data unavailable, scoring without it');
      return null;
    }),
  ]);

  if (candles15m.length < 20 || candles1h.length < 20) {
    throw new Error(`Not enough historical candles for ${underlying} to compute market bias`);
  }

  const c15 = extractOHLC(candles15m);
  const c1h = extractOHLC(candles1h);

  const spot = c15.closes[c15.closes.length - 1];

  // --- 15m signals ---
  const todaysCandles = filterToday(candles15m);
  const sessionVwapSeries = todaysCandles.length >= 2
    ? vwap(
        todaysCandles.map((c) => c.high),
        todaysCandles.map((c) => c.low),
        todaysCandles.map((c) => c.close),
        todaysCandles.map((c) => c.volume)
      )
    : vwap(c15.highs, c15.lows, c15.closes, c15.volumes);
  const sessionVwap = sessionVwapSeries[sessionVwapSeries.length - 1] ?? spot;

  const rsi15Series = rsi(c15.closes, 14);
  const rsi15 = rsi15Series[rsi15Series.length - 1] ?? 50;

  const st15 = supertrend(c15.highs, c15.lows, c15.closes, 10, 3);
  const st15Direction = st15.direction[st15.direction.length - 1] ?? 'UP';

  // --- 1h signals ---
  const st1h = supertrend(c1h.highs, c1h.lows, c1h.closes, 10, 3);
  const st1hDirection = st1h.direction[st1h.direction.length - 1] ?? 'UP';

  const adx1h = adx(c1h.highs, c1h.lows, c1h.closes, 14);
  const adxValue = adx1h.adx[adx1h.adx.length - 1] ?? 15;

  const atr1h = atr(c1h.highs, c1h.lows, c1h.closes, 14);
  const atrPct = atr1h.map((v, i) => (v / c1h.closes[c1h.closes.length - atr1h.length + i]) * 100);
  const atrPctNow = atrPct[atrPct.length - 1] ?? 0;
  const atrPctZ = zScore(atrPctNow, atrPct);

  const macdResult = macd(c1h.closes);
  const macdHistNow = macdResult.histogram[macdResult.histogram.length - 1] ?? 0;

  const bb15 = bollingerBands(c15.closes, 20, 2);
  const bbUpperNow = bb15.upper[bb15.upper.length - 1];
  const bbLowerNow = bb15.lower[bb15.lower.length - 1];
  const bbPercentB =
    bbUpperNow !== undefined && bbLowerNow !== undefined && bbUpperNow > bbLowerNow
      ? (spot - bbLowerNow) / (bbUpperNow - bbLowerNow)
      : 0.5;

  const volSeries15 = c15.volumes.slice(-20);
  const avgVolume15 = volSeries15.length > 0 ? volSeries15.reduce((a, b) => a + b, 0) / volSeries15.length : 0;
  const lastVolume15 = c15.volumes[c15.volumes.length - 1] ?? 0;
  const volumeRatio = avgVolume15 > 0 ? lastVolume15 / avgVolume15 : 1;

  const todayOpen = todaysCandles[0]?.open ?? c15.closes[0];
  const todayChangePct = todayOpen > 0 ? ((spot - todayOpen) / todayOpen) * 100 : 0;

  // --- Futures OI ---
  const currentFuture = futures?.contracts.find((c) => c.expiryLabel === 'current') ?? null;
  const futuresInterpretation = currentFuture?.interpretation ?? 'NEUTRAL';
  const futuresChangeOiPct =
    currentFuture && currentFuture.oi > 0 ? (currentFuture.changeOi / currentFuture.oi) * 100 : 0;

  // --- Option chain PCR / OI walls ---
  const pcr = chain?.pcrDetail.oiPCR ?? 1;
  const atmIvPct = chain ? computeAtmIv(chain) : 0;
  const putWall = chain ? findMaxOiStrike(chain, 'put') : null;
  const callWall = chain ? findMaxOiStrike(chain, 'call') : null;

  // --- Votes (-1 bearish, 0 neutral, +1 bullish) ---
  const vwapVote: Vote = spot > sessionVwap * 1.0005 ? 1 : spot < sessionVwap * 0.9995 ? -1 : 0;
  const rsiVote: Vote = rsi15 > 55 ? 1 : rsi15 < 45 ? -1 : 0;
  const st15Vote: Vote = st15Direction === 'UP' ? 1 : -1;
  const st1hVote: Vote = st1hDirection === 'UP' ? 1 : -1;
  const futuresOiVote: Vote =
    futuresInterpretation === 'LONG_BUILDUP' || futuresInterpretation === 'SHORT_COVERING'
      ? 1
      : futuresInterpretation === 'SHORT_BUILDUP' || futuresInterpretation === 'LONG_UNWINDING'
      ? -1
      : 0;
  const pcrVote: Vote = pcr > 1.1 ? 1 : pcr < 0.85 ? -1 : 0;
  const macdVote: Vote = macdHistNow > 0 ? 1 : macdHistNow < 0 ? -1 : 0;
  const bollingerVote: Vote = bbPercentB > 0.6 ? 1 : bbPercentB < 0.4 ? -1 : 0;

  const directionVotes: Vote[] = [vwapVote, rsiVote, st15Vote, st1hVote, futuresOiVote, pcrVote];
  const voteSum = directionVotes.reduce((a: number, b) => a + b, 0);
  const votesFor = directionVotes.filter((v) => v === 1).length;
  const votesAgainst = directionVotes.filter((v) => v === -1).length;
  const votesFlat = directionVotes.length - votesFor - votesAgainst;

  const direction: BiasDirection = voteSum > 0 ? 'BULLISH' : voteSum < 0 ? 'BEARISH' : 'NEUTRAL';
  const directionSign = direction === 'BULLISH' ? 1 : direction === 'BEARISH' ? -1 : 0;

  const total = directionVotes.length;
  const bullishProbability = Math.round((votesFor / total) * 100);
  const bearishProbability = Math.round((votesAgainst / total) * 100);
  const neutralProbability = 100 - bullishProbability - bearishProbability;

  const agreementCount = direction === 'BULLISH' ? votesFor : direction === 'BEARISH' ? votesAgainst : votesFlat;
  const confidence = clamp(Math.round((agreementCount / total) * 100), 15, 95);

  // --- Regime: trend strength (ADX) + direction (Supertrend 1H) + volatility (ATR z-score) ---
  const regime = classifyRegime(adxValue, st1hDirection, atrPctZ);

  // --- Reasoning (built from the actual computed values, not templated) ---
  const reasoning: string[] = [];
  reasoning.push(
    vwapVote === 1
      ? `Price above VWAP (${fmt(spot)} > ${fmt(sessionVwap)})`
      : vwapVote === -1
      ? `Price below VWAP (${fmt(spot)} < ${fmt(sessionVwap)})`
      : `Price near VWAP (${fmt(spot)} ≈ ${fmt(sessionVwap)})`
  );
  reasoning.push(
    st15Direction === st1hDirection
      ? `Supertrend ${st15Direction === 'UP' ? 'bullish' : 'bearish'} on 15m and 1H`
      : `Supertrend ${st15Direction === 'UP' ? 'bullish' : 'bearish'} on 15m, ${st1hDirection === 'UP' ? 'bullish' : 'bearish'} on 1H — mixed`
  );
  reasoning.push(
    rsi15 >= 70
      ? `RSI at ${fmt(rsi15, 0)} — overbought`
      : rsi15 <= 30
      ? `RSI at ${fmt(rsi15, 0)} — oversold`
      : rsi15 > 55
      ? `RSI at ${fmt(rsi15, 0)} — bullish but not overbought`
      : rsi15 < 45
      ? `RSI at ${fmt(rsi15, 0)} — bearish but not oversold`
      : `RSI at ${fmt(rsi15, 0)} — neutral`
  );
  if (putWall) reasoning.push(`Put OI concentration at ${fmt(putWall.strike, 0)} (support)`);
  if (callWall) reasoning.push(`Call OI build-up at ${fmt(callWall.strike, 0)} (resistance)`);
  if (chain) {
    reasoning.push(
      `PCR at ${fmt(pcr)} — ${pcr > 1.1 ? 'moderately bullish' : pcr < 0.85 ? 'moderately bearish' : 'neutral'}`
    );
  }
  if (currentFuture) {
    reasoning.push(`${getOIDescription(futuresInterpretation).description} in futures OI`);
  }
  if (chain && atmIvPct > 0) reasoning.push(`ATM IV at ${fmt(atmIvPct)}%`);
  if (Math.abs(volumeRatio - 1) > 0.3) {
    reasoning.push(`Volume ${volumeRatio > 1 ? 'above' : 'below'} its 20-bar average (${fmt(volumeRatio, 2)}x)`);
  }

  const bias: MarketBias = {
    symbol: underlying,
    direction,
    bullishProbability,
    bearishProbability,
    neutralProbability,
    confidence,
    regime,
    reasoning,
    inputs: {
      spotPrice: spot,
      vwap: sessionVwap,
      rsi: rsi15,
      supertrend15m: st15Direction,
      supertrend1h: st1hDirection,
      adx: adxValue,
      pcr,
      atmIv: atmIvPct,
      futuresOi: futuresInterpretation,
      maxPain: chain?.maxPain ?? null,
      expectedMove: chain?.expectedMove.points ?? null,
      expectedRangeLow: chain?.expectedMove.lowerBound ?? null,
      expectedRangeHigh: chain?.expectedMove.upperBound ?? null,
      support: putWall?.strike ?? null,
      resistance: callWall?.strike ?? null,
    },
    timestamp: Date.now(),
  };

  // --- Intelligence Score: each dimension scored on how strongly it
  // confirms the overall direction (or, for a NEUTRAL read, how flat it
  // is) — not raw bullishness. See `contribution()` below. ---
  const trendVote = (st15Vote + st1hVote) / 2;
  const adxNorm = clamp(adxValue / 40, 0, 1);
  const trendScore = clamp(Math.round(contribution(trendVote, directionSign) * (0.5 + adxNorm * 0.5)), 0, 100);

  const priceActionVote = (vwapVote + rsiVote) / 2;
  const priceActionScore = contribution(priceActionVote, directionSign);

  const futuresOiScore = contribution(futuresOiVote, directionSign);
  const optionsOiScore = contribution(pcrVote, directionSign);
  const pcrScore = clamp(Math.round(50 + (pcr - 1) * 40), 0, 100);
  // atmIvPct is 0 both when IV is genuinely unresolvable (no chain, no legs
  // with a broker/calculated IV) and — vanishingly rarely — when it's truly
  // near-zero; treat it as "unknown" and score neutral rather than a
  // misleadingly perfect 100.
  const ivScore = atmIvPct > 0 ? clamp(Math.round(100 - atmIvPct * 2.5), 0, 100) : 50;

  const technicalsVote = (rsiVote + macdVote + bollingerVote) / 3;
  const technicalsScore = contribution(technicalsVote, directionSign);

  const volumeScore = clamp(Math.round(50 + (volumeRatio - 1) * 50), 0, 100);
  const oiShiftsScore = clamp(Math.round(50 + Math.min(Math.abs(futuresChangeOiPct), 50)), 0, 100);
  const relativeStrengthScore = clamp(
    Math.round(50 + (atrPctNow > 0 ? (todayChangePct / atrPctNow) * 25 : 0)),
    0,
    100
  );
  const regimeScore = Math.round(adxNorm * 100);

  const overall = Math.round(
    trendScore * 0.2 +
      priceActionScore * 0.15 +
      futuresOiScore * 0.15 +
      optionsOiScore * 0.15 +
      pcrScore * 0.1 +
      ivScore * 0.1 +
      technicalsScore * 0.1 +
      volumeScore * 0.05
  );

  const score: IntelligenceScore = {
    symbol: underlying,
    score: overall,
    trend: trendScore,
    priceAction: priceActionScore,
    futuresOi: futuresOiScore,
    optionsOi: optionsOiScore,
    pcr: pcrScore,
    iv: ivScore,
    oiShifts: oiShiftsScore,
    volume: volumeScore,
    relativeStrength: relativeStrengthScore,
    technicals: technicalsScore,
    regime: regimeScore,
    reasoning,
    timestamp: Date.now(),
  };

  const tradeSetup: TradeSetup = chain
    ? buildTradeSetup(chain.strikes, chain.atmStrike, direction, confidence, chain.expectedMove.points)
    : { available: false, reason: 'Option chain unavailable for this symbol — cannot size a setup.' };

  return { bias, score, tradeSetup };
}

// --- Helpers ---

function extractOHLC(candles: OHLCV[]) {
  return {
    highs: candles.map((c) => c.high),
    lows: candles.map((c) => c.low),
    closes: candles.map((c) => c.close),
    volumes: candles.map((c) => c.volume),
  };
}

function filterToday(candles: OHLCV[]): OHLCV[] {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const todays = candles.filter(
    (c) => new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === todayIST
  );
  return todays.length >= 2 ? todays : candles.slice(-20);
}

/** Angel One historical API expects "YYYY-MM-DD HH:mm" in IST. */
function formatAngelDateTime(date: Date): string {
  const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`;
}

function zScore(value: number, series: number[]): number {
  if (series.length < 5) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((sum, v) => sum + (v - mean) ** 2, 0) / series.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (value - mean) / std : 0;
}

function classifyRegime(adxValue: number, st1hDirection: 'UP' | 'DOWN', atrZ: number): MarketRegime {
  if (adxValue >= 25) return st1hDirection === 'UP' ? 'STRONG_BULL_TREND' : 'STRONG_BEAR_TREND';
  if (adxValue >= 18) return st1hDirection === 'UP' ? 'WEAK_BULL_TREND' : 'WEAK_BEAR_TREND';
  if (atrZ > 1) return 'HIGH_VOLATILITY';
  if (atrZ < -1) return 'LOW_VOLATILITY';
  return 'RANGE_BOUND';
}

/**
 * Score how strongly a signal (-1..1) confirms the overall direction
 * (directionSign -1/0/1). Agreement scores high, disagreement scores
 * low, and for a NEUTRAL overall read, a flat signal scores high while
 * a strong signal either way scores low (it's noise the composite
 * cancelled out).
 */
function contribution(vote: number, directionSign: number): number {
  if (directionSign === 0) return clamp(Math.round(50 - Math.abs(vote) * 20), 5, 95);
  return clamp(Math.round(50 + vote * directionSign * 30), 5, 95);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function computeAtmIv(chain: NonNullable<Awaited<ReturnType<typeof buildOptionChain>>>): number {
  const atmEntry = chain.strikes.find((s) => s.strike === chain.atmStrike) ?? chain.strikes[Math.floor(chain.strikes.length / 2)];
  const samples = [atmEntry?.call?.iv, atmEntry?.put?.iv].filter((v): v is number => !!v && v > 0);
  return samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
}

function findMaxOiStrike(
  chain: NonNullable<Awaited<ReturnType<typeof buildOptionChain>>>,
  side: 'call' | 'put'
): { strike: number; oi: number } | null {
  let best: { strike: number; oi: number } | null = null;
  for (const s of chain.strikes) {
    const leg = side === 'call' ? s.call : s.put;
    if (!leg) continue;
    if (!best || leg.oi > best.oi) best = { strike: s.strike, oi: leg.oi };
  }
  return best;
}
