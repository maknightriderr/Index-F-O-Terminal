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
  pivotPoints,
  detectRsiDivergence,
  detectCandlestickPattern,
  detectPattern,
  getOIDescription,
  buildTradeSetup,
  MAX_RISK_REWARD,
  evaluateSpreadProgress,
  calculateHistoricalVolatility,
  compareIvToHv,
  TRADING_DAYS_PER_YEAR,
  HOURLY_BARS_PER_YEAR,
  calculateExpectedMove,
  detectFairValueGaps,
  testActiveFvg,
  detectVcp,
  analyzeMarketStructure,
  detectLiquiditySweep,
  detectOrderBlocks,
  testActiveOrderBlock,
  classifyPremiumDiscount,
} from '@fno/analytics';
import type {
  Exchange,
  MarketBias,
  IntelligenceScore,
  MarketRegime,
  BiasDirection,
  OptionType,
  OHLCV,
  TradeSetup,
  HistoricalParams,
  TradingMode,
  GammaExposureRegime,
} from '@fno/shared';
import { KNOWN_INDEX_TOKENS, CM_SEGMENT, calculateDTE, INDEX_SYMBOLS, TRADING_HOURS } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken, resolveNearestFuturesContract, buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';
import { getCorporateActionsForSymbol } from './corporate-actions.js';
import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { OptionChain } from '@fno/shared';

// Angel One rate-limits historical-candle and Greeks requests far more
// strictly than quotes (a burst of these returns a flat 403) — cache
// longer than the bias poll interval (60s) so repeat polls for the same
// symbol reuse the last fetch instead of re-hitting the broker.
const HISTORICAL_CACHE_TTL_SECONDS = 90;

// How long a fully-computed bias result stays valid in Redis as a fallback
// when fresh computation fails (rate-limit, broker downtime, etc.). Long
// enough that a transient outage never surfaces the "unreachable" banner,
// short enough that stale data doesn't linger past a trading session.
const BIAS_RESULT_CACHE_TTL_SECONDS = 5 * 60;

// The 6-vote direction read (VWAP/RSI/Supertrend×2/futures OI/PCR) has no
// hysteresis — a single vote crossing its threshold (e.g. spot ticking
// across the VWAP band, or RSI drifting from 46 to 44) can flip the
// composite direction from one 60s poll to the next. Without this, a
// freshly-locked setup could get marked EXPIRED and wiped out within a
// minute of being generated on nothing more than noise, even though the
// underlying read reverts right back next poll. Requiring the reversal to
// hold for this many *consecutive* polls (~3 min at the frontend's 60s
// poll interval) before actually invalidating a sticky setup filters that
// noise out while still reacting to a real, sustained reversal.
//
// POSITIONAL gets a much higher bar — found during a re-audit that this
// constant was being applied uniformly regardless of mode, meaning a
// week-long positional thesis could be invalidated on the same ~3-minute
// debounce tuned for an intraday scalp. Whatever the exact wall-clock time
// that maps to (it depends on how often the underlying 1H/Daily candle
// cache actually refreshes with new data, not just poll count), requiring
// more consecutive confirmations is unambiguously more conservative and
// appropriate for a multi-day/week hold.
const REVERSAL_CONFIRM_POLLS = 3;
const REVERSAL_CONFIRM_POLLS_POSITIONAL = 10;

export interface MarketBiasResult {
  bias: MarketBias;
  score: IntelligenceScore;
  tradeSetup: TradeSetup;
}

type Vote = -1 | 0 | 1;

export async function buildMarketBias(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  mode: TradingMode = 'INTRADAY'
): Promise<MarketBiasResult> {
  // Mode-scoped — INTRADAY and POSITIONAL are different reads (different
  // candle timeframes, thresholds, SL sizing) for the same symbol, not
  // variations of the same one, so they need their own cache slot rather
  // than overwriting each other.
  const cacheKey = `bias_result:${exchange}:${underlying}:${mode}`;

  try {
    return await computeMarketBias(provider, underlying, exchange, cacheKey, mode);
  } catch (err: any) {
    // Fresh computation failed — try to return the last successful result
    // from Redis so the frontend stays on real data instead of falling back
    // to mocks and showing the "signal engine unreachable" banner.
    logger.warn({ error: err.message, underlying, exchange }, 'Market bias fresh compute failed, trying cached fallback');
    try {
      const stale = await redis.get(cacheKey);
      if (stale) {
        const parsed = JSON.parse(stale) as MarketBiasResult;
        logger.info({ underlying, exchange }, 'Returning cached bias result as fallback');
        return parsed;
      }
    } catch (cacheErr: any) {
      logger.warn({ error: cacheErr.message, underlying }, 'Bias result cache fallback read failed');
    }
    // No cached fallback either — propagate the original error
    throw err;
  }
}

async function computeMarketBias(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  resultCacheKey: string,
  mode: TradingMode = 'INTRADAY'
): Promise<MarketBiasResult> {
  const isPositional = mode === 'POSITIONAL';

  const spotToken = await resolveSpotToken(provider, underlying, exchange);
  // MCX's "spot" instrument is a synthetic reference feed (e.g. CRUDEOILCOM)
  // with live quotes but no historical candle series at all — Angel One
  // only carries candle history against actual traded contracts. Use the
  // nearest futures contract for the historical fetch specifically; the
  // "spot" used throughout this file is the last close of those candles
  // anyway (see `spot` below), not a separate live quote, so this is a
  // consistent, coherent substitution rather than a mismatched patch.
  const historicalToken =
    exchange === 'MCX' ? (await resolveNearestFuturesContract(provider, underlying, exchange))?.token ?? spotToken : spotToken;

  const now = new Date();
  const toDate = formatAngelDateTime(now);

  // NOTE on naming below: the variables `candles15m`/`c15`/`rsi15`/`st15`
  // etc. keep their INTRADAY names throughout this function for the "short"
  // timeframe tier even in POSITIONAL mode, where they actually hold 1H
  // candles (and `candles1h`/`c1h`/`st1h` hold Daily) — a full rename
  // wasn't worth the risk of touching every line of a heavily-audited
  // function for a cosmetic-only change. `shortInterval`/`longInterval`
  // below are the actual source of truth for what each tier means.
  const shortInterval = isPositional ? 'ONE_HOUR' : 'FIFTEEN_MINUTE';
  const longInterval = isPositional ? 'ONE_DAY' : 'ONE_HOUR';
  const shortIntervalKey = isPositional ? '1h' : '15m';
  const longIntervalKey = isPositional ? '1d' : '1h';
  // Positional needs much deeper history: enough 1H bars to make Supertrend/
  // RSI/ADX meaningful over weeks (not just days), and enough daily bars
  // (~1.5yr) for a 26/9 MACD and 14-period ADX/ATR to have real warmup.
  const from15m = formatAngelDateTime(new Date(now.getTime() - (isPositional ? 60 : 10) * 24 * 60 * 60 * 1000));
  const from1h = formatAngelDateTime(new Date(now.getTime() - (isPositional ? 540 : 30) * 24 * 60 * 60 * 1000));

  // Angel One's historical-candle endpoint trips a strict rate limit (a
  // flat 403, with getHistoricalData swallowing it and returning [] rather
  // than throwing) under any real concurrent/rapid load — sequence these
  // two with a stagger, and retry with exponential backoff, rather than
  // firing them together via Promise.all. Each is still cached for
  // HISTORICAL_CACHE_TTL_SECONDS on success, so this only costs the extra
  // round-trip latency on a cache miss, not on every poll.
  const nonEmpty = (candles: OHLCV[]) => candles.length > 0;

  const candles15m = await cached(
    `hist:${exchange}:${historicalToken}:${shortIntervalKey}`,
    HISTORICAL_CACHE_TTL_SECONDS,
    () => fetchHistoricalWithRetry(provider, { exchange, token: historicalToken, interval: shortInterval, fromDate: from15m, toDate }),
    nonEmpty
  );
  await sleep(1200);
  const candles1h = await cached(
    `hist:${exchange}:${historicalToken}:${longIntervalKey}`,
    HISTORICAL_CACHE_TTL_SECONDS,
    () => fetchHistoricalWithRetry(provider, { exchange, token: historicalToken, interval: longInterval, fromDate: from1h, toDate }),
    nonEmpty
  );

  const targetExpiry = await resolveTargetExpiry(provider, underlying, exchange, mode);

  const [chain, futures] = await Promise.all([
    buildOptionChain(provider, underlying, exchange, targetExpiry).catch((err) => {
      logger.warn({ error: err.message, underlying }, 'Market bias: option chain unavailable, scoring without it');
      return null;
    }),
    buildFuturesData(provider, underlying, exchange).catch((err) => {
      logger.warn({ error: err.message, underlying }, 'Market bias: futures data unavailable, scoring without it');
      return null;
    }),
  ]);

  if (candles15m.length < 5 || candles1h.length < 5) {
    throw new Error(`Not enough historical candles for ${underlying} to compute market bias (15m: ${candles15m.length}, 1h: ${candles1h.length})`);
  }
  if (candles15m.length < 20 || candles1h.length < 20) {
    logger.warn({ underlying, exchange, count15m: candles15m.length, count1h: candles1h.length },
      'Fewer than ideal candles for market bias — computing with available data');
  }

  const c15 = extractOHLC(candles15m);
  const c1h = extractOHLC(candles1h);

  const spot = c15.closes[c15.closes.length - 1];

  const shortLabel = isPositional ? '1H' : '15m';
  const longLabel = isPositional ? 'Daily' : '1H';

  // Multi-swing chart-structure pattern (Double Top, Head & Shoulders,
  // Triangle, Wedge, Flag, ...) on both tiers — reuses the SAME candles
  // already fetched above for every other indicator here, so this costs
  // zero additional broker calls. Distinct from candlePattern below,
  // which is a single/few-candle shape (Hammer, Doji); this is the
  // broader multi-swing structure a trader actually means by "what is
  // this forming." shortTermPattern is genuinely intraday in INTRADAY
  // mode (15m) but a few-day read in POSITIONAL (1H); longTermPattern is
  // the mode's "long" tier either way (1H / Daily) — switching biasMode
  // in the UI is what moves this between "intraday" and "long timeframe."
  const shortTermPattern = detectPattern(c15.highs, c15.lows, c15.closes, c15.volumes);
  const longTermPattern = detectPattern(c1h.highs, c1h.lows, c1h.closes, c1h.volumes);

  // Volatility Contraction Pattern (Minervini base-building: a sequence
  // of progressively shallower pullbacks, ideally on shrinking volume) —
  // a multi-week/month pattern in its classic form, so run on the "long"
  // tier only (Daily in POSITIONAL, 1H in INTRADAY — same tier
  // longTermPattern uses), never the short tier. Breakout confirmation
  // (below, once VOLUME_CONFIRM_THRESHOLD is in scope) requires
  // above-average long-tier volume on top of clearing the base's high —
  // "still basing" alone is reasoning-only, matching the leading-
  // BREAKOUT-regime philosophy of only counting a signal once it's
  // actually confirmed, not merely forming.
  const vcp = detectVcp(c1h.highs, c1h.lows, c1h.closes, c1h.volumes);
  const longVolSeries = c1h.volumes.slice(-20);
  const longAvgVolume = longVolSeries.length > 0 ? longVolSeries.reduce((a, b) => a + b, 0) / longVolSeries.length : 0;
  const longLastVolume = c1h.volumes[c1h.volumes.length - 1] ?? 0;
  const longVolumeRatio = longAvgVolume > 0 ? longLastVolume / longAvgVolume : 1;

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
  const rsiDivergence = detectRsiDivergence(c15.closes, rsi15Series);
  // Individual-candle reversal shape (Hammer, Engulfing, Morning/Evening
  // Star, ...) on the most recent 15m bars — a lightweight complement to
  // the geometric multi-swing patterns already detected elsewhere. Needs a
  // few bars of trailing context (trend judgment + up to 3-candle
  // patterns), not just the latest bar in isolation.
  const candlePattern = detectCandlestickPattern(candles15m.slice(-15));

  // Fair Value Gap (ICT "imbalance"): a 3-candle pattern where an
  // impulsive move leaves a price zone nothing has traded through — price
  // often retraces into it before continuing, a bullish gap tending to act
  // as support and a bearish gap as resistance. Scanned over closed 15m
  // bars only (`.slice(0, -1)` drops the current/still-forming candle,
  // which `spot` already represents) so "is price live-testing this zone
  // right now" and "did a later candle already fill it" stay two separate
  // questions rather than the current bar answering both at once.
  const fvgs = detectFairValueGaps(c15.highs.slice(0, -1), c15.lows.slice(0, -1));
  const activeFvg = testActiveFvg(fvgs, spot);

  // ICT market structure — all on the same "short" tier as the divergence
  // and FVG checks above: swing-based trend/reversal classification
  // (BOS/CHoCH), a liquidity-sweep check on the current bar, order-block
  // zone tracking, and premium/discount context. See
  // market-structure/index.ts for what each concept means.
  const marketStructure = analyzeMarketStructure(c15.highs, c15.lows);
  const liquiditySweep = detectLiquiditySweep(c15.highs, c15.lows, c15.closes);
  const orderBlocks = detectOrderBlocks(c15.highs, c15.lows, c15.closes);
  const activeOrderBlock = testActiveOrderBlock(orderBlocks, spot);
  const premiumDiscount = classifyPremiumDiscount(c15.highs, c15.lows, spot);

  // Classic pivot points from the prior session's H/L/C — price-based S/R
  // to sit alongside the existing OI-wall S/R, since the two can disagree
  // (an OI wall is where positioning is concentrated; a pivot is where
  // price itself has previously reacted) and a trader benefits from
  // seeing both rather than only one.
  const previousSessionCandles = filterPreviousSession(candles15m);
  const pivots =
    previousSessionCandles.length > 0
      ? pivotPoints(
          Math.max(...previousSessionCandles.map((c) => c.high)),
          Math.min(...previousSessionCandles.map((c) => c.low)),
          previousSessionCandles[previousSessionCandles.length - 1].close
        )
      : null;

  // Positional uses a less sensitive multiplier (2 vs 3) on daily bars —
  // audit-recommended for a slower-turning trend filter appropriate to a
  // multi-day/week hold, vs the more reactive intraday setting.
  const stMultiplier = isPositional ? 2 : 3;
  const st15 = supertrend(c15.highs, c15.lows, c15.closes, 10, stMultiplier);
  const st15Direction = st15.direction[st15.direction.length - 1] ?? 'UP';
  // Did the 15m Supertrend flip on this specific bar, or is it continuing
  // an already-established trend? A flip is a "breakout" moment that
  // deserves volume confirmation before being trusted at full weight; an
  // already-running trend doesn't need continuous re-confirmation.
  const st15PrevDirection = st15.direction[st15.direction.length - 2] ?? st15Direction;
  const st15JustFlipped = st15Direction !== st15PrevDirection;

  // --- 1h signals ---
  const st1h = supertrend(c1h.highs, c1h.lows, c1h.closes, 10, stMultiplier);
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
  // For scoring (not the "today" reasoning text below, which stays exactly
  // that), POSITIONAL needs a multi-bar reference, not today's session
  // change — a week-long hold's relative-strength/volume conviction isn't
  // well judged by a single day's move. Uses the last 10 bars of the
  // "long" tier (Daily candles in POSITIONAL mode).
  const referenceChangePct =
    isPositional && c1h.closes.length > 10
      ? ((spot - c1h.closes[c1h.closes.length - 11]) / c1h.closes[c1h.closes.length - 11]) * 100
      : todayChangePct;

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

  // Historical (realized) volatility from the "long" tier's closes — 1H
  // bars in INTRADAY mode, Daily bars in POSITIONAL — annualized with the
  // bars-per-year matching that actual granularity (using the wrong
  // annualization factor would silently under/over-state HV by roughly
  // sqrt(6.25x), the ratio between daily and hourly bar counts per year).
  // Compared against ATM IV: IV priced rich vs what the underlying
  // actually realizes favors selling premium; cheap favors buying — a
  // second, independent read from IV Rank's "cheap/rich vs its OWN
  // history" question.
  const hvBarsPerYear = isPositional ? TRADING_DAYS_PER_YEAR : HOURLY_BARS_PER_YEAR;
  const hvPct = calculateHistoricalVolatility(c1h.closes, 20, hvBarsPerYear);
  const ivVsHv = atmIvPct > 0 ? compareIvToHv(atmIvPct, hvPct) : { reading: 'FAIR' as const, spreadPct: null };

  // --- Votes (-1 bearish, 0 neutral, +1 bullish) ---
  // Elevated volume relative to the 20-bar average — the bar a "breakout"
  // vote (a fresh Supertrend flip, or price actually outside the Bollinger
  // bands) needs to clear before being trusted at full weight. An
  // already-established trend/band position doesn't need continuous
  // re-confirmation, only the initial break does.
  const VOLUME_CONFIRM_THRESHOLD = 1.2;
  const volumeConfirms = volumeRatio >= VOLUME_CONFIRM_THRESHOLD;
  const vcpBreakoutConfirmed = vcp != null && vcp.breakoutRatio >= 1 && longVolumeRatio >= VOLUME_CONFIRM_THRESHOLD;

  // Positional requires a higher-conviction RSI reading (60/40 vs 55/45) —
  // a multi-day hold shouldn't be triggered by the same mild RSI lean
  // that's meaningful for an intraday scalp.
  const rsiBullThreshold = isPositional ? 60 : 55;
  const rsiBearThreshold = isPositional ? 40 : 45;

  const vwapVote: Vote = spot > sessionVwap * 1.0005 ? 1 : spot < sessionVwap * 0.9995 ? -1 : 0;
  const rsiVote: Vote = rsi15 > rsiBullThreshold ? 1 : rsi15 < rsiBearThreshold ? -1 : 0;
  const st15Vote: Vote = st15JustFlipped && !volumeConfirms ? 0 : st15Direction === 'UP' ? 1 : -1;
  const st1hVote: Vote = st1hDirection === 'UP' ? 1 : -1;
  const futuresOiVote: Vote =
    futuresInterpretation === 'LONG_BUILDUP' || futuresInterpretation === 'SHORT_COVERING'
      ? 1
      : futuresInterpretation === 'SHORT_BUILDUP' || futuresInterpretation === 'LONG_UNWINDING'
      ? -1
      : 0;
  const pcrVote: Vote = pcr > 1.1 ? 1 : pcr < 0.85 ? -1 : 0;
  const macdVote: Vote = macdHistNow > 0 ? 1 : macdHistNow < 0 ? -1 : 0;
  const bbBreakout = bbPercentB > 1 || bbPercentB < 0;
  const bollingerVote: Vote = bbBreakout && !volumeConfirms ? 0 : bbPercentB > 0.6 ? 1 : bbPercentB < 0.4 ? -1 : 0;

  // Leading breakout/breakdown regime: a volume-confirmed break outside the
  // Bollinger Bands on THIS specific bar, not just "currently outside them"
  // — bands walk outward during an established trend, so "outside now"
  // alone would keep firing for hours into what's really already a
  // confirmed STRONG_TREND (ADX just hasn't caught up yet in THAT case).
  // Requiring the PREVIOUS bar to have been inside the band keeps this to
  // the actual moment of the break, which is the entire point of having a
  // leading signal alongside ADX's inherently lagging one.
  const bbUpperPrev = bb15.upper[bb15.upper.length - 2];
  const bbLowerPrev = bb15.lower[bb15.lower.length - 2];
  const prevClose15 = c15.closes[c15.closes.length - 2];
  const bbPercentBPrev =
    bbUpperPrev !== undefined && bbLowerPrev !== undefined && bbUpperPrev > bbLowerPrev && prevClose15 !== undefined
      ? (prevClose15 - bbLowerPrev) / (bbUpperPrev - bbLowerPrev)
      : 0.5;
  const freshBreakoutUp = bbPercentB > 1 && bbPercentBPrev <= 1 && volumeConfirms;
  const freshBreakoutDown = bbPercentB < 0 && bbPercentBPrev >= 0 && volumeConfirms;

  const directionVotes: Vote[] = [vwapVote, rsiVote, st15Vote, st1hVote, futuresOiVote, pcrVote];

  // RSI divergence (price makes a higher high/lower low while RSI weakens)
  // is a genuinely stronger, more reliable reversal signal than a plain
  // RSI-level threshold — it's the classic early warning that a trend is
  // losing momentum before price itself turns. Counted TWICE, not as one
  // more equal-weight vote, so it can actually outweigh 1-2 lagging votes
  // still pointing the old way — exactly the case divergence exists to
  // catch early. Only added to the array when it actually fires: a NONE
  // reading means "no opinion," not "flat disagreement," so it must not
  // dilute confidence on the (far more common) ticks with no divergence —
  // pushing two always-present neutral slots would otherwise lower the
  // confidence denominator on every single symbol/tick regardless of
  // whether divergence is even relevant right now.
  const rsiDivergenceVote: Vote = rsiDivergence.signal === 'BULLISH' ? 1 : rsiDivergence.signal === 'BEARISH' ? -1 : 0;
  if (rsiDivergenceVote !== 0) {
    directionVotes.push(rsiDivergenceVote, rsiDivergenceVote);
  }

  // Fair Value Gap: price actively sitting inside an unfilled imbalance
  // zone is a real support/resistance-test signal (see fvg/index.ts) — a
  // bullish gap tends to hold as support, a bearish gap as resistance.
  // Single weight, not doubled like divergence above: this is a zone
  // test, not a proven-strength reversal signal. Same "only add when
  // active" reasoning as divergence — no active test means "no opinion,"
  // not "flat disagreement," and must not dilute confidence on the far
  // more common ticks where price isn't inside any open gap.
  const fvgVote: Vote = activeFvg == null ? 0 : activeFvg.gap.type === 'BULLISH' ? 1 : -1;
  if (fvgVote !== 0) {
    directionVotes.push(fvgVote);
  }

  // VCP breakout: bullish-only (see vcp/index.ts — no standard bearish
  // mirror), and only counted once actually confirmed (price cleared the
  // base's high on above-average long-tier volume), not merely "still
  // basing." Counted TWICE like RSI divergence — Minervini treats a
  // volume-confirmed VCP breakout as a high-conviction setup, not an
  // ordinary equal-weight read. Only added when confirmed, same dilution
  // reasoning as the other event-based votes above.
  if (vcpBreakoutConfirmed) {
    directionVotes.push(1, 1);
  }

  // Change of Character (CHoCH): the swing structure just broke AGAINST
  // its established trend for the first time — ICT's structural early-
  // reversal warning, the same role RSI divergence plays from a momentum
  // angle. Counted TWICE for the same reason divergence is: a genuine
  // structural break is a stronger signal than an ordinary trend vote.
  // Break of Structure (BOS): the swing structure just extended its
  // established trend — a real but ordinary trend-confirmation read, so
  // single weight, same as any other baseline vote.
  if (marketStructure.lastEvent?.type === 'CHOCH') {
    directionVotes.push(marketStructure.lastEvent.direction === 'BULLISH' ? 1 : -1, marketStructure.lastEvent.direction === 'BULLISH' ? 1 : -1);
  } else if (marketStructure.lastEvent?.type === 'BOS') {
    directionVotes.push(marketStructure.lastEvent.direction === 'BULLISH' ? 1 : -1);
  }

  // Liquidity sweep: a BUY_SIDE sweep ran the stops resting above a
  // prior high and rejected back down — trapped longs, bearish. A
  // SELL_SIDE sweep mirrors it — bullish. Single weight (a trap/zone
  // signal, not a proven-strength reversal read like CHoCH/divergence),
  // only added on an actual sweep this bar.
  if (liquiditySweep) {
    directionVotes.push(liquiditySweep.type === 'SELL_SIDE' ? 1 : -1);
  }

  // Order block test: price is sitting inside an unmitigated order block
  // zone right now — the same "zone under live test" shape as the FVG
  // vote above, single weight for the same reason.
  const orderBlockVote: Vote = activeOrderBlock == null ? 0 : activeOrderBlock.block.type === 'BULLISH' ? 1 : -1;
  if (orderBlockVote !== 0) {
    directionVotes.push(orderBlockVote);
  }

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

  // --- Regime: leading breakout/breakdown (fresh, volume-confirmed Bollinger break) takes priority over the lagging ADX-based trend read, overridden by expiry-day gamma when DTE<=1 ---
  const regime = classifyRegime(adxValue, st1hDirection, atrPctZ, chain?.dte ?? null, chain?.gammaExposure?.regime ?? null, freshBreakoutUp, freshBreakoutDown);

  // --- Reasoning (built from the actual computed values, not templated) ---
  // Ordered by priority, not computation order — the frontend card only
  // shows the first 9 lines, so event-based signals that only fire when
  // something specific happened (divergence, candlestick reversals) go
  // first, ahead of always-present baseline readings (VWAP, RSI level)
  // that would otherwise crowd them out every time. Found in a re-audit:
  // pivots/divergence/candlePattern were pushed last and were getting cut
  // off almost every time there was a full chain + futures + IV read.
  const reasoning: string[] = [];
  if (regime === 'EXPIRY_GAMMA' && chain) {
    reasoning.push(
      `Expiry day (DTE ${chain.dte}) with ${chain.gammaExposure.regime === 'LONG_GAMMA' ? 'positive' : 'negative'} GEX — dealer hedging can pin or whipsaw price independent of the underlying trend; SL widened for expiry-day gamma risk.`
    );
  }
  if (regime === 'BREAKOUT' || regime === 'BREAKDOWN') {
    reasoning.push(
      `Volume-confirmed ${regime === 'BREAKOUT' ? 'break above the upper' : 'break below the lower'} Bollinger Band (${fmt(volumeRatio, 2)}x volume) — a leading signal ADX hasn't caught up to yet.`
    );
  }
  if (rsiDivergence.signal !== 'NONE') {
    reasoning.push(
      `${rsiDivergence.signal === 'BEARISH' ? 'Bearish' : 'Bullish'} RSI divergence (counted double for its reversal reliability) — price ${rsiDivergence.signal === 'BEARISH' ? 'made a higher high' : 'made a lower low'} while RSI weakened (${fmt(rsiDivergence.rsiSwing!.first, 0)} → ${fmt(rsiDivergence.rsiSwing!.second, 0)})`
    );
  }
  if (activeFvg) {
    reasoning.push(
      `Price testing an unfilled ${activeFvg.gap.type === 'BULLISH' ? 'bullish Fair Value Gap (acting as support)' : 'bearish Fair Value Gap (acting as resistance)'} at ${fmt(activeFvg.gap.bottom, 0)}–${fmt(activeFvg.gap.top, 0)} (${Math.round(activeFvg.penetrationPct * 100)}% into the zone)`
    );
  }
  if (marketStructure.lastEvent?.type === 'CHOCH') {
    reasoning.push(
      `Change of Character — market structure just broke ${marketStructure.lastEvent.direction.toLowerCase()} for the first time, an early structural reversal warning`
    );
  }
  if (liquiditySweep) {
    reasoning.push(
      `${liquiditySweep.type === 'BUY_SIDE' ? 'Buy-side' : 'Sell-side'} liquidity sweep at ${fmt(liquiditySweep.sweptLevel, 0)} — price ran the stops resting ${liquiditySweep.type === 'BUY_SIDE' ? 'above the prior high' : 'below the prior low'} then rejected back, a likely trap`
    );
  }
  if (activeOrderBlock) {
    reasoning.push(
      `Price testing an unmitigated ${activeOrderBlock.block.type === 'BULLISH' ? 'bullish' : 'bearish'} order block at ${fmt(activeOrderBlock.block.bottom, 0)}–${fmt(activeOrderBlock.block.top, 0)} (${Math.round(activeOrderBlock.penetrationPct * 100)}% into the zone)`
    );
  }
  if (vcp) {
    const firstDepth = vcp.contractions[0].depthPct * 100;
    const lastDepth = vcp.contractions[vcp.contractions.length - 1].depthPct * 100;
    if (vcpBreakoutConfirmed) {
      reasoning.push(
        `Volume-confirmed breakout (${fmt(longVolumeRatio, 2)}x volume) from a ${vcp.contractions.length}-leg Volatility Contraction Pattern on ${longLabel} — contractions tightened from ${fmt(firstDepth, 1)}% to ${fmt(lastDepth, 1)}%${vcp.volumeDryUp ? ', volume dried up through the base' : ''} — a high-conviction Minervini-style setup.`
      );
    } else {
      reasoning.push(
        `${vcp.contractions.length}-leg Volatility Contraction Pattern still basing on ${longLabel} (${fmt(vcp.breakoutRatio * 100, 1)}% of the way to breaking out, contractions ${fmt(firstDepth, 1)}%→${fmt(lastDepth, 1)}%) — not yet confirmed.`
      );
    }
  }
  if (candlePattern) {
    reasoning.push(
      `${candlePattern.pattern.replace(/_/g, ' ').toLowerCase()} candle (${candlePattern.direction.toLowerCase()}) on the latest 15m bar`
    );
  }
  if (shortTermPattern) {
    reasoning.push(
      `${formatPatternName(shortTermPattern.pattern)} forming on ${shortLabel} — ${shortTermPattern.direction.toLowerCase()} structure (${shortTermPattern.confidence}% confidence)`
    );
  }
  if (longTermPattern) {
    reasoning.push(
      `${formatPatternName(longTermPattern.pattern)} forming on ${longLabel} — ${longTermPattern.direction.toLowerCase()} structure (${longTermPattern.confidence}% confidence)`
    );
  }
  reasoning.push(
    vwapVote === 1
      ? `Price above VWAP (${fmt(spot)} > ${fmt(sessionVwap)})`
      : vwapVote === -1
      ? `Price below VWAP (${fmt(spot)} < ${fmt(sessionVwap)})`
      : `Price near VWAP (${fmt(spot)} ≈ ${fmt(sessionVwap)})`
  );
  // shortLabel/longLabel computed earlier, alongside shortTermPattern/longTermPattern.
  reasoning.push(
    st15Direction === st1hDirection
      ? `Supertrend ${st15Direction === 'UP' ? 'bullish' : 'bearish'} on ${shortLabel} and ${longLabel}`
      : `Supertrend ${st15Direction === 'UP' ? 'bullish' : 'bearish'} on ${shortLabel}, ${st1hDirection === 'UP' ? 'bullish' : 'bearish'} on ${longLabel} — mixed`
  );
  reasoning.push(
    rsi15 >= rsiBullThreshold + 15
      ? `RSI at ${fmt(rsi15, 0)} — overbought`
      : rsi15 <= rsiBearThreshold - 15
      ? `RSI at ${fmt(rsi15, 0)} — oversold`
      : rsi15 > rsiBullThreshold
      ? `RSI at ${fmt(rsi15, 0)} — bullish but not overbought`
      : rsi15 < rsiBearThreshold
      ? `RSI at ${fmt(rsi15, 0)} — bearish but not oversold`
      : `RSI at ${fmt(rsi15, 0)} — neutral`
  );
  if (putWall) reasoning.push(`Put OI concentration at ${fmt(putWall.strike, 0)} (support)`);
  if (callWall) reasoning.push(`Call OI build-up at ${fmt(callWall.strike, 0)} (resistance)`);
  if (pivots) {
    reasoning.push(
      spot > pivots.pp
        ? `Above prior-session pivot (${fmt(spot)} > PP ${fmt(pivots.pp)}) — R1 ${fmt(pivots.r1)}, S1 ${fmt(pivots.s1)}`
        : `Below prior-session pivot (${fmt(spot)} < PP ${fmt(pivots.pp)}) — R1 ${fmt(pivots.r1)}, S1 ${fmt(pivots.s1)}`
    );
  }
  if (chain) {
    reasoning.push(
      `PCR at ${fmt(pcr)} — ${pcr > 1.1 ? 'moderately bullish' : pcr < 0.85 ? 'moderately bearish' : 'neutral'}`
    );
  }
  if (currentFuture) {
    reasoning.push(`${getOIDescription(futuresInterpretation).description} in futures OI`);
  }
  if (chain?.gammaExposure && chain.gammaExposure.regime !== 'NEUTRAL') {
    reasoning.push(
      `Net ${chain.gammaExposure.regime === 'LONG_GAMMA' ? 'positive' : 'negative'} GEX — dealers likely ${chain.gammaExposure.regime === 'LONG_GAMMA' ? 'dampening moves (range-bound bias)' : 'amplifying moves (trend-following bias)'}${chain.gammaExposure.gammaWallStrike != null ? `, largest concentration at ${fmt(chain.gammaExposure.gammaWallStrike, 0)}` : ''}`
    );
  }
  if (chain && atmIvPct > 0) reasoning.push(`ATM IV at ${fmt(atmIvPct)}%`);
  if (ivVsHv.spreadPct != null && ivVsHv.reading !== 'FAIR') {
    reasoning.push(
      `IV ${ivVsHv.reading === 'RICH' ? 'richer' : 'cheaper'} than realized volatility (HV ${fmt(hvPct!, 1)}%, IV ${ivVsHv.spreadPct > 0 ? '+' : ''}${fmt(ivVsHv.spreadPct, 0)}% vs it) — ${ivVsHv.reading === 'RICH' ? 'favors selling' : 'favors buying'} premium`
    );
  }
  if (Math.abs(volumeRatio - 1) > 0.3) {
    reasoning.push(`Volume ${volumeRatio > 1 ? 'above' : 'below'} its 20-bar average (${fmt(volumeRatio, 2)}x)`);
  }
  if (st15JustFlipped && !volumeConfirms) {
    reasoning.push(`Supertrend 15m just flipped ${st15Direction === 'UP' ? 'bullish' : 'bearish'} but volume (${fmt(volumeRatio, 2)}x) hasn't confirmed it — vote withheld`);
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
      // OI-wall S/R (where positioning is concentrated) and price-pivot
      // S/R (where price itself has previously reacted) are two distinct
      // signals that can disagree — both surfaced rather than only one.
      support: putWall?.strike ?? null,
      resistance: callWall?.strike ?? null,
      pivotSupport: pivots?.s1 ?? null,
      pivotResistance: pivots?.r1 ?? null,
      pivotPP: pivots?.pp ?? null,
      rsiDivergence: rsiDivergence.signal,
      candlePattern: candlePattern?.pattern ?? null,
      historicalVolatility: hvPct,
      ivVsHv: ivVsHv.reading,
      ivVsHvSpreadPct: ivVsHv.spreadPct,
      netGex: chain?.gammaExposure.netGex ?? null,
      gammaRegime: chain?.gammaExposure.regime ?? null,
      gammaWallStrike: chain?.gammaExposure.gammaWallStrike ?? null,
      dte: chain?.dte ?? null,
      chartStructureShort: shortTermPattern
        ? { pattern: shortTermPattern.pattern, direction: shortTermPattern.direction, confidence: shortTermPattern.confidence, interval: shortLabel }
        : null,
      chartStructureLong: longTermPattern
        ? { pattern: longTermPattern.pattern, direction: longTermPattern.direction, confidence: longTermPattern.confidence, interval: longLabel }
        : null,
      activeFvg: activeFvg
        ? { type: activeFvg.gap.type, top: activeFvg.gap.top, bottom: activeFvg.gap.bottom, penetrationPct: Math.round(activeFvg.penetrationPct * 100) }
        : null,
      vcp: vcp
        ? { legs: vcp.contractions.length, breakoutRatioPct: Math.round(vcp.breakoutRatio * 100), volumeDryUp: vcp.volumeDryUp, confirmed: vcpBreakoutConfirmed }
        : null,
      marketStructureBias: marketStructure.bias,
      lastStructureEvent: marketStructure.lastEvent,
      liquiditySweep,
      activeOrderBlock: activeOrderBlock
        ? { type: activeOrderBlock.block.type, top: activeOrderBlock.block.top, bottom: activeOrderBlock.block.bottom, penetrationPct: Math.round(activeOrderBlock.penetrationPct * 100) }
        : null,
      premiumDiscount: premiumDiscount.zone,
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

  // Direction-aware, matching oiShiftsScore/relativeStrengthScore below:
  // elevated volume only means conviction if it's backing a move that
  // agrees with `direction` — heavy volume on a move AGAINST the overall
  // read is a warning sign, not confirmation, and previously scored just
  // as high as genuine confirming volume since this only looked at
  // magnitude. Below-average volume (ratio <= 1) carries no signal either
  // way and scores neutral.
  const volumeMoveVote = referenceChangePct !== 0 ? Math.sign(referenceChangePct) * clamp(volumeRatio - 1, 0, 1) : 0;
  const volumeScore = contribution(volumeMoveVote, directionSign);

  // How big is the futures OI shift, scaled by whether that shift's own
  // buildup/unwinding type agrees with the overall direction (futuresOiVote,
  // already computed above) — a large shift that CONTRADICTS the direction
  // should score low, not high. (Previously this only looked at magnitude,
  // so it could only ever read >=50 regardless of which way the OI moved —
  // an unconditional upward push on `overall` for any symbol with active
  // futures OI, agreeing or not.)
  const oiShiftMagnitude = Math.min(Math.abs(futuresChangeOiPct), 50) / 50; // 0..1
  const oiShiftsScore = contribution(futuresOiVote * oiShiftMagnitude, directionSign);

  // Move relative to its own ATR (volatility-normalized momentum), scored
  // the same agree-high/disagree-low way as every other dimension —
  // previously this rewarded any positive move and penalized any negative
  // one regardless of `direction`, so a bounce inside an overall bearish
  // read scored as if it confirmed a bullish one. Uses referenceChangePct
  // (today's move for INTRADAY, a 10-bar move for POSITIONAL) rather than
  // always today's session change, for the same reason as volumeMoveVote
  // above.
  const relativeStrengthVote = atrPctNow > 0 ? clamp(referenceChangePct / atrPctNow, -1, 1) : 0;
  const relativeStrengthScore = contribution(relativeStrengthVote, directionSign);

  // Trend conviction (ADX), direction-agnostic by design — a strong trend
  // is a strong trend whichever way it points. Reported for context (and
  // because trendScore already folds ADX in as its own strength multiplier)
  // but deliberately NOT part of `overall`: weighting it in as-is would
  // reward any strongly-trending symbol regardless of agreement with
  // `direction`, and making it direction-aware would just re-derive
  // trendScore's own Supertrend+ADX signal a second time.
  const regimeScore = Math.round(adxNorm * 100);

  // Volume bumped 5% -> 8% (now direction-aware, see volumeScore above, so
  // the extra weight is trustworthy rather than amplifying the old
  // magnitude-only noise) — trend and price-action trimmed slightly to
  // fund it, still the two largest weights by a wide margin.
  const overall = Math.round(
    trendScore * 0.16 +
      priceActionScore * 0.12 +
      futuresOiScore * 0.13 +
      optionsOiScore * 0.13 +
      pcrScore * 0.09 +
      ivScore * 0.09 +
      technicalsScore * 0.09 +
      oiShiftsScore * 0.07 +
      volumeScore * 0.08 +
      relativeStrengthScore * 0.04
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
    ? await resolveStickyTradeSetup(provider, underlying, exchange, chain, direction, confidence, regime, overall, mode)
    : { available: false, reason: 'Option chain unavailable for this symbol — cannot size a setup.' };

  const result: MarketBiasResult = { bias, score, tradeSetup };

  // Persist the successful result as a fallback for future failures
  try {
    await redis.set(resultCacheKey, JSON.stringify(result), 'EX', BIAS_RESULT_CACHE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Failed to cache bias result for fallback');
  }

  return result;
}

// Fraction of today's remaining trading session, clamped to a small floor
// so a setup minted in the closing minutes doesn't get an effectively-zero
// (or negative, once the clock is past close) target. MCX's session runs
// past midnight-adjacent hours (09:00-23:30) — same open/close-minutes math
// as NSE/BSE, just a much longer window, so no special-casing needed.
const MIN_REMAINING_SESSION_FRACTION = 0.05;

function remainingSessionFraction(exchange: Exchange): number {
  const hours = TRADING_HOURS[exchange];
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: hours.timezone }));
  const [openH, openM] = hours.open.split(':').map(Number);
  const [closeH, closeM] = hours.close.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const nowMinutes = ist.getHours() * 60 + ist.getMinutes();
  const totalSessionMinutes = closeMinutes - openMinutes;
  const remainingMinutes = closeMinutes - nowMinutes;
  return Math.max(MIN_REMAINING_SESSION_FRACTION, Math.min(1, remainingMinutes / totalSessionMinutes));
}

// A POSITIONAL naked long needs runway: 15-30 DTE gives the thesis time to
// play out before theta/vega bleed the premium regardless of direction —
// Trade Setup only ever builds a naked long (the user is an option buyer,
// not a spread trader — see trade-setup/index.ts's file header), so this
// is the only band that matters here now; a credit spread's opposite
// preference (short-dated, 7-14 DTE, since the short leg's accelerating
// theta into expiry IS the edge) doesn't apply to anything this function
// picks an expiry for any more. INTRADAY always keeps the nearest
// (highest-gamma, tightest-spread) weekly regardless — a same-session hold
// never reaches this tradeoff at all. Returns undefined (nearest/default)
// when no expiry falls close enough to be worth deviating from the weekly,
// or when expiry data can't be fetched — resolveStickyTradeSetup's caller
// already treats undefined as "use the default chain."
const POSITIONAL_NAKED_LONG_DTE_RANGE: [number, number] = [15, 30];

async function resolveTargetExpiry(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  mode: TradingMode
): Promise<string | undefined> {
  if (mode !== 'POSITIONAL') return undefined;
  try {
    const expiries = await provider.getExpiries(underlying, exchange);
    if (expiries.length === 0) return undefined;

    const [minDte, maxDte] = POSITIONAL_NAKED_LONG_DTE_RANGE;
    const targetDte = (minDte + maxDte) / 2;
    const withDte = expiries.map((expiry) => ({ expiry, dte: calculateDTE(expiry) })).filter((x) => x.dte >= 0);
    if (withDte.length === 0) return undefined;

    // Prefer an expiry actually inside the target band; if none exists
    // (e.g. only weekly + far-monthly are listed), fall back to whichever
    // available expiry is closest to the band's midpoint rather than
    // refusing to deviate from the nearest weekly at all.
    const inRange = withDte.filter((x) => x.dte >= minDte && x.dte <= maxDte);
    const pool = inRange.length > 0 ? inRange : withDte;
    return pool.reduce((best, cur) => (Math.abs(cur.dte - targetDte) < Math.abs(best.dte - targetDte) ? cur : best)).expiry;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Positional expiry selection failed — falling back to nearest/default expiry');
    return undefined;
  }
}

// VIX-adjusted SL sizing needs India VIX's current level — one quote,
// cached briefly (VIX doesn't need sub-minute freshness for this purpose,
// and this avoids an extra broker round-trip on every single poll). Only
// meaningful for NSE; MCX/BSE symbols keep the base SL unadjusted.
const VIX_CACHE_TTL_SECONDS = 60;

async function lookupIndiaVix(provider: MarketDataProvider, exchange: Exchange): Promise<number | null> {
  if (exchange !== 'NSE') return null;
  const token = KNOWN_INDEX_TOKENS.INDIAVIX;
  if (!token) return null;
  try {
    return await cached(`quote:india-vix`, VIX_CACHE_TTL_SECONDS, async () => {
      const [quote] = await provider.getQuote(CM_SEGMENT.NSE, [token], 'FULL');
      return quote && quote.ltp > 0 ? quote.ltp : null;
    });
  } catch (err: any) {
    logger.warn({ error: err.message }, 'India VIX lookup failed for trade setup SL sizing — proceeding unadjusted');
    return null;
  }
}

// --- Reliability filters ---
// Three cross-checks against data this app already computes elsewhere,
// run right before a fresh setup would be generated — a setup that passes
// its own confidence/liquidity/R:R bar can still be individually
// unreliable if it's fighting the broader market, landing on a corporate-
// action ex-date, or contradicting an independently-computed institutional
// read. None of these add a new signal source; they just stop generating
// in isolation from signals the app already has.

// getPredictionHistory in institutional-flow-scanner.ts isn't imported
// here — that file imports buildMarketBias from this one, so importing it
// back would create a circular module dependency. Reading the same
// `signals` rows directly (same pattern backtesting.ts and the scanner
// itself already use — several services query this shared table
// independently rather than going through each other) avoids that.
async function lookupInstitutionalDirection(symbol: string): Promise<BiasDirection | null> {
  try {
    const rows = await sql<{ direction: BiasDirection }[]>`
      SELECT direction FROM signals
      WHERE symbol = ${symbol} AND signal_type = 'NEXT_DAY_BIAS'
      ORDER BY time DESC
      LIMIT 1
    `;
    return rows[0]?.direction ?? null;
  } catch (err: any) {
    logger.warn({ error: err.message, symbol }, 'Institutional-flow direction lookup failed');
    return null;
  }
}

async function lookupCachedBiasDirection(exchange: Exchange, symbol: string, mode: TradingMode): Promise<BiasDirection | null> {
  try {
    const raw = await redis.get(`bias_result:${exchange}:${symbol}:${mode}`);
    if (!raw) return null;
    return (JSON.parse(raw) as MarketBiasResult).bias.direction;
  } catch (err: any) {
    logger.warn({ error: err.message, symbol }, 'Cached bias direction lookup failed');
    return null;
  }
}

/** Non-null return is the reason a fresh setup should NOT be generated right now. */
async function checkReliabilityFilters(
  underlying: string,
  exchange: Exchange,
  direction: BiasDirection,
  mode: TradingMode
): Promise<string | null> {
  const isNseStock = exchange === 'NSE' && !(INDEX_SYMBOLS as readonly string[]).includes(underlying);

  // Corporate-action ex-date today or tomorrow — the price move around it
  // is the action itself (dividend/bonus/split adjustment), not a
  // technical signal, and reads as a false breakout/breakdown either way.
  if (isNseStock) {
    try {
      const actions = await getCorporateActionsForSymbol(underlying);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const upcoming = actions.find((a) => a.exDate === today || a.exDate === tomorrow);
      if (upcoming) {
        return `${upcoming.type} ex-date ${upcoming.exDate === today ? 'today' : 'tomorrow'} (${upcoming.purpose}) — the price move around this is the corporate action, not a technical signal.`;
      }
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Corporate-action reliability check failed — proceeding ungated');
    }
  }

  if (direction === 'NEUTRAL') return null; // nothing left to disagree with

  // Broader-market alignment — only meaningful for an individual stock
  // against the index; an index can't fight itself, and MCX/BSE commodities
  // have no real equity-index relationship to check against.
  if (isNseStock) {
    const niftyDirection = await lookupCachedBiasDirection('NSE', 'NIFTY', mode);
    if (niftyDirection != null && niftyDirection !== 'NEUTRAL' && niftyDirection !== direction) {
      return `NIFTY itself is currently ${niftyDirection} — a ${direction} setup on ${underlying} would be fighting the broader market.`;
    }
  }

  // Institutional Flow's next-day read for the relevant broad index —
  // BANKNIFTY's own prediction when the setup IS BANKNIFTY, NIFTY's
  // otherwise. Institutional Flow only covers these two symbols, and only
  // NIFTY/BANKNIFTY themselves plus NSE stocks have a real relationship to
  // either — MCX/BSE are skipped, same reasoning as the alignment check.
  if (exchange === 'NSE') {
    const relevantIndex = underlying === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY';
    const predicted = await lookupInstitutionalDirection(relevantIndex);
    if (predicted != null && predicted !== 'NEUTRAL' && predicted !== direction) {
      return `Institutional Flow's next-day read for ${relevantIndex} is ${predicted}, disagreeing with this ${direction} setup.`;
    }
  }

  return null;
}

// --- Sticky Trade Setup ---
// Recomputing the setup fresh on every poll made entry/SL/target track the
// live option premium tick-by-tick — useless as a "setup" since a real
// trade has fixed levels you watch price move against, not a number that
// drifts with the market before you've even acted on it. This locks a
// setup in once generated and only replaces it when it's actually been
// invalidated: SL or target hit, the read reversed direction, or it's a
// new trading day (a setup from a prior session is stale regardless of
// whether its levels were touched).

interface StoredTradeSetup extends TradeSetup {
  direction: BiasDirection;
  day: string; // YYYY-MM-DD, IST
  signalId?: string; // links to the persisted `signals` row for backtesting (see backtesting.ts)
  reversalStreak?: number; // consecutive polls the bias has read opposite to `direction` — see REVERSAL_CONFIRM_POLLS
  initialStopLoss?: number; // the SL at generation time, fixed — `stopLoss` itself trails upward as price moves favorably, this is what "1x/2x initial risk" is measured against
}

// A fixed 30%-of-entry SL gives back a lot of a real trending move waiting
// for it to get hit. Once price has moved 1x the initial risk in favor,
// trail the stop to breakeven; once it's moved 2x, trail to lock in 1x
// risk worth of profit. Only ever ratchets toward the current price —
// never loosens back down.
const TRAIL_TO_BREAKEVEN_AT_R = 1;
const TRAIL_LOCK_PROFIT_AT_R = 2;

const STICKY_TRADE_SETUP_TTL_SECONDS = 60 * 60 * 24 * 2;
const STICKY_TRADE_SETUP_TTL_SECONDS_POSITIONAL = 60 * 60 * 24 * 30; // a positional hold is meant to run days/weeks, not roll over after 2 days

// 40% for a positional hold vs the 30% intraday default — the same option's
// premium ordinarily swings further over a multi-day/week horizon on
// theta/vega alone, so a same-session-tuned stop would get shaken out by
// routine noise long before the thesis played out.
const POSITIONAL_SL_PREMIUM_PCT = 0.4;

async function resolveStickyTradeSetup(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  chain: OptionChain,
  direction: BiasDirection,
  confidence: number,
  regime: MarketRegime,
  intelligenceScore: number,
  mode: TradingMode = 'INTRADAY'
): Promise<TradeSetup> {
  const isPositional = mode === 'POSITIONAL';
  const setupTtl = isPositional ? STICKY_TRADE_SETUP_TTL_SECONDS_POSITIONAL : STICKY_TRADE_SETUP_TTL_SECONDS;
  // Mode-scoped key — INTRADAY and POSITIONAL setups for the same symbol
  // are entirely different positions (different SL%, different expected
  // holding period), not variations of one setup, so they can't share a
  // Redis slot.
  const key = `trade_setup:${exchange}:${underlying}:${mode}`;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  let stored: StoredTradeSetup | null = null;
  try {
    const raw = await redis.get(key);
    if (raw) stored = JSON.parse(raw) as StoredTradeSetup;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Sticky trade setup read failed — generating fresh');
  }

  // Only an actual locked-in setup (available: true) is sticky — an
  // "unavailable" verdict (neutral bias, low confidence) isn't a position
  // to protect from re-evaluation, so it re-checks current conditions
  // every poll like any other live read rather than getting stuck once
  // confidence happens to dip for one cycle.
  // A setup generated before a data-quality fix (e.g. a diverging or
  // oscillating IV solver inflating the target) can otherwise stay locked
  // in all day — its target is unreachable so hitSL/hitTarget below never
  // fires — silently serving a broken number for the rest of the session.
  // Re-applying the same R:R plausibility bar buildTradeSetup itself
  // enforces on every read closes that gap without needing a manual cache
  // clear — this is what lets a fix land and immediately self-heal any
  // setup already sitting in Redis, not just new ones generated after.
  // The R:R cap only makes sense for a naked long, whose target comes from
  // a delta×expected-move projection that can run away on bad upstream
  // data — a spread's max profit/loss are geometrically bounded by real
  // strike widths and real current premiums, so it's sanity-checked by
  // requiring positive maxProfit/maxLoss instead.
  const storedIsPlausible =
    stored?.available &&
    (stored.structureType === 'SPREAD'
      ? stored.maxProfit != null && stored.maxProfit > 0 && stored.maxLoss != null && stored.maxLoss > 0
      : stored.riskReward != null && stored.riskReward <= MAX_RISK_REWARD);

  // Self-heal a setup that's alive and trade-able in the terminal but
  // missing its Backtesting row — recordTradeSetupGenerated below can
  // fail transiently (a DB blip) while the Redis write that actually
  // makes the setup live in the UI succeeds regardless, since the two
  // are independent writes with no shared transaction. Found this after
  // a user reported Backtesting wasn't showing every OPEN position
  // visible in the terminal — recordTradeSetupOutcome already no-ops
  // when signalId is missing (see its own comment), so without this
  // there was never a second chance to record a setup that failed once.
  // Retried every poll until it succeeds; a rare double-failure window
  // (the DB insert succeeds but the very next Redis write fails) can
  // leave one harmless duplicate row, which is a far better failure mode
  // than the guaranteed-permanent gap this replaces.
  if (storedIsPlausible && stored && !stored.signalId) {
    const backfilledId = await recordTradeSetupGenerated(underlying, exchange, stored, stored.direction, confidence, regime, intelligenceScore, mode);
    if (backfilledId) {
      stored = { ...stored, signalId: backfilledId };
      try {
        await redis.set(key, JSON.stringify(stored), 'EX', setupTtl);
      } catch (err: any) {
        logger.warn({ error: err.message, underlying }, 'Sticky trade setup signalId backfill write failed');
      }
    }
  }

  // A positional hold is meant to run days/weeks — unlike intraday, a
  // calendar-day change alone shouldn't invalidate it, only SL/target
  // being hit or a confirmed reversal should. Intraday keeps requiring
  // same-day, matching its "roll over every session" design.
  if (storedIsPlausible && (isPositional || stored!.day === today)) {
    const isSpread = stored!.structureType === 'SPREAD';
    let currentValue: number | null = null;
    let hitSL: boolean;
    let hitTarget: boolean;

    if (isSpread && stored!.legs) {
      // A spread's SL/target are fixed fractions of max profit/max loss —
      // no trailing-stop this pass (the naked long's premium-based trail
      // doesn't translate directly to a multi-leg position's P&L; a
      // reasonable further refinement, not built here).
      const legPrices = stored!.legs.map((l) => ({ action: l.action, price: legLtpOrNull(chain, l.strike, l.side) }));
      const progress = evaluateSpreadProgress(legPrices, stored!.netPremium!, stored!.maxProfit!, stored!.maxLoss!);
      currentValue = progress.currentValue;
      hitSL = progress.hitStop;
      hitTarget = progress.hitTarget;
    } else {
      // SL/target are about the option's own price, not the current bias
      // read — check them first and unconditionally, so a real win/loss is
      // never masked by a same-tick direction flicker.
      const currentLtp = legLtpOrNull(chain, stored!.strike!, stored!.side!);
      currentValue = currentLtp;

      // Trailing stop — naked long only. Ratchet stopLoss up as price
      // moves favorably, measured against the ORIGINAL risk (entry -
      // initialStopLoss), which stays fixed even as stopLoss itself
      // trails. Setups persisted before this field existed have no
      // initialStopLoss and simply don't trail — no backfill needed,
      // they behave exactly as they did before.
      if (currentLtp != null && stored!.initialStopLoss != null && stored!.entry != null) {
        const initialRisk = stored!.entry - stored!.initialStopLoss;
        if (initialRisk > 0) {
          const profit = currentLtp - stored!.entry;
          const trailTarget =
            profit >= TRAIL_LOCK_PROFIT_AT_R * initialRisk
              ? stored!.entry + initialRisk
              : profit >= TRAIL_TO_BREAKEVEN_AT_R * initialRisk
              ? stored!.entry
              : null;
          if (trailTarget != null && trailTarget > stored!.stopLoss!) {
            const newStopLoss = round2(trailTarget);
            const trailNote =
              newStopLoss >= stored!.entry + initialRisk
                ? `SL trailed to ${newStopLoss.toFixed(2)} — 1x initial risk locked in.`
                : `SL trailed to breakeven (${newStopLoss.toFixed(2)}).`;
            stored = { ...stored!, stopLoss: newStopLoss, reason: `${stored!.reason} ${trailNote}` };
            try {
              await redis.set(key, JSON.stringify(stored), 'EX', setupTtl);
            } catch (err: any) {
              logger.warn({ error: err.message, underlying }, 'Sticky trade setup trailing-stop write failed');
            }
          }
        }
      }

      hitSL = currentLtp != null && currentLtp <= stored!.stopLoss!;
      hitTarget = currentLtp != null && currentLtp >= stored!.target!;
    }

    if (hitSL || hitTarget) {
      const outcome = classifyPriceHitOutcome(stored!, isSpread, hitTarget);
      await recordTradeSetupOutcome(stored!, outcome, currentValue);
      // falls through to fresh generation below
    } else if (stored!.direction === direction) {
      // Bias still agrees with the locked setup — fully sticky. Clear any
      // reversal streak that had started building from an earlier blip,
      // since the reversal didn't hold.
      if (!stored!.reversalStreak) return withLiveMark(stored!, currentValue, isSpread);
      const reset: StoredTradeSetup = { ...stored!, reversalStreak: 0 };
      try {
        await redis.set(key, JSON.stringify(reset), 'EX', setupTtl);
      } catch (err: any) {
        logger.warn({ error: err.message, underlying }, 'Sticky trade setup reversal-streak reset failed');
      }
      return withLiveMark(reset, currentValue, isSpread);
    } else {
      // Bias has flipped this poll — don't tear down the setup on a single
      // noisy reading. Require the reversal to hold for REVERSAL_CONFIRM_POLLS
      // (mode-scaled — POSITIONAL needs a much higher bar) consecutive polls
      // before treating it as real.
      const confirmPolls = isPositional ? REVERSAL_CONFIRM_POLLS_POSITIONAL : REVERSAL_CONFIRM_POLLS;
      const streak = (stored!.reversalStreak ?? 0) + 1;
      if (streak < confirmPolls) {
        const bumped: StoredTradeSetup = { ...stored!, reversalStreak: streak };
        try {
          await redis.set(key, JSON.stringify(bumped), 'EX', setupTtl);
        } catch (err: any) {
          logger.warn({ error: err.message, underlying }, 'Sticky trade setup reversal-streak write failed');
        }
        return withLiveMark(bumped, currentValue, isSpread);
      }
      // Reversal confirmed across enough polls — inconclusive, not a loss.
      // Still worth a mark-to-market exit price where we can get one, so
      // it's not just a blank row in the backtest.
      await recordTradeSetupOutcome(stored!, 'EXPIRED', currentValue);
    }
  } else if (storedIsPlausible && stored?.signalId) {
    // Day rolled over — a setup from a prior session is unconditionally
    // stale regardless of direction, no debounce needed.
    await recordTradeSetupOutcome(stored!, 'EXPIRED', currentExitValue(chain, stored!));
  } else if (!storedIsPlausible && stored?.available && stored?.signalId) {
    // A previously-implausible setup (e.g. a diverging IV solver's target,
    // or a bad-quote spread) is about to be silently replaced below — found
    // in a backtesting-data review that this left the OLD database row
    // permanently stuck at outcome: null ("OPEN" forever), since neither
    // branch above ever ran for it. Close it out as EXPIRED first so the
    // self-heal doesn't leave a zombie row behind.
    await recordTradeSetupOutcome(stored!, 'EXPIRED', currentExitValue(chain, stored!));
  }

  const unreliableReason = await checkReliabilityFilters(underlying, exchange, direction, mode);
  if (unreliableReason != null) {
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Sticky trade setup clear failed');
    }
    return { available: false, reason: unreliableReason };
  }

  const vix = await lookupIndiaVix(provider, exchange);
  const slPremiumPct = isPositional ? POSITIONAL_SL_PREMIUM_PCT : undefined;

  // chain.expectedMove.points is IV × sqrt(chain.dte / 365) — correct for
  // "where might price land by THIS OPTION'S expiry" (what the Option Chain
  // page shows), but an INTRADAY naked long's sticky setup rolls over at
  // day-end regardless of whether it resolved (see the day !== today check
  // above) — it realistically has at most the rest of today to hit target
  // before being forced EXPIRED. Feeding it a target scaled to the full
  // ~20-30 day chain DTE asks it to cover a multi-week move within a single
  // session — for CRUDEOIL's ~20-day monthly that's roughly a 4-5x larger
  // move than sqrt(1/365) implies, which is *why* targets were essentially
  // never reached (0 WINs across 40 recorded setups). POSITIONAL genuinely
  // is meant to run toward the chain's full remaining life, so it keeps
  // using chain.expectedMove.points as-is.
  //
  // Even the 1-day figure overstates what's reachable for a setup minted
  // mid-session — a backtest review found EVERY INTRADAY naked long still
  // sized off a flat full-day move regardless of when it was generated, so
  // a 2pm setup was asked to cover the SAME move as one generated at the
  // 9:15 open with the full 6h15m session ahead of it. Expected move scales
  // with sqrt(time), so scale the 1-day figure down by sqrt(remaining
  // session fraction) — a setup with half the session left gets ~71% of
  // the full-day move as its target, not 100% of it. buildTradeSetup only
  // ever builds a naked long now (the user is an option buyer, not a
  // spread trader — see trade-setup/index.ts's file header), so this
  // applies to every INTRADAY setup, not a fallback case.
  const targetExpectedMovePoints = isPositional
    ? chain.expectedMove.points
    : (() => {
        const atmIvPct = computeAtmIv(chain);
        if (atmIvPct <= 0) return chain.expectedMove.points;
        const oneDayMove = calculateExpectedMove(chain.spotPrice, atmIvPct / 100, 1, underlying).expectedMove;
        return oneDayMove * Math.sqrt(remainingSessionFraction(exchange));
      })();

  const fresh = buildTradeSetup(chain.strikes, chain.atmStrike, direction, confidence, targetExpectedMovePoints, slPremiumPct, vix, chain.dte);

  if (!fresh.available) {
    // Clear any previously locked setup now that conditions no longer
    // support one — otherwise a stale setup from earlier today could
    // resurface with an outdated entry price if direction swings back.
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Sticky trade setup clear failed');
    }
    return fresh;
  }

  const signalId = await recordTradeSetupGenerated(underlying, exchange, fresh, direction, confidence, regime, intelligenceScore, mode);

  const toStore: StoredTradeSetup = { ...fresh, direction, day: today, generatedAt: Date.now(), signalId, initialStopLoss: fresh.stopLoss };
  try {
    await redis.set(key, JSON.stringify(toStore), 'EX', setupTtl);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Sticky trade setup write failed');
  }

  return toStore;
}

// --- Backtesting: persist every generated setup, record its outcome ---
// Reuses the `signals` table (already in the schema, otherwise unused —
// see database/init/002_schema.sql and institutional-flow-scanner.ts,
// which reuses it too) rather than a new migration: signal_type
// 'TRADE_SETUP', the option-specific fields live in `inputs` JSONB, and
// the outcome gets merged into that same JSONB once resolved.

async function recordTradeSetupGenerated(
  underlying: string,
  exchange: Exchange,
  // Caller has already checked fresh.available === true, but TradeSetup is
  // a flat interface (not a discriminated union), so that check narrows
  // fresh.available itself, not the type of `fresh` as a whole — side/
  // strike/etc. stay optional at the type level even though they're always
  // populated together with `available: true` at runtime.
  fresh: TradeSetup,
  direction: BiasDirection,
  confidence: number,
  regime: MarketRegime,
  intelligenceScore: number,
  mode: TradingMode
): Promise<string | undefined> {
  try {
    // mode is persisted here (found missing in a re-audit) so backtesting
    // can distinguish INTRADAY from POSITIONAL setups — without it, once
    // positional trades start generating, their fundamentally different
    // SL%/target/hold-time profile would get silently mixed into the same
    // win-rate stats as intraday trades, diluting both.
    const rows = await sql<{ id: string }[]>`
      INSERT INTO signals (time, symbol, signal_type, direction, confidence, inputs, reasoning, market_regime, intelligence_score)
      VALUES (
        NOW(), ${underlying}, 'TRADE_SETUP', ${direction}, ${confidence},
        ${sql.json(
          // sql.json()'s JSONValue type doesn't structurally accept a
          // nested typed array like SpreadLeg[] (readonly index-signature
          // friction in its type definition, not a real data issue — this
          // is plain JSON-serializable data) — cast at the boundary rather
          // than fighting the ORM's type for every field.
          {
            exchange,
            mode,
            structureType: fresh.structureType ?? 'NAKED_LONG',
            side: fresh.side,
            strike: fresh.strike,
            entry: fresh.entry,
            stopLoss: fresh.stopLoss,
            target: fresh.target,
            riskReward: fresh.riskReward,
            strategy: fresh.strategy,
            legs: fresh.legs,
            netPremium: fresh.netPremium,
            maxProfit: fresh.maxProfit,
            maxLoss: fresh.maxLoss,
            breakeven: fresh.breakeven,
            breakevenLower: fresh.breakevenLower,
            breakevenUpper: fresh.breakevenUpper,
          } as any
        )},
        ${fresh.reason}, ${regime}, ${intelligenceScore}
      )
      RETURNING id
    `;
    return rows[0]?.id;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Backtesting: failed to record generated trade setup');
    return undefined;
  }
}

async function recordTradeSetupOutcome(
  stored: StoredTradeSetup,
  outcome: 'WIN' | 'LOSS' | 'EXPIRED',
  exitValue: number | null
): Promise<void> {
  if (!stored.signalId) return; // pre-dates this feature or failed to record on generation — nothing to update
  try {
    // A naked long's return% is the % change in the option's own premium.
    // A spread has no single "entry price" to measure against that way —
    // maxLoss (the capital genuinely at risk) is the meaningful reference,
    // so a spread's return% is P&L as a % of that risk instead.
    let returnPercent: number | null = null;
    if (exitValue != null) {
      if (stored.structureType === 'SPREAD' && stored.maxLoss != null && stored.maxLoss > 0 && stored.netPremium != null) {
        const pnl = exitValue - stored.netPremium;
        returnPercent = Math.round((pnl / stored.maxLoss) * 10000) / 100;
      } else if (stored.entry != null && stored.entry > 0) {
        returnPercent = Math.round(((exitValue - stored.entry) / stored.entry) * 10000) / 100;
      }
    }
    await sql`
      UPDATE signals
      SET inputs = inputs || ${sql.json({ outcome, exitPrice: exitValue, exitTime: Date.now() })}, fwd_1d_return = ${returnPercent}
      WHERE id = ${stored.signalId}
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, signalId: stored.signalId }, 'Backtesting: failed to record trade setup outcome');
  }
}

function findLeg(chain: OptionChain, strike: number, side: 'CE' | 'PE') {
  const entry = chain.strikes.find((s) => s.strike === strike);
  return side === 'CE' ? entry?.call : entry?.put;
}

// A found leg with ltp<=0 is NOT a real price of zero — it's the broker
// reporting no live trade for that strike (illiquid, or an off-hours poll
// with no fresh tick), the exact same condition buildNakedLong itself
// already refuses to build a setup from (`leg.ltp <= 0`). Without this
// guard, `?? null` only substitutes for null/undefined — 0 sails straight
// through as a "real" price, and since 0 is <= any positive stopLoss, a
// single bad/stale tick falsely registers a stop-loss hit and records the
// exit at 0, producing an exact -100.00% "loss" that never actually
// happened. Found via a backtesting review: every recorded LOSS was
// showing precisely -100.00% regardless of the position's actual SL
// distance — the fingerprint of this bug, not real trading outcomes.
function legLtpOrNull(chain: OptionChain, strike: number, side: 'CE' | 'PE'): number | null {
  const ltp = findLeg(chain, strike, side)?.ltp;
  return ltp != null && ltp > 0 ? ltp : null;
}

/** Mark-to-market value of a stored setup right now — a single leg's LTP for a naked long, or the net cost-to-close for a spread. Null if any required leg's quote is currently unavailable. */
function currentExitValue(chain: OptionChain, stored: StoredTradeSetup): number | null {
  if (stored.structureType === 'SPREAD' && stored.legs) {
    const prices = stored.legs.map((l) => legLtpOrNull(chain, l.strike, l.side));
    if (prices.some((p) => p == null)) return null;
    return round2(stored.legs.reduce((sum, l, i) => sum + (l.action === 'BUY' ? prices[i]! : -prices[i]!), 0));
  }
  if (stored.strike == null || !stored.side) return null;
  return legLtpOrNull(chain, stored.strike, stored.side);
}

// Attaches the freshly-computed live mark to a still-open sticky setup
// before returning it — never persisted to Redis (each of this function's
// three sticky-path callers already wrote the plain, mark-free object),
// so this only affects the value handed back to whoever asked for it this
// poll. Without this, the API response only ever showed the entry price
// locked at generation time with no live comparison anywhere in the UI —
// exactly what read as "wrong strike prices" when a user compared a
// setup's entry against what they saw live elsewhere hours later.
function withLiveMark(setup: StoredTradeSetup, currentValue: number | null, isSpread: boolean): TradeSetup {
  const basis = isSpread ? setup.netPremium : setup.entry;
  const unrealizedPnl = currentValue != null && basis != null ? round2(currentValue - basis) : null;
  return { ...setup, currentValue, unrealizedPnl };
}

// A stop trailed up to or past entry that then gets hit locked in a real
// (or breakeven) result, not a loss — only an SL still below entry (never
// trailed, or a shallow trail that didn't reach it) is a genuine loss.
// Spreads have no trailing, so a stop hit is always a real loss and a
// target hit is always a real win. Shared by resolveStickyTradeSetup's own
// SL/target branch and the lightweight price-level monitor below, so the
// two can't silently drift apart.
function classifyPriceHitOutcome(stored: StoredTradeSetup, isSpread: boolean, hitTarget: boolean): 'WIN' | 'LOSS' | 'EXPIRED' {
  return hitTarget
    ? 'WIN'
    : isSpread
    ? 'LOSS'
    : stored.stopLoss! > stored.entry!
    ? 'WIN'
    : stored.stopLoss! === stored.entry!
    ? 'EXPIRED'
    : 'LOSS';
}

/**
 * Lightweight, standalone SL/target check for one locked INTRADAY setup —
 * fetches only the option chain (quotes, cached ~10s) rather than the full
 * buildMarketBias, which pulls 15m+1h historical candles and is subject to
 * Angel One's much stricter historical-endpoint rate limit (see alerts.ts's
 * "Trade Setup closed" check, which avoids buildMarketBias for the same
 * reason). Only checks the hard price-level SL/target hit, not the softer
 * bias-reversal EXPIRED path — that genuinely needs the full bias
 * computation and stays on-demand (a user's browser poll, or the
 * NIFTY/BANKNIFTY institutional scanner's 15-minute cadence), same as
 * before this existed.
 *
 * Exists specifically because that on-demand-only model has a real gap: a
 * fast intraday SL/target touch that happens between checks — or for any
 * symbol nobody's actively viewing at all — was going completely
 * undetected. Scoped to INTRADAY only: POSITIONAL setups can be pinned to
 * a non-nearest expiry (see resolveTargetExpiry), which this always-
 * nearest-expiry fetch can't reliably match, so those stay on the existing
 * on-demand path.
 *
 * Two independent triggers (a live on-demand call and this monitor) can in
 * principle race on the same locked setup and both record an outcome —
 * a narrow, pre-existing risk (multiple browser tabs on the same symbol
 * already have it) rather than one this introduces; not worth full
 * distributed locking for what would be a duplicate backtesting row, not a
 * functional or safety issue.
 */
export async function checkLockedSetupPriceLevels(provider: MarketDataProvider, exchange: Exchange, underlying: string): Promise<void> {
  const key = `trade_setup:${exchange}:${underlying}:INTRADAY`;

  let stored: StoredTradeSetup | null = null;
  try {
    const raw = await redis.get(key);
    if (raw) stored = JSON.parse(raw) as StoredTradeSetup;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Price-level monitor: sticky setup read failed');
    return;
  }

  if (!stored?.available) return;

  let chain: OptionChain;
  try {
    chain = await buildOptionChain(provider, underlying, exchange);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Price-level monitor: option chain fetch failed — will retry next tick');
    return;
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (stored.day !== today) {
    // A prior-day INTRADAY setup used to just get silently skipped here —
    // day-rollover EXPIRY only ever happened in resolveStickyTradeSetup's
    // ON-DEMAND path, which never runs for a symbol nobody revisits the
    // next day. That setup's Redis key eventually vanished on its own TTL
    // (2 days) with no outcome ever recorded, leaving its Backtesting row
    // permanently stuck showing "open" — found via a live DB/Redis
    // comparison: 32 DB rows had no outcome, but only 9 were still backed
    // by a real Redis key; the other 23 were exactly this. Same close-out
    // resolveStickyTradeSetup itself uses for a same-poll day rollover.
    await recordTradeSetupOutcome(stored, 'EXPIRED', currentExitValue(chain, stored));
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Price-level monitor: stale-day sticky setup clear failed');
    }
    logger.info({ underlying, exchange }, 'Price-level monitor: closed a prior-day setup nobody had revisited');
    return;
  }

  const isSpread = stored.structureType === 'SPREAD';
  let currentValue: number | null;
  let hitSL: boolean;
  let hitTarget: boolean;

  if (isSpread && stored.legs && stored.netPremium != null && stored.maxProfit != null && stored.maxLoss != null) {
    const legPrices = stored.legs.map((l) => ({ action: l.action, price: legLtpOrNull(chain, l.strike, l.side) }));
    const progress = evaluateSpreadProgress(legPrices, stored.netPremium, stored.maxProfit, stored.maxLoss);
    currentValue = progress.currentValue;
    hitSL = progress.hitStop;
    hitTarget = progress.hitTarget;
  } else if (!isSpread && stored.strike != null && stored.side && stored.stopLoss != null && stored.target != null) {
    const currentLtp = legLtpOrNull(chain, stored.strike, stored.side);
    currentValue = currentLtp;
    hitSL = currentLtp != null && currentLtp <= stored.stopLoss;
    hitTarget = currentLtp != null && currentLtp >= stored.target;
  } else {
    return;
  }

  if (!hitSL && !hitTarget) return;

  const outcome = classifyPriceHitOutcome(stored, isSpread, hitTarget);
  await recordTradeSetupOutcome(stored, outcome, currentValue);
  // recordTradeSetupOutcome only updates the DB row — resolveStickyTradeSetup's
  // on-demand path normally clears/overwrites this Redis key itself right
  // after (it falls through to generating a fresh setup). This monitor
  // doesn't generate a replacement, so it must clear the key directly, or
  // the next on-demand view would still see available:true and show a
  // setup that's already resolved in the DB as if it were still open —
  // exactly the bug this monitor exists to prevent, just relocated.
  try {
    await redis.del(key);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Price-level monitor: sticky setup clear failed after recording outcome');
  }
  logger.info({ underlying, exchange, outcome }, 'Price-level monitor: closed a locked setup that hit SL/target between on-demand checks');
}

// --- Helpers ---

/**
 * getHistoricalData already swallows its own errors and resolves to []
 * rather than throwing (so a 403 looks the same as "no data"). One retry
 * after a beat is enough to ride out an intermittent rate-limit hit
 * without turning this into an unbounded retry loop against the broker.
 */
async function fetchHistoricalWithRetry(
  provider: MarketDataProvider,
  params: HistoricalParams,
  attempts = 3,
  initialDelayMs = 1500
): Promise<OHLCV[]> {
  for (let i = 0; i < attempts; i++) {
    const candles = await provider.getHistoricalData(params);
    if (candles.length > 0) return candles;
    if (i < attempts - 1) {
      // Exponential backoff: 1.5s → 3s → 6s … to ride out rate-limit windows
      const backoff = initialDelayMs * Math.pow(2, i);
      logger.debug({ attempt: i + 1, nextRetryMs: backoff, token: params.token }, 'Historical fetch empty, retrying');
      await sleep(backoff);
    }
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Candles from the most recent trading day strictly before today (IST) — the session pivot points are computed from. */
function filterPreviousSession(candles: OHLCV[]): OHLCV[] {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const byDate = new Map<string, OHLCV[]>();
  for (const c of candles) {
    const d = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (d === todayIST) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(c);
  }
  const dates = [...byDate.keys()].sort();
  const lastDate = dates[dates.length - 1];
  return lastDate ? byDate.get(lastDate)! : [];
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

// DTE<=1 with non-neutral GEX overrides the ADX/Supertrend trend read —
// dealer hedging flows into an imminent expiry can pin or whipsaw price in
// ways that have nothing to do with the underlying trend (a "strong" ADX
// reading into expiry is often just the pin/unwind, not a real trend), so
// this is checked first, ahead of the ADX bands below.
const EXPIRY_GAMMA_MAX_DTE = 1;

function classifyRegime(
  adxValue: number,
  st1hDirection: 'UP' | 'DOWN',
  atrZ: number,
  dte: number | null,
  gexRegime: GammaExposureRegime | null,
  freshBreakoutUp: boolean,
  freshBreakoutDown: boolean
): MarketRegime {
  if (dte != null && dte <= EXPIRY_GAMMA_MAX_DTE && gexRegime != null && gexRegime !== 'NEUTRAL') {
    return 'EXPIRY_GAMMA';
  }
  // A volume-confirmed break outside the Bollinger Bands on this bar is a
  // leading signal — it can fire well before ADX (a 14-period smoothed
  // average) has accumulated enough bars to call the same move a "strong
  // trend." Checked ahead of the ADX bands below for exactly that reason:
  // by the time ADX confirms, the leading part of the move is already over.
  if (freshBreakoutUp) return 'BREAKOUT';
  if (freshBreakoutDown) return 'BREAKDOWN';
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
 *
 * Coefficient is 45 (not e.g. 30) so a fully-agreeing or fully-flat
 * input actually reaches the clamp's own [5,95] bounds — |vote| never
 * exceeds 1 (it's a raw vote or an average of same-signed ±1 votes), so
 * 50 ± 1*45 = 5/95 exactly. A smaller coefficient silently compresses
 * every score into a narrower band than the scale promises (caught by
 * comparing against lightweightBias's analogous 50 + sum*15 over 3
 * votes, which does hit its own ±45 bound at full agreement).
 */
function contribution(vote: number, directionSign: number): number {
  if (directionSign === 0) return clamp(Math.round(50 - Math.abs(vote) * 45), 5, 95);
  return clamp(Math.round(50 + vote * directionSign * 45), 5, 95);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** 'HEAD_AND_SHOULDERS' -> 'Head And Shoulders' */
function formatPatternName(pattern: string): string {
  return pattern
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
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
