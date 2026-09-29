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
  MIN_RISK_REWARD,
  MIN_CONFIDENCE,
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
  detectEmaTrendStructure,
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
  OIInterpretation,
  OptionChainLeg,
} from '@fno/shared';
import {
  KNOWN_INDEX_TOKENS,
  CM_SEGMENT,
  calculateDTE,
  INDEX_SYMBOLS,
  TRADING_HOURS,
  SETUP_OPENING_SETTLE_MINUTES,
  getExchangeHoliday,
  getSessionCloseTime,
  minutesSinceSessionOpen,
  getSessionWindow,
} from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken, resolveNearestFuturesContract, buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';
import { getCorporateActionsForSymbol } from './corporate-actions.js';
import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decisionNow, decisionDate, decisionIstDate, assertNoFutureData } from './decision-clock.js';
import { ivRankFor } from './fno-scanner.js';
import { randomUUID } from 'node:crypto';
import type { DecisionSnapshotInput } from './decision-snapshot.js';
import { recordDecisionSnapshot, recordGateDiagnostics, markDecisionStale, markDecisionDead, recordEventualOutcome, recordInvalidationReason } from './decision-snapshot.js';
// Phase 1 instrumentation. Every one of these observes and records; none of
// them is read by a gate, and none can change what a setup does.
import { evaluateGateDiagnostics, oiWallFreshnessDiagnostic, minutesSinceLastLossFromTtls, type GateDiagnostic, type LosingCloseState } from './gate-diagnostics.js';
import { classifyOpeningEnvironment } from './opening-classifier.js';
import { assessStaleness, inputTimestampsFrom, staleSignalDiagnostic, type StalenessAssessment } from './signal-freshness.js';
import { classifyStrategyLabels, type StrategyLabelResult } from './strategy-label.js';
import { voteContributionsFrom, type VoteContributions } from './confidence-dimensions.js';
import { exitReasonFromCloseReason } from './exit-reason.js';
// Phase 2. The three analytics models are SHADOW ONLY: computed from the same
// chain after the live setup is built and recorded beside it; none of their
// outputs is passed back into buildTradeSetup or any gate. Exposure and the
// invalidation label are live but purely observational.
import { scoreStrikeCandidates, assessExecutionQuality, estimateTargetV2 } from '@fno/analytics';
import type { ShadowStrikeSelection, ExecutionQualityResult, TargetEstimateResult } from '@fno/analytics';
import { readExposureAtCreation, toExposureSetup } from './exposure-tracker.js';
import { invalidationReasonFromCloseReason } from './invalidation-reason.js';
import { recordStopEvent } from './stop-event.js';
import { classifySetup, sessionBucket, type SetupClassification } from '@fno/analytics';
import { captureUnderlyingObservation } from './market-state-capture.js';
import { dataQualityBlock } from './data-quality.js';
import { notifyTradeSetup } from './telegram.js';
import { trackSymbolForOiSnapshot } from './oi-close-snapshot.js';
import { riskOffReason } from './risk-circuit-breaker.js';
import { assessLocation, assessRoom, type StructuralLevel } from './location-quality.js';
import { TRADING_FLAGS, TRADING_PARAMS, COVERAGE_LAG_FLAGS, COVERAGE_LAG_PARAMS, liveLogicStamp, FNO_VALIDATION, FNO_VALIDATION_PARAMS, type LogicStamp } from '../config/trading-flags.js';
import { bandVote, type Vote } from './vote-bands.js';
import {
  evaluateIntradayPositioning,
  resolvePositioningVotes,
  type FuturesSnapshotPoint,
  type IntradayPositioningRead,
  type OptionLegSnapshotPoint,
  type PcrSnapshotPoint,
  type PositioningBaselines,
} from './intraday-positioning.js';
import { classifyRegime, applyFastIntradayRegime, persistedBreakout, type RegimeSource } from './regime-classifier.js';
import { mintOnce, mintLockKey } from './setup-mint-lock.js';
import { IV_PRESSURE_MIN_PCT } from './option-chain.js';
import {
  closingGuardReason,
  concurrencyGateReason,
  evaluateValidationGateDiagnostics,
  locationGateReason,
  minutesToSessionClose,
  roomGateReason,
  roomV2,
} from './validation-gates.js';
import type { ExposureSnapshot } from './exposure-tracker.js';
import { stopOvershootPct } from './stop-overshoot.js';
import type { NoTradeCode, TradeDecision } from '@fno/shared';
import { assessTradeHealth, emptyExcursion, updateExcursion, mfeInAtr, deadTradeMarker, type TradeExcursion, type TradeHealthAssessment } from './trade-health.js';
import { notifyTradeSetupClosed } from './trade-setup-close-notifier.js';
import type { TradeCloseReason } from './trade-setup-close-notifier.js';
import type { OptionChain } from '@fno/shared';
// Momentum-break round (flag MOMENTUM_BREAK): the trigger family that shares
// the sticky slot. The detector is pure (@fno/analytics); the slot and gate
// decisions are pure (momentum-break-live.ts); this file only wires them in.
import { evaluateMomentumBreak, prepareMomentumSeries, recentMomentumBreak, MOMENTUM_BREAK_VARIANTS, type MomentumBreakSignal, type MomentumBreakVariant } from '@fno/analytics';
import { MOMENTUM_BREAK_PARAMS, momentumBreakEnabledFor } from '../config/trading-flags.js';
import {
  MOMENTUM_BREAK_STRATEGY,
  mergeCandleHistory,
  storedMomentumBreak,
  toClosedMomentumBars,
  triggerQualityDiagnostic,
  triggerRefusal,
  triggerSlotAction,
  triggerSlPremiumPct,
  type SlotAction,
  type StoredMomentumBreak,
} from './momentum-break-live.js';
// F&O trade validation (Part A, flag FNO_VALIDATION): strike by delta, the IV
// cap on the target, and the next-expiry fallback — for every setup family.
import { capExpectedMoveByHv } from '@fno/analytics';
import type { TradeSetupFnoValidation } from '@fno/shared';
import { buildWithFnoValidation, fnoValidationDiagnostic } from './fno-validation.js';

// Angel One rate-limits historical-candle and Greeks requests far more
// strictly than quotes (a burst of these returns a flat 403) — cache
// longer than the bias poll interval (60s) so repeat polls for the same
// symbol reuse the last fetch instead of re-hitting the broker.
const HISTORICAL_CACHE_TTL_SECONDS = 90;
// Candle downloads were the rate-limit bottleneck (1,756 of 1,963 rejected
// requests on 16 Sep). The 15m tier needs to stay fresh, but 1H and Daily
// bars barely change in 90s, and a borrowed futures volume series only
// feeds ratios over completed bars.
const INTRADAY_LONG_TIER_CACHE_TTL_SECONDS = 5 * 60; // 1H
const POSITIONAL_SHORT_TIER_CACHE_TTL_SECONDS = 5 * 60; // 1H
const POSITIONAL_LONG_TIER_CACHE_TTL_SECONDS = 30 * 60; // Daily
const FUTURES_VOLUME_CACHE_TTL_SECONDS = 5 * 60;

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
// A poll COUNT alone turned out not to measure anything real. Every caller
// of buildMarketBias advances the streak — each open browser view, the
// 5-minute market scanner, the 15-minute institutional scanner — so the
// confirming reads could land seconds apart on the SAME cached candles: on
// 16 Sep a NIFTY CE was closed 4 minutes after it was locked, on reads 3
// seconds apart.
//
// The fix is not a long wait. INTRADAY exits as soon as the opposite read
// repeats on REFRESHED data: a second confident opposite read at least
// HISTORICAL_CACHE_TTL_SECONDS after the first, i.e. after the candle cache
// has refetched — typically ~90s. Fresh generation then runs in the same
// poll, so a valid setup in the new direction is taken immediately. (A
// fixed 15-minute window was tried and dropped: invalidation should be
// decided by the data, not by a timer.) POSITIONAL keeps a longer window —
// its short tier is 1H candles, which a 90s refresh barely changes.
//
// Only a confident opposite read counts (>= MIN_CONFIDENCE, the same bar a
// new setup needs). NEUTRAL or low-confidence reads say "mixed", not
// "reversed" — they neither advance nor clear a streak; the stop-loss is
// what protects the position while signals are mixed.
const REVERSAL_CONFIRM_POLLS = 2;
const REVERSAL_CONFIRM_SECONDS = HISTORICAL_CACHE_TTL_SECONDS;
const REVERSAL_CONFIRM_SECONDS_POSITIONAL = 120 * 60;

export interface MarketBiasResult {
  bias: MarketBias;
  score: IntelligenceScore;
  tradeSetup: TradeSetup;
}

// Vote and bandVote come from vote-bands.ts (see the imports).

// When each symbol/mode's bias was last computed successfully by anyone (a
// browser poll, a scanner, the trade-setup monitor) — so the monitor's own
// bias recheck can skip symbols that were just read. In-process only; a
// restart simply means the first recheck isn't skipped.
const biasComputedAt = new Map<string, number>();

export function lastBiasComputedAt(exchange: Exchange, underlying: string, mode: TradingMode): number | undefined {
  return biasComputedAt.get(`${exchange}:${underlying}:${mode}`);
}

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

/**
 * The historical candles a bias read needs (and, for NSE/BSE indices, the
 * nearest future's volume borrowed onto them), fetched through the same
 * cache keys and TTLs the read uses. Split out of computeMarketBias so the
 * cache warmer can pre-load exactly these inputs without computing a bias —
 * a bias read has side effects (it mints trade setups and advances the vote
 * hold state), so warming must never call it.
 */
export async function loadBiasCandles(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  isPositional: boolean
): Promise<{ candles15m: OHLCV[]; candles1h: OHLCV[]; volumeSource: 'UNDERLYING' | 'NEAREST_FUTURE' | 'NONE' }> {
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

  // The fetch window ends at the decision instant, never at the wall clock,
  // so a replay asks the broker for exactly the bars that existed then.
  const now = decisionDate();
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
  // Cache keys name the history length too where a key could otherwise be
  // shared by two different requests. POSITIONAL's short tier (1H over 60
  // days) used to be `…:1h` — the same key as INTRADAY's long tier (1H over
  // 30 days) — so whichever was fetched first served both, and positional
  // indicators could run on 30 days of 1H bars. INTRADAY keys are unchanged
  // on purpose: chart-patterns.ts fetches the same 15m/10d and 1h/30d series
  // under those keys and shares that cache.
  const shortIntervalKey = isPositional ? '1h-60d' : '15m';
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
  // The stagger only matters between real broker calls. It used to run
  // unconditionally, so every bias read paid 1.2-2.4s of sleep even when
  // every series came straight from the cache.
  let fetchedSinceStagger = false;
  const fetchCandles = (params: Parameters<typeof fetchHistoricalWithRetry>[1]) => {
    fetchedSinceStagger = true;
    return fetchHistoricalWithRetry(provider, params);
  };
  const staggerIfFetched = async () => {
    if (fetchedSinceStagger) await sleep(1200);
    fetchedSinceStagger = false;
  };

  let candles15m = await cached(
    `hist:${exchange}:${historicalToken}:${shortIntervalKey}`,
    isPositional ? POSITIONAL_SHORT_TIER_CACHE_TTL_SECONDS : HISTORICAL_CACHE_TTL_SECONDS,
    () => fetchCandles({ exchange, token: historicalToken, interval: shortInterval, fromDate: from15m, toDate }),
    nonEmpty
  );
  await staggerIfFetched();
  let candles1h = await cached(
    `hist:${exchange}:${historicalToken}:${longIntervalKey}`,
    isPositional ? POSITIONAL_LONG_TIER_CACHE_TTL_SECONDS : INTRADAY_LONG_TIER_CACHE_TTL_SECONDS,
    () => fetchCandles({ exchange, token: historicalToken, interval: longInterval, fromDate: from1h, toDate }),
    nonEmpty
  );

  // --- Volume for NSE/BSE indices ---
  // Index candles carry no volume at all, so every volume-gated read was
  // silently off for NIFTY/SENSEX/BANKNIFTY: session VWAP (it collapsed to
  // spot), volume-confirmed Supertrend flips and Bollinger breakouts, the
  // BREAKOUT/BREAKDOWN regime and the 1H flip confirmation — while
  // vwapDataAvailable still reported true. The index's nearest future
  // trades the same flow with real volume, so borrow it bar for bar (its
  // short-tier bars map directly, and are summed into the long tier's
  // bars). Price indicators stay on the index itself. Caveat: in the last
  // days before a futures rollover the nearest contract's volume thins as
  // flow moves to the next month.
  let volumeSource: 'UNDERLYING' | 'NEAREST_FUTURE' | 'NONE' = 'UNDERLYING';
  if (exchange !== 'MCX' && !hasRecentVolume(candles15m)) {
    volumeSource = 'NONE';
    const volumeFuture = await resolveNearestFuturesContract(provider, underlying, exchange).catch(() => undefined);
    if (volumeFuture) {
      await staggerIfFetched();
      const futureCandles = await cached(
        `hist:${exchange}:FO:${volumeFuture.token}:${shortIntervalKey}`,
        FUTURES_VOLUME_CACHE_TTL_SECONDS,
        () =>
          fetchCandles({
            exchange,
            segment: 'FO',
            token: volumeFuture.token,
            interval: shortInterval,
            fromDate: from15m,
            toDate,
          }),
        nonEmpty
      );
      if (hasRecentVolume(futureCandles)) {
        candles15m = withBorrowedVolume(candles15m, futureCandles);
        candles1h = withBorrowedVolume(candles1h, futureCandles);
        volumeSource = 'NEAREST_FUTURE';
      }
    }
  }

  // The look-ahead tripwire. In production the decision instant IS now, so
  // nothing can be ahead of it and this costs one pass over the array. In a
  // replay it is the check that stops the engine scoring on bars that had
  // not printed yet: a bar is allowed to have OPENED at or before the
  // decision instant (the newest one is legitimately still forming, which
  // is why the tolerance is one interval), and a bar that opens after it
  // throws rather than quietly becoming evidence.
  assertNoFutureData(`${underlying} ${shortInterval}`, candles15m.map((c) => Date.parse(c.timestamp)));
  assertNoFutureData(`${underlying} ${longInterval}`, candles1h.map((c) => Date.parse(c.timestamp)));

  return { candles15m, candles1h, volumeSource };
}

/** The live momentum-break variant: the pre-registered one the in-sample run chose (env-overridable). */
function liveMomentumVariant(): MomentumBreakVariant {
  const { MOMENTUM_BREAK_RANGE_MULT: rangeMult, MOMENTUM_BREAK_VOL_MULT: volMult } = MOMENTUM_BREAK_PARAMS;
  return MOMENTUM_BREAK_VARIANTS.find((v) => v.rangeMult === rangeMult && v.volMult === volMult) ?? { id: `custom-R${rangeMult}-V${volMult}`, rangeMult, volMult };
}

/**
 * The momentum-break read for one symbol: the trigger on the newest closed
 * 15m bar (or null) and the most recent unreclaimed trigger within
 * BREAKOUT_PERSIST_BARS for the regime assist. The same-slot volume median
 * needs ten previous sessions, more than the bias read's 10 calendar days of
 * 15m candles, so a longer history is loaded (cached longer) and the fresh
 * candles are merged over it. Null — logged — when it cannot be read; a
 * missing trigger read never blocks the consensus read.
 */
async function readMomentumBreak(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  candles15m: OHLCV[]
): Promise<{ trigger: MomentumBreakSignal | null; recent: { signal: MomentumBreakSignal; barsAgo: number } | null } | null> {
  try {
    const history = await loadMomentumHistory(provider, underlying, exchange);
    const bars = toClosedMomentumBars(mergeCandleHistory(history, candles15m), exchange, decisionNow());
    if (bars.length < 2) {
      logger.warn({ underlying, exchange, bars: bars.length }, 'Momentum break: not enough closed 15m bars to evaluate');
      return null;
    }
    const series = prepareMomentumSeries(bars);
    const variant = liveMomentumVariant();
    const i = bars.length - 1;
    const evaluation = evaluateMomentumBreak(series, i, variant);
    const recent = recentMomentumBreak(series, i, COVERAGE_LAG_PARAMS.BREAKOUT_PERSIST_BARS, variant);
    if (evaluation.signal) {
      logger.info({ underlying, exchange, trigger: evaluation.signal }, 'Momentum break: trigger on the newest closed 15m bar');
    }
    return { trigger: evaluation.signal, recent };
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange }, 'Momentum break: read failed — no trigger this poll');
    return null;
  }
}

/** MOMENTUM_BREAK_HISTORY_DAYS of 15m candles (index volume borrowed from the nearest future, as loadBiasCandles does). */
async function loadMomentumHistory(provider: MarketDataProvider, underlying: string, exchange: Exchange): Promise<OHLCV[]> {
  const spotToken = await resolveSpotToken(provider, underlying, exchange);
  const token = exchange === 'MCX' ? (await resolveNearestFuturesContract(provider, underlying, exchange))?.token ?? spotToken : spotToken;
  const now = decisionDate();
  const days = MOMENTUM_BREAK_PARAMS.MOMENTUM_BREAK_HISTORY_DAYS;
  const ttl = MOMENTUM_BREAK_PARAMS.MOMENTUM_BREAK_HISTORY_TTL_SECONDS;
  const fromDate = formatAngelDateTime(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  const toDate = formatAngelDateTime(now);
  const nonEmpty = (c: OHLCV[]) => c.length > 0;
  // Same stagger rule as loadBiasCandles: only between real broker calls.
  let fetched = false;
  let candles = await cached(
    `hist:${exchange}:${token}:15m-${days}d`,
    ttl,
    () => {
      fetched = true;
      return fetchHistoricalWithRetry(provider, { exchange, token, interval: 'FIFTEEN_MINUTE', fromDate, toDate });
    },
    nonEmpty
  );
  if (exchange !== 'MCX' && !hasRecentVolume(candles)) {
    const future = await resolveNearestFuturesContract(provider, underlying, exchange).catch((err: any) => {
      logger.warn({ error: err.message, underlying, exchange }, 'Momentum break: nearest future unresolved — history has no volume');
      return undefined;
    });
    if (future) {
      if (fetched) await sleep(1200);
      const futureCandles = await cached(
        `hist:${exchange}:FO:${future.token}:15m-${days}d`,
        ttl,
        () => fetchHistoricalWithRetry(provider, { exchange, segment: 'FO', token: future.token, interval: 'FIFTEEN_MINUTE', fromDate, toDate }),
        nonEmpty
      );
      if (hasRecentVolume(futureCandles)) candles = withBorrowedVolume(candles, futureCandles);
    }
  }
  assertNoFutureData(`${underlying} FIFTEEN_MINUTE ${days}d`, candles.map((c) => Date.parse(c.timestamp)));
  return candles;
}

async function computeMarketBias(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  resultCacheKey: string,
  mode: TradingMode = 'INTRADAY'
): Promise<MarketBiasResult> {
  const isPositional = mode === 'POSITIONAL';

  const { candles15m, candles1h, volumeSource } = await loadBiasCandles(provider, underlying, exchange, isPositional);

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

  // Post-close OI snapshots are taken for chains the bias engine reads — see oi-close-snapshot.ts.
  if (chain) trackSymbolForOiSnapshot(exchange, underlying, chain.expiry);

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
  // EMA20/EMA50 trend structure on the long tier (1H/Daily) — a classic
  // trend-following filter distinct from Supertrend: are the moving
  // averages actually stacked (price > EMA20 > EMA50, or the mirror) AND
  // sloping in that direction, not just "price happens to be above them
  // right now." `aligned` alone can be true on a flat/tangled EMA — only
  // `aligned && slopeOk` together mean a real trend structure.
  const emaTrend = detectEmaTrendStructure(c1h.closes);
  // Last COMPLETE bar, not the still-forming one — same partial-candle
  // distortion documented on the 15m ratio below, and worse here since a
  // 1H/Daily bar spends far longer partially formed.
  const longCompletedVolumes = c1h.volumes.slice(0, -1);
  const longVolSeries = longCompletedVolumes.slice(-20);
  const longAvgVolume = longVolSeries.length > 0 ? longVolSeries.reduce((a, b) => a + b, 0) / longVolSeries.length : 0;
  const longLastVolume = longCompletedVolumes[longCompletedVolumes.length - 1] ?? 0;
  const longVolumeRatio = longAvgVolume > 0 && longLastVolume > 0 ? longLastVolume / longAvgVolume : 1;

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
  // VWAP is volume-weighted, so a feed that carries no volume (indices,
  // routinely) yields nothing usable here and this silently fell back to
  // `spot` — which then reads out as "Price near VWAP (23,663.20 ≈
  // 23,663.20)", presenting a missing input as though it were a finding,
  // and left vwapVote permanently neutral with nothing flagging why.
  const sessionVwapRaw = sessionVwapSeries[sessionVwapSeries.length - 1];
  // A VWAP from candles with no volume isn't a VWAP — this used to report
  // true for indices while the value was simply spot.
  const vwapDataAvailable =
    sessionVwapRaw != null && Number.isFinite(sessionVwapRaw) && sessionVwapRaw > 0 && todaysCandles.some((c) => c.volume > 0);
  const sessionVwap = vwapDataAvailable ? sessionVwapRaw : spot;

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
  // Closed bars only. A sweep is defined as a wick THROUGH a swing level
  // followed by a close back inside it, so run on the forming bar it was
  // being judged against a running close: a wick through a swing high with
  // price merely still below it read as a completed sweep, and pushed a
  // structure vote (which, unlike the price votes, carries no hysteresis)
  // that disappeared when the bar closed above the level. Same treatment
  // fair value gaps already had. Costs one bar of latency, which is the
  // honest price of the signal meaning what it says.
  const liquiditySweep = detectLiquiditySweep(c15.highs.slice(0, -1), c15.lows.slice(0, -1), c15.closes.slice(0, -1));
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
  // Same reasoning as st15JustFlipped above, but this one had NO
  // equivalent protection at all until now — found live: Market Regime
  // flipped STRONG_BULL_TREND -> STRONG_BEAR_TREND inside 2 minutes at
  // an unchanged ADX, which can only mean the CURRENT (still-forming,
  // not yet closed) 1H candle's Supertrend wobbled across its own flip
  // line and back — a whipsaw on incomplete-candle data, not a genuine
  // new trend. st1hFlipConfirmed/st1hDirectionConfirmed (below, once
  // VOLUME_CONFIRM_THRESHOLD is in scope) resolve this — Regime has no
  // "0/neutral" a vote can fall back to, so an unconfirmed flip falls
  // back to the PREVIOUS bar's direction instead of suppressing to zero.
  const st1hPrevDirection = st1h.direction[st1h.direction.length - 2] ?? st1hDirection;
  const st1hJustFlipped = st1hDirection !== st1hPrevDirection;

  const adx1h = adx(c1h.highs, c1h.lows, c1h.closes, 14);
  const adxValue = adx1h.adx[adx1h.adx.length - 1] ?? 15;

  // ATR on the SHORT tier (15m intraday, 1H positional) — the scale a stop or
  // target has to survive, and the one the stop/target forensics were measured
  // on. atr1h below stays the long-tier read the regime classifier uses.
  const atrShort = atr(c15.highs, c15.lows, c15.closes, 14);
  const atrShortNow = atrShort[atrShort.length - 1] ?? 0;

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

  // The most recent candle is still FORMING — poll at 12:52 and the
  // 12:45-13:00 bar holds 7 of its 15 minutes. Comparing that partial bar
  // against a 20-bar average of COMPLETE bars understated the ratio by
  // roughly half on average and made it sawtooth within every bucket (near
  // zero just after a bar opens, peaking as it closes), so "volume
  // confirmation" was really measuring what time it happened to be. That
  // silently withheld the Bollinger-breakout and Supertrend-flip votes
  // below, and left the Market Scanner's whole 10-point Volume category
  // reading ~0 almost always. Compare the last COMPLETE bar instead.
  const completedVolumes = c15.volumes.slice(0, -1);
  const volSeries15 = completedVolumes.slice(-20);
  const avgVolume15 = volSeries15.length > 0 ? volSeries15.reduce((a, b) => a + b, 0) / volSeries15.length : 0;
  const lastVolume15 = completedVolumes[completedVolumes.length - 1] ?? 0;
  // Indices (NIFTY/BANKNIFTY/FINNIFTY) often report no volume at all, which
  // lands here as avgVolume15 === 0. The 1 fallback is "no information",
  // NOT "exactly average" — volumeDataAvailable below is what downstream
  // consumers should check before reading anything into the ratio.
  const volumeDataAvailable = avgVolume15 > 0 && lastVolume15 > 0;
  const volumeRatio = volumeDataAvailable ? lastVolume15 / avgVolume15 : 1;

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
  const putLevels = chain ? findTopOiLevels(chain, 'put') : [];
  const callLevels = chain ? findTopOiLevels(chain, 'call') : [];
  // Displayed support/resistance must sit on the right side of spot: the
  // heaviest put strike overall used to be labelled "support" even above
  // spot (BANKNIFTY 57,500 with spot 56,194 — equal to resistance). These
  // side-aware ladders are for display and reasoning only; room-to-target
  // keeps the unfiltered ladders above and applies its own side filter, so
  // trade logic and its strength thresholds are unchanged.
  const levelSpot = chain?.spotPrice ?? spot;
  const supportLevels = chain ? findTopOiLevels(chain, 'put', OI_LEVEL_COUNT, { atOrBelow: levelSpot }) : [];
  const resistanceLevels = chain ? findTopOiLevels(chain, 'call', OI_LEVEL_COUNT, { atOrAbove: levelSpot }) : [];
  const putWall = supportLevels[0] ?? null;
  const callWall = resistanceLevels[0] ?? null;

  // --- Option OI flow: buying-vs-writing / covering-vs-unwinding, aggregated ---
  // Rising OI alone is ambiguous on both sides: CALL_WRITING (bearish,
  // sellers capping the strike) and CALL_BUYING (bullish, buyers paying up)
  // both show "call OI up"; PUT_BUYING (bearish, fresh downside bets) and
  // PUT_WRITING (bullish, writers confident price holds above) both show
  // "put OI up." classifyOptionOI (via option-chain.ts, already on every
  // leg as oiInterpretation) resolves this per-leg using that leg's OWN
  // premium direction. This aggregates that read across the whole chain,
  // weighted by how much OI actually moved on each leg today (not resting
  // OI) so one big-but-quiet strike can't drown out several small-but-active
  // ones, and reports which single interpretation (e.g. "Put Writing")
  // dominated for the reasoning line below.
  let optionOiFlowBullishWeight = 0;
  let optionOiFlowBearishWeight = 0;
  const optionOiFlowWeightByType = new Map<OIInterpretation, number>();
  //
  // Weights are only comparable when every leg's change is measured from the
  // same point. Legs measured from the previous session's settled OI are;
  // legs with no such snapshot fall back to their first reading this
  // session and understate the day. When most legs have a previous-close
  // baseline, the fallback legs are left out rather than mixed in.
  const chainLegs: OptionChainLeg[] = chain
    ? chain.strikes.flatMap((s) => [s.call, s.put]).filter((l): l is OptionChainLeg => l != null && l.changeOiBaseline != null)
    : [];
  const prevCloseLegs = chainLegs.filter((l) => l.changeOiBaseline === 'PREV_CLOSE');
  const optionOiBaselineCoverage = chainLegs.length > 0 ? prevCloseLegs.length / chainLegs.length : 0;
  const flowLegs = optionOiBaselineCoverage >= OPTION_OI_MIN_PREV_CLOSE_COVERAGE ? prevCloseLegs : chainLegs;
  for (const leg of flowLegs) {
    if (leg.changeOi === 0) continue;
    const weight = Math.abs(leg.changeOi);
    const { implication } = getOIDescription(leg.oiInterpretation);
    if (implication === 'BULLISH') optionOiFlowBullishWeight += weight;
    else if (implication === 'BEARISH') optionOiFlowBearishWeight += weight;
    optionOiFlowWeightByType.set(leg.oiInterpretation, (optionOiFlowWeightByType.get(leg.oiInterpretation) ?? 0) + weight);
  }
  const optionOiFlowTotalWeight = optionOiFlowBullishWeight + optionOiFlowBearishWeight;
  const optionOiFlowNetSkew =
    optionOiFlowTotalWeight > 0 ? (optionOiFlowBullishWeight - optionOiFlowBearishWeight) / optionOiFlowTotalWeight : 0;
  let optionOiFlowDominant: OIInterpretation | null = null;
  let optionOiFlowDominantWeight = 0;
  for (const [type, weight] of optionOiFlowWeightByType) {
    if (weight > optionOiFlowDominantWeight) {
      optionOiFlowDominant = type;
      optionOiFlowDominantWeight = weight;
    }
  }

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
  // Short-tier only (15m in INTRADAY) — the opening/closing noise window
  // is about THIS SESSION's clock, not the long tier VCP checks below
  // read off (1H/Daily), so only the short-tier bar gets raised, and
  // only for INTRADAY (a POSITIONAL hold doesn't care what time it is
  // right now).
  const effectiveVolumeConfirmThreshold =
    !isPositional && isNoisyIntradayWindow(exchange) ? VOLUME_CONFIRM_THRESHOLD * NOISY_WINDOW_VOLUME_MULTIPLIER : VOLUME_CONFIRM_THRESHOLD;
  const volumeConfirms = volumeRatio >= effectiveVolumeConfirmThreshold;
  const vcpBreakoutConfirmed = vcp != null && vcp.breakoutRatio >= 1 && longVolumeRatio >= VOLUME_CONFIRM_THRESHOLD;
  // Base threshold, not the noisy-window-adjusted one — same reasoning as
  // vcpBreakoutConfirmed above: this reads the LONG tier (1H/Daily), not
  // the current session's opening/closing minutes.
  const st1hFlipConfirmed = !st1hJustFlipped || longVolumeRatio >= VOLUME_CONFIRM_THRESHOLD;
  const st1hDirectionConfirmed = st1hFlipConfirmed ? st1hDirection : st1hPrevDirection;

  // Positional requires a higher-conviction RSI reading (60/40 vs 55/45) —
  // a multi-day hold shouldn't be triggered by the same mild RSI lean
  // that's meaningful for an intraday scalp.
  const rsiBullThreshold = isPositional ? 60 : 55;
  const rsiBearThreshold = isPositional ? 40 : 45;

  // Hold bands (hysteresis) on every threshold vote — see bandVote. The
  // entry thresholds are unchanged; a vote that's already on now stays on
  // until its reading falls back through a slightly looser hold level,
  // instead of flipping off and on as the reading ticks across one line.
  // Previous states live in Redis because the bias is recomputed per poll.
  const voteStateKey = `bias_vote_state:${exchange}:${underlying}:${mode}`;
  const prevVotes = await readVoteState(voteStateKey);

  const vwapDeviationPct = vwapDataAvailable && sessionVwap > 0 ? (spot / sessionVwap - 1) * 100 : 0;
  const vwapVote: Vote = vwapDataAvailable ? bandVote(vwapDeviationPct, prevVotes?.vwap, 0.05, 0, -0.05, 0) : 0;
  const rsiVote: Vote = bandVote(
    rsi15,
    prevVotes?.rsi,
    rsiBullThreshold,
    rsiBullThreshold - RSI_HOLD_BAND,
    rsiBearThreshold,
    rsiBearThreshold + RSI_HOLD_BAND
  );
  const st15Vote: Vote = st15JustFlipped && !volumeConfirms ? 0 : st15Direction === 'UP' ? 1 : -1;
  const st1hVote: Vote = st1hDirectionConfirmed === 'UP' ? 1 : -1;
  // Long buildup and short covering both vote bullish (short buildup and
  // long unwinding bearish), so this vote is "which way is the futures
  // contract moving today, with OI actually changing". Its classifier flips
  // at a 0.01% day move — pure noise — so the vote is banded on that move.
  const futuresDayChangePct = currentFuture?.changePercent ?? null;
  // The three positioning votes below are the DAY-LEVEL reads (measured from
  // the previous close). With INTRADAY_POSITIONING on, each is replaced by its
  // intraday-window vote when that window has enough fresh snapshots — see
  // resolvePositioningVotes further down.
  const futuresOiVoteDay: Vote =
    futuresInterpretation === 'NEUTRAL'
      ? 0
      : futuresDayChangePct != null
      ? bandVote(futuresDayChangePct, prevVotes?.futuresOi, FUTURES_MOVE_ENTER_PCT, FUTURES_MOVE_HOLD_PCT, -FUTURES_MOVE_ENTER_PCT, -FUTURES_MOVE_HOLD_PCT)
      : futuresInterpretation === 'LONG_BUILDUP' || futuresInterpretation === 'SHORT_COVERING'
      ? 1
      : -1;
  const pcrVoteDay: Vote = bandVote(pcr, prevVotes?.pcr, 1.1, 1.05, 0.85, 0.9);
  // Only counts when the EMAs are both stacked AND sloping in that
  // direction — a flat/tangled EMA20 sitting on price (aligned but not
  // sloping) is exactly the chop signature this vote should stay silent on.
  const emaTrendVote: Vote =
    emaTrend?.aligned && emaTrend.slopeOk ? (emaTrend.direction === 'BULLISH' ? 1 : -1) : 0;
  // Require a real net skew (not a near-50/50 split) before this counts as
  // a vote — same noise-floor philosophy as the PCR bands above.
  const OPTION_OI_FLOW_MIN_SKEW = 0.15;
  const OPTION_OI_FLOW_HOLD_SKEW = 0.08;
  const optionOiFlowVoteDay: Vote = bandVote(
    optionOiFlowNetSkew,
    prevVotes?.optionOiFlow,
    OPTION_OI_FLOW_MIN_SKEW,
    OPTION_OI_FLOW_HOLD_SKEW,
    -OPTION_OI_FLOW_MIN_SKEW,
    -OPTION_OI_FLOW_HOLD_SKEW
  );

  // --- Intraday positioning window (flag INTRADAY_POSITIONING, INTRADAY only) ---
  // The same three reads measured over the last INTRADAY_POSITIONING_WINDOW_MIN
  // minutes of captured snapshots instead of since yesterday's close, with the
  // same classifiers and the same entry/hold bands. Each input falls back to
  // its day-level vote on its own when its window is thin or stale. Flag off
  // (or POSITIONAL) = no read at all, and the day-level votes stand unchanged.
  let intradayPositioning: IntradayPositioningRead | null = null;
  if (COVERAGE_LAG_FLAGS.INTRADAY_POSITIONING && !isPositional) {
    const now = decisionNow();
    const rows = await loadIntradayPositioningRows({
      exchange,
      underlying,
      futuresToken: currentFuture?.token ?? null,
      expiry: chain?.expiry ?? null,
      now,
      windowMin: COVERAGE_LAG_PARAMS.INTRADAY_POSITIONING_WINDOW_MIN,
    });
    intradayPositioning = evaluateIntradayPositioning(
      { ...rows, prev: prevVotes },
      {
        now,
        windowMin: COVERAGE_LAG_PARAMS.INTRADAY_POSITIONING_WINDOW_MIN,
        minSnapshots: COVERAGE_LAG_PARAMS.INTRADAY_POSITIONING_MIN_SNAPSHOTS,
        maxAgeMin: COVERAGE_LAG_PARAMS.INTRADAY_POSITIONING_MAX_AGE_MIN,
        futuresBand: { enter: FUTURES_MOVE_ENTER_PCT, hold: FUTURES_MOVE_HOLD_PCT },
        pcrBand: { enter: COVERAGE_LAG_PARAMS.INTRADAY_PCR_DELTA_ENTER, hold: COVERAGE_LAG_PARAMS.INTRADAY_PCR_DELTA_HOLD },
        optionFlowBand: { enter: OPTION_OI_FLOW_MIN_SKEW, hold: OPTION_OI_FLOW_HOLD_SKEW },
        optionPriceNoisePct: IV_PRESSURE_MIN_PCT,
      }
    );
  }
  const resolvedPositioning = resolvePositioningVotes(
    { futuresOiVote: futuresOiVoteDay, pcrVote: pcrVoteDay, optionOiFlowVote: optionOiFlowVoteDay, futuresChangeOiPct },
    intradayPositioning
  );
  const futuresOiVote: Vote = resolvedPositioning.futuresOiVote;
  const pcrVote: Vote = resolvedPositioning.pcrVote;
  const optionOiFlowVote: Vote = resolvedPositioning.optionOiFlowVote;
  const positioningBaseline: PositioningBaselines = resolvedPositioning.baselines;
  // The OI-shift score's magnitude — the window ΔOI% when the futures window was used.
  const oiShiftChangeOiPct = resolvedPositioning.futuresChangeOiPct;

  // Operator/retail activity regime: real positioning data (futures OI
  // buildup, an OI wall actually under price pressure, PCR skew) instead
  // of a smoothed transformation of past price like ADX/Supertrend below
  // — this is where large/informed participants have actually committed
  // capital right now, not a lagging read of where price has already
  // been. Requires ALL THREE to agree (unanimous, not just a majority)
  // plus the futures OI change to clear a real magnitude, not a noise-
  // level blip — kept deliberately hard to trigger so it stays a genuine
  // high-conviction override, the same bar BREAKOUT/BREAKDOWN's own
  // volume-confirmation already holds leading signals to.
  const OPERATOR_ACTIVITY_MIN_OI_CHANGE_PCT = 3;
  const oiWallPressureVote: Vote = chain?.oiTrap.call.active ? 1 : chain?.oiTrap.put.active ? -1 : 0;
  const operatorActivityVotes = [futuresOiVote, oiWallPressureVote, pcrVote];
  const operatorActivityUnanimous =
    operatorActivityVotes.every((v) => v === 1) || operatorActivityVotes.every((v) => v === -1);
  const operatorActivityConfirmed = operatorActivityUnanimous && Math.abs(futuresChangeOiPct) >= OPERATOR_ACTIVITY_MIN_OI_CHANGE_PCT;
  const operatorActivityBullish = operatorActivityConfirmed && futuresOiVote === 1;
  const operatorActivityBearish = operatorActivityConfirmed && futuresOiVote === -1;

  // MACD histogram as % of price, so one band works for NIFTY and NATURALGAS
  // alike; it used to flip on any sign change, however tiny.
  const macdHistPct = spot > 0 ? (macdHistNow / spot) * 100 : 0;
  const macdVote: Vote = bandVote(macdHistPct, prevVotes?.macd, MACD_ENTER_PCT, 0, -MACD_ENTER_PCT, 0);
  const bbBreakout = bbPercentB > 1 || bbPercentB < 0;
  const bollingerVote: Vote = bbBreakout && !volumeConfirms ? 0 : bandVote(bbPercentB, prevVotes?.bollinger, 0.6, 0.55, 0.4, 0.45);

  await writeVoteState(
    voteStateKey,
    { vwap: vwapVote, rsi: rsiVote, futuresOi: futuresOiVote, pcr: pcrVote, optionOiFlow: optionOiFlowVote, macd: macdVote, bollinger: bollingerVote },
    isPositional
  );

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

  // macdVote/bollingerVote were computed above but only ever fed the
  // Intelligence Score's separate "Technicals" dimension — never the
  // actual Bias direction/confidence, despite both being fully-formed
  // votes (bollingerVote already has its own breakout/volume-confirmation
  // guard). Added here as baseline votes, same tier as VWAP/RSI/Supertrend.
  // --- Votes, grouped by INFORMATION SOURCE ---
  //
  // These used to be one flat array, which treated every vote as an
  // independent opinion. They aren't. VWAP, RSI, both Supertrends, MACD,
  // Bollinger and the EMA stack are all transforms of the SAME price
  // series; BOS/CHoCH, FVG, liquidity sweeps, order blocks and chart
  // patterns all come out of ONE swing-structure model. Only the
  // futures-OI / PCR / option-flow reads are genuinely different
  // information — and they were outnumbered roughly 7-to-3 by price
  // derivatives, so a "10-vote consensus" was mostly one source repeated.
  //
  // Grouping them means each source is aggregated first and then capped
  // (see clusterContribution), so no single feed can dominate the verdict
  // by virtue of having more indicators derived from it.
  const priceVotes: Vote[] = [vwapVote, rsiVote, st15Vote, st1hVote, macdVote, bollingerVote, emaTrendVote];
  const structureVotes: Vote[] = [];
  const positioningVotes: Vote[] = [futuresOiVote, pcrVote, optionOiFlowVote];

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
    priceVotes.push(rsiDivergenceVote, rsiDivergenceVote);
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
    structureVotes.push(fvgVote);
  }

  // VCP breakout: bullish-only (see vcp/index.ts — no standard bearish
  // mirror), and only counted once actually confirmed (price cleared the
  // base's high on above-average long-tier volume), not merely "still
  // basing." Counted TWICE like RSI divergence — Minervini treats a
  // volume-confirmed VCP breakout as a high-conviction setup, not an
  // ordinary equal-weight read. Only added when confirmed, same dilution
  // reasoning as the other event-based votes above.
  if (vcpBreakoutConfirmed) {
    priceVotes.push(1, 1);
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
    structureVotes.push(marketStructure.lastEvent.direction === 'BULLISH' ? 1 : -1, marketStructure.lastEvent.direction === 'BULLISH' ? 1 : -1);
  } else if (marketStructure.lastEvent?.type === 'BOS') {
    structureVotes.push(marketStructure.lastEvent.direction === 'BULLISH' ? 1 : -1);
  }

  // Liquidity sweep: a BUY_SIDE sweep ran the stops resting above a
  // prior high and rejected back down — trapped longs, bearish. A
  // SELL_SIDE sweep mirrors it — bullish. Single weight (a trap/zone
  // signal, not a proven-strength reversal read like CHoCH/divergence),
  // only added on an actual sweep this bar.
  if (liquiditySweep) {
    structureVotes.push(liquiditySweep.type === 'SELL_SIDE' ? 1 : -1);
  }

  // Order block test: price is sitting inside an unmitigated order block
  // zone right now — the same "zone under live test" shape as the FVG
  // vote above, single weight for the same reason.
  const orderBlockVote: Vote = activeOrderBlock == null ? 0 : activeOrderBlock.block.type === 'BULLISH' ? 1 : -1;
  if (orderBlockVote !== 0) {
    structureVotes.push(orderBlockVote);
  }

  // Chart structure (Double Top/H&S/Triangle/Wedge/Flag/...) was
  // reasoning-only until now — detected and shown, but never actually
  // counted, unlike every other structural signal above. Single weight
  // each; when BOTH tiers detect a pattern with the SAME direction
  // (genuine multi-timeframe confluence — e.g. a Double Bottom on the
  // long tier confirmed by a Bullish Flag on the short tier is a
  // stronger read than either alone), each gets bumped to double weight
  // instead of just summing two ordinary votes, since agreement across
  // timeframes is itself information a naive sum wouldn't capture. Two
  // real, independently-detected patterns disagreeing still cancel out
  // to a net-zero contribution, which is the correct read for that case.
  // HORIZONTAL_CHANNEL is structurally non-directional (a flat range) — its
  // "confidence" measures how parallel/tight the two trendlines are, not
  // directional conviction, and its BULLISH/BEARISH label is only a crude
  // 20-bar trailing-momentum guess unrelated to the range itself. Letting
  // that vote (or count toward confluence) dressed it up as a real
  // directional signal it isn't. ASCENDING/DESCENDING_CHANNEL keep voting —
  // those have a genuine slope-derived direction.
  const shortTermPatternVotes = shortTermPattern != null && shortTermPattern.pattern !== 'HORIZONTAL_CHANNEL';
  const longTermPatternVotes = longTermPattern != null && longTermPattern.pattern !== 'HORIZONTAL_CHANNEL';
  const patternsAgree = shortTermPatternVotes && longTermPatternVotes && shortTermPattern!.direction === longTermPattern!.direction;
  if (shortTermPatternVotes) {
    const v: Vote = shortTermPattern!.direction === 'BULLISH' ? 1 : -1;
    structureVotes.push(v);
    if (patternsAgree) structureVotes.push(v);
  }
  if (longTermPatternVotes) {
    const v: Vote = longTermPattern!.direction === 'BULLISH' ? 1 : -1;
    structureVotes.push(v);
    if (patternsAgree) structureVotes.push(v);
  }

  // Aggregate each information source, then cap what it can contribute.
  //
  // Within a cluster the votes still add up normally — that's what lets a
  // double-weighted CHoCH or RSI divergence outweigh an ordinary read, as
  // intended. What's capped is how far ANY single source can push the
  // final verdict, so that "7 price-derived indicators agree" can no
  // longer simply outvote the option-positioning read on its own. Two
  // sources x 3 = 6 possible decisive votes: the candles, and positioning.
  const CLUSTER_MAX_WEIGHT = 3;
  const clusterContribution = (votes: Vote[]): Vote[] => {
    const net = votes.reduce((a: number, b) => a + b, 0);
    if (net === 0) return [];
    const sign: Vote = net > 0 ? 1 : -1;
    return Array<Vote>(Math.min(Math.abs(net), CLUSTER_MAX_WEIGHT)).fill(sign);
  };

  // Price indicators and chart structure are ONE information source — both
  // are read off the same candles — so they're capped together. As two
  // separate clusters they outvoted positioning two to one on a single
  // short pullback: found live on CRUDEOIL, where futures short covering,
  // PCR and chain-wide put writing all read bullish (positioning maxed at
  // +3), yet a one-hour dip below VWAP showed up in BOTH candle clusters
  // (-2 price, -3 structure) and minted a PE.
  const chartVotes: Vote[] = [...priceVotes, ...structureVotes];
  const chartNet = chartVotes.reduce((a: number, b) => a + b, 0);
  const positioningNet = positioningVotes.reduce((a: number, b) => a + b, 0);

  const directionVotes: Vote[] = [
    ...clusterContribution(chartVotes),
    ...clusterContribution(positioningVotes),
  ];

  // Every vote behind this read, persisted with each trade setup so a
  // setup's outcome can later be analysed against what actually drove it.
  const voteSnapshot: BiasVoteSnapshot = {
    price: {
      vwap: vwapVote,
      rsi: rsiVote,
      supertrendShort: st15Vote,
      supertrendLong: st1hVote,
      macd: macdVote,
      bollinger: bollingerVote,
      emaTrend: emaTrendVote,
      rsiDivergence: rsiDivergenceVote,
      vcpBreakout: vcpBreakoutConfirmed ? 1 : 0,
    },
    structure: [...structureVotes],
    positioning: { futuresOi: futuresOiVote, pcr: pcrVote, optionOiFlow: optionOiFlowVote },
    chartNet,
    positioningNet,
  };

  const voteSum = directionVotes.reduce((a: number, b) => a + b, 0);
  const votesFor = directionVotes.filter((v) => v === 1).length;
  const votesAgainst = directionVotes.filter((v) => v === -1).length;
  const votesFlat = directionVotes.length - votesFor - votesAgainst;

  const direction: BiasDirection = voteSum > 0 ? 'BULLISH' : voteSum < 0 ? 'BEARISH' : 'NEUTRAL';
  const directionSign = direction === 'BULLISH' ? 1 : direction === 'BEARISH' ? -1 : 0;

  // A cluster that nets zero contributes nothing at all, so `total` is 0
  // when every information source is internally balanced — genuinely "no
  // read", and the only case where these ratios would divide by zero.
  const total = directionVotes.length;
  // Each side's share of the evidence, measured WITHIN each information
  // source and then averaged across sources — see the confidence note below.
  const sourceShares = (votes: Vote[]): { bull: number; bear: number } | null => {
    const bull = votes.filter((v) => v === 1).length;
    const bear = votes.filter((v) => v === -1).length;
    return bull + bear > 0 ? { bull: bull / (bull + bear), bear: bear / (bull + bear) } : null;
  };
  const opinionatedSources = [sourceShares(chartVotes), sourceShares(positioningVotes)].filter(
    (s): s is { bull: number; bear: number } => s != null
  );
  const bullShare = opinionatedSources.length > 0 ? opinionatedSources.reduce((sum, s) => sum + s.bull, 0) / opinionatedSources.length : 0;
  const bearShare = opinionatedSources.length > 0 ? 1 - bullShare : 0;
  // Always sums to exactly 100; all-neutral only when no source has a decisive vote.
  const bullishProbability = opinionatedSources.length > 0 ? Math.round(bullShare * 100) : 0;
  const bearishProbability = opinionatedSources.length > 0 ? 100 - bullishProbability : 0;
  const neutralProbability = opinionatedSources.length > 0 ? 0 : 100;

  // Confidence = agreement among the votes that actually HAVE an opinion,
  // scaled down when few of them do.
  //
  // It used to be agreementCount / total, counting flat (0) votes in the
  // denominator, which made it measure "how much is happening" rather than
  // "how sure are we": 6-for/0-against/8-flat scored 43% (a UNANIMOUS read,
  // rejected by every gate) while a genuinely contested 9-for/5-against
  // scored 64% and passed. Flats came from indicators sitting neutral, and
  // from inputs the feed simply didn't carry — so a symbol with missing
  // VWAP/volume data was penalised as though its indicators disagreed.
  //
  // Excluding flats fixes the dilution, but on its own would let a lone
  // read print 100%, so it's scaled by how much INDEPENDENT evidence there
  // is. Now that votes are clustered by information source, the honest
  // measure of evidence is how many separate sources actually spoke — not
  // how many indicators did, since seven price-derived indicators agreeing
  // is one source, not seven. Two independent sources agreeing is real
  // evidence; one source alone is capped at half.
  //
  // Measured per source, not on the capped cluster outputs. Capping keeps
  // either source from outvoting the other on indicator count — right for
  // DIRECTION — but comparing only the capped nets erased each source's
  // internal disagreement: SENSEX read BULLISH 95 with its chart votes split
  // 4-3 (net +1) plus positioning +2, i.e. "3 of 3 decisive votes agree".
  // Now each source contributes the share of ITS OWN decisive votes that
  // agree with the direction (a 4-3 chart counts 0.57, not 1.0), sources
  // weighted equally so neither dominates by indicator count. That SENSEX
  // read is 79, and a chart leaning against the call pulls confidence down.
  const MIN_INDEPENDENT_SOURCES = 2;
  const evidenceFactor = Math.min(1, opinionatedSources.length / MIN_INDEPENDENT_SOURCES);
  const agreementShare = direction === 'BULLISH' ? bullShare : direction === 'BEARISH' ? bearShare : 0;
  const confidence =
    direction === 'NEUTRAL'
      ? // Two different "neutral"s: every source silent (no read at all), or
        // sources actively cancelling each other out (a contested market).
        // Neither deserves a confident number; the contested case deserves
        // the floor.
        clamp(total === 0 ? 50 : 15, 15, 95)
      : clamp(Math.round(agreementShare * evidenceFactor * 100), 15, 95);

  // --- Regime: leading breakout/breakdown (fresh, volume-confirmed Bollinger break) takes priority over the lagging ADX-based trend read, overridden by expiry-day gamma when DTE<=1 ---
  const baseRegime = classifyRegime(adxValue, st1hDirectionConfirmed, atrPctZ, chain?.dte ?? null, chain?.gammaExposure?.regime ?? null, freshBreakoutUp, freshBreakoutDown, operatorActivityBullish, operatorActivityBearish);
  // FAST_INTRADAY_REGIME (INTRADAY only): a 15m-ADX trend read when the 1H
  // ADX found none, and a fresh breakout held while price stays beyond the
  // Bollinger midline — see regime-classifier.ts. Off (or POSITIONAL) = the
  // 1H read above, unchanged, and nothing extra is computed.
  const fastRegimeEnabled = COVERAGE_LAG_FLAGS.FAST_INTRADAY_REGIME && !isPositional;
  const adx15Series = fastRegimeEnabled ? adx(c15.highs, c15.lows, c15.closes, 14).adx : [];
  const adx15mValue: number | null = adx15Series.length > 0 ? adx15Series[adx15Series.length - 1] : null;
  // Same flip handling as the 1H direction: an unconfirmed fresh flip reads as the previous bar's direction.
  const st15DirectionConfirmed = st15JustFlipped && !volumeConfirms ? st15PrevDirection : st15Direction;
  const breakoutPersist = fastRegimeEnabled
    ? persistedBreakout({
        closes: c15.closes,
        volumes: c15.volumes,
        upper: bb15.upper,
        middle: bb15.middle,
        lower: bb15.lower,
        maxBars: COVERAGE_LAG_PARAMS.BREAKOUT_PERSIST_BARS,
        volumeConfirmThreshold: VOLUME_CONFIRM_THRESHOLD,
      })
    : null;
  const fastRegime = applyFastIntradayRegime({
    enabled: fastRegimeEnabled,
    baseRegime,
    adx15m: adx15mValue,
    st15Direction: st15DirectionConfirmed,
    persisted: breakoutPersist,
  });

  // --- Momentum-break trigger (flag MOMENTUM_BREAK, INTRADAY, allow-listed symbols) ---
  // The detector runs on the newest CLOSED 15m bar with the same level
  // builder the backtest used. Off (or not allow-listed) = nothing is read or
  // fetched and the regime below is exactly the fast/1H regime. The newest
  // closed bar is always computed (no fetch) so a trigger trade already in the
  // slot can be checked for LEVEL_RECLAIMED even after the flag is turned off.
  const momentumEnabled = momentumBreakEnabledFor(underlying, exchange, mode);
  const momentumRead = momentumEnabled ? await readMomentumBreak(provider, underlying, exchange, candles15m) : null;
  // (INTRADAY only: in POSITIONAL mode `candles15m` holds 1H bars, and trigger trades only live in the INTRADAY slot.)
  const closedNow = isPositional ? [] : toClosedMomentumBars(candles15m, exchange, decisionNow());
  const lastClosedBar = closedNow.length > 0 ? { time: closedNow[closedNow.length - 1].time, close: closedNow[closedNow.length - 1].close } : null;
  // Regime assist: a qualified trigger in the last BREAKOUT_PERSIST_BARS bars
  // (not since closed back through its level) reads as BREAKOUT/BREAKDOWN, so
  // the consensus side stops calling a crash a weak bull trend. Expiry-day
  // gamma keeps its priority.
  const momentumRegime: MarketRegime | null =
    momentumRead?.recent && fastRegime.regime !== 'EXPIRY_GAMMA' ? (momentumRead.recent.signal.direction === 'BULLISH' ? 'BREAKOUT' : 'BREAKDOWN') : null;
  const regime: MarketRegime = momentumRegime ?? fastRegime.regime;
  const regimeSource: RegimeSource = momentumRegime ? 'MOMENTUM_BREAK' : fastRegime.source;

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
  if (regime === 'OPERATOR_ACCUMULATION' || regime === 'OPERATOR_DISTRIBUTION') {
    reasoning.push(
      `Futures OI, the ${regime === 'OPERATOR_ACCUMULATION' ? 'call' : 'put'} wall under pressure, and PCR skew all agree ${regime === 'OPERATOR_ACCUMULATION' ? 'bullish' : 'bearish'} with a ${fmt(Math.abs(futuresChangeOiPct), 1)}% futures OI change — real positioning, not just price action, is driving this move.`
    );
  }
  if (momentumRead?.trigger) {
    const t = momentumRead.trigger;
    reasoning.push(
      `Momentum break (${t.direction.toLowerCase()}): the last closed 15m bar broke the ${t.levelKind.replace(/_/g, ' ').toLowerCase()} at ${fmt(t.levelPrice)} on ${fmt(t.volMult, 1)}x its usual volume and a ${fmt(t.rangeMult, 1)}x-ATR range — stop ${fmt(t.stop)}, target ${fmt(t.target)}.`
    );
  }
  if (regimeSource === 'MOMENTUM_BREAK' && momentumRead?.recent) {
    reasoning.push(
      `Regime held at ${regime} by a momentum break ${momentumRead.recent.barsAgo} bar(s) ago through the ${momentumRead.recent.signal.levelKind.replace(/_/g, ' ').toLowerCase()} at ${fmt(momentumRead.recent.signal.levelPrice)}.`
    );
  } else if ((regime === 'BREAKOUT' || regime === 'BREAKDOWN') && regimeSource === 'BREAKOUT_PERSIST' && breakoutPersist) {
    reasoning.push(
      `Volume-confirmed ${regime === 'BREAKOUT' ? 'break above the upper' : 'break below the lower'} Bollinger Band ${breakoutPersist.barsAgo} bar(s) ago, still holding ${regime === 'BREAKOUT' ? 'above' : 'below'} the midline — the ${regime.toLowerCase()} regime is held while it does.`
    );
  } else if (regime === 'BREAKOUT' || regime === 'BREAKDOWN') {
    reasoning.push(
      `Volume-confirmed ${regime === 'BREAKOUT' ? 'break above the upper' : 'break below the lower'} Bollinger Band (${fmt(volumeRatio, 2)}x volume) — a leading signal ADX hasn't caught up to yet.`
    );
  }
  if (regimeSource === '15M_FALLBACK' && adx15mValue != null) {
    reasoning.push(
      `1H ADX ${fmt(adxValue, 0)} reads no trend yet, but 15m ADX ${fmt(adx15mValue, 0)} with a ${st15DirectionConfirmed === 'UP' ? 'bullish' : 'bearish'} 15m Supertrend shows an intraday trend — regime read from the 15m chart.`
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
  } else if (marketStructure.lastEvent?.type === 'BOS') {
    reasoning.push(
      `Break of Structure — swing structure extended ${marketStructure.lastEvent.direction.toLowerCase()}, confirming the established trend`
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
      shortTermPattern.pattern === 'HORIZONTAL_CHANNEL'
        ? `Horizontal Channel forming on ${shortLabel} — range-bound (${shortTermPattern.confidence}% trendline tightness), no directional edge until it breaks, not counted in the vote`
        : `${formatPatternName(shortTermPattern.pattern)} forming on ${shortLabel} — ${shortTermPattern.direction.toLowerCase()} structure (${shortTermPattern.confidence}% confidence)`
    );
  }
  if (longTermPattern) {
    reasoning.push(
      longTermPattern.pattern === 'HORIZONTAL_CHANNEL'
        ? `Horizontal Channel forming on ${longLabel} — range-bound (${longTermPattern.confidence}% trendline tightness), no directional edge until it breaks, not counted in the vote`
        : `${formatPatternName(longTermPattern.pattern)} forming on ${longLabel} — ${longTermPattern.direction.toLowerCase()} structure (${longTermPattern.confidence}% confidence)`
    );
  }
  if (patternsAgree) {
    reasoning.push(
      `Multi-timeframe confluence — ${shortLabel} and ${longLabel} structure both point ${shortTermPattern!.direction.toLowerCase()}, counted double for the agreement`
    );
  }
  reasoning.push(
    !vwapDataAvailable
      ? `VWAP unavailable — this feed carries no volume for ${underlying}, so the VWAP vote is withheld rather than read off a stand-in`
      : vwapVote === 1
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
  reasoning.push(
    macdVote === 1
      ? `MACD histogram positive (${fmt(macdHistNow, 2)}) — bullish momentum`
      : macdVote === -1
      ? `MACD histogram negative (${fmt(macdHistNow, 2)}) — bearish momentum`
      : `MACD histogram flat (${fmt(macdHistNow, 2)}) — no clear momentum`
  );
  reasoning.push(
    bbBreakout && !volumeConfirms
      ? `Price outside the Bollinger Band (%B ${fmt(bbPercentB, 2)}) but volume (${fmt(volumeRatio, 2)}x) hasn't confirmed it — vote withheld`
      : bollingerVote === 1
      ? `Price in the upper Bollinger Band zone (%B ${fmt(bbPercentB, 2)}) — bullish`
      : bollingerVote === -1
      ? `Price in the lower Bollinger Band zone (%B ${fmt(bbPercentB, 2)}) — bearish`
      : `Price mid-Bollinger-Band (%B ${fmt(bbPercentB, 2)}) — neutral`
  );
  if (emaTrend) {
    reasoning.push(
      emaTrend.aligned && emaTrend.slopeOk
        ? `Price ${emaTrend.direction === 'BULLISH' ? '>' : '<'} EMA20 ${emaTrend.direction === 'BULLISH' ? '>' : '<'} EMA50 on ${longLabel}, sloping ${emaTrend.direction!.toLowerCase()} — strong trend structure`
        : emaTrend.aligned
        ? `EMA20/EMA50 stacked ${emaTrend.direction!.toLowerCase()} on ${longLabel} but flat — not sloping enough to trust yet`
        : `EMA20 (${fmt(emaTrend.ema20, 0)}) and EMA50 (${fmt(emaTrend.ema50, 0)}) tangled on ${longLabel} — no trend structure`
    );
  }
  // PCR / futures OI / option-flow all feed an actual vote in directionVotes
  // — placed ahead of the OI-wall/pivot lines below, which are informational
  // only (no vote) and already shown as their own Support/Resistance/pivot
  // fields elsewhere on this card. With the reasoning list capped at 9 lines
  // on the frontend, a real vote behind the confidence number must not lose
  // its slot to a level that's visible somewhere else on the same screen.
  // With the intraday window in use for an input, its line describes the
  // window read (what actually voted); otherwise the day-level line as before.
  const windowMin = COVERAGE_LAG_PARAMS.INTRADAY_POSITIONING_WINDOW_MIN;
  const pcrWindow = intradayPositioning?.pcr.vote != null ? intradayPositioning.pcr : null;
  const futuresWindow = intradayPositioning?.futures.vote != null ? intradayPositioning.futures : null;
  const flowWindow = intradayPositioning?.optionFlow.vote != null ? intradayPositioning.optionFlow : null;
  if (chain && pcrWindow && pcrWindow.pcrChange != null) {
    reasoning.push(
      `PCR at ${fmt(pcr)}, ${pcrWindow.pcrChange >= 0 ? '+' : ''}${fmt(pcrWindow.pcrChange, 2)} over the last ${windowMin} min — ${pcrVote === 1 ? 'put OI building (bullish)' : pcrVote === -1 ? 'call OI building (bearish)' : 'little change'}`
    );
  } else if (chain) {
    reasoning.push(
      `PCR at ${fmt(pcr)} — ${pcr > 1.1 ? 'moderately bullish' : pcr < 0.85 ? 'moderately bearish' : 'neutral'}`
    );
  }
  if (futuresWindow && futuresWindow.interpretation) {
    reasoning.push(
      `${getOIDescription(futuresWindow.interpretation).description} in futures OI over the last ${windowMin} min (price ${fmt(futuresWindow.priceChangePct ?? 0, 2)}%, OI ${fmt(futuresWindow.oiChangePct ?? 0, 2)}%)`
    );
  } else if (currentFuture) {
    reasoning.push(`${getOIDescription(futuresInterpretation).description} in futures OI`);
  }
  if (flowWindow && flowWindow.dominant && flowWindow.dominant !== 'NEUTRAL' && flowWindow.dominantShare != null) {
    reasoning.push(
      `${getOIDescription(flowWindow.dominant).description} dominates chain-wide option OI flow over the last ${windowMin} min (${Math.round(flowWindow.dominantShare * 100)}% of the window's net OI movement)`
    );
  } else if (!flowWindow && optionOiFlowDominant && optionOiFlowDominant !== 'NEUTRAL' && optionOiFlowTotalWeight > 0) {
    const dominantShare = Math.round((optionOiFlowDominantWeight / optionOiFlowTotalWeight) * 100);
    reasoning.push(
      `${getOIDescription(optionOiFlowDominant).description} dominates chain-wide option OI flow (${dominantShare}% of today's net OI movement)`
    );
  }
  if (putWall) reasoning.push(`Put OI concentration at ${fmt(putWall.strike, 0)} (support)`);
  if (callWall) reasoning.push(`Call OI build-up at ${fmt(callWall.strike, 0)} (resistance)`);
  if (pivots) {
    reasoning.push(
      spot > pivots.pp
        ? `Above prior-session pivot (${fmt(spot)} > PP ${fmt(pivots.pp)}) — R1 ${fmt(pivots.r1)}, S1 ${fmt(pivots.s1)}`
        : `Below prior-session pivot (${fmt(spot)} < PP ${fmt(pivots.pp)}) — R1 ${fmt(pivots.r1)}, S1 ${fmt(pivots.s1)}`
    );
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
  if (!st1hFlipConfirmed) {
    reasoning.push(
      `Supertrend ${longLabel} just flipped ${st1hDirection === 'UP' ? 'bullish' : 'bearish'} on the still-forming bar but volume (${fmt(longVolumeRatio, 2)}x) hasn't confirmed it — Regime and this vote still reading ${st1hPrevDirection === 'UP' ? 'bullish' : 'bearish'} until it does`
    );
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
      optionOiFlow: optionOiFlowDominant,
      optionOiFlowNetSkew: Math.round(optionOiFlowNetSkew * 100) / 100,
      ema20: emaTrend?.ema20 ?? null,
      ema50: emaTrend?.ema50 ?? null,
      emaAligned: emaTrend?.aligned && emaTrend.slopeOk ? emaTrend.direction : null,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      // Data-quality flags. Several inputs silently degrade to a neutral
      // stand-in when the feed doesn't carry them (VWAP falls back to spot,
      // volumeRatio to 1) — indices routinely hit BOTH at once, and a bias
      // computed without VWAP and without volume confirmation was still
      // reporting the same confidence as a fully-informed one, with nothing
      // downstream able to tell the difference. These say which inputs were
      // real so consumers can stop scoring off a fallback as if it were a
      // measurement.
      volumeDataAvailable,
      vwapDataAvailable,
      volumeSource,
      optionOiBaselineCoverage: Math.round(optionOiBaselineCoverage * 100) / 100,
      maxPain: chain?.maxPain ?? null,
      expectedMove: chain?.expectedMove.points ?? null,
      expectedRangeLow: chain?.expectedMove.lowerBound ?? null,
      expectedRangeHigh: chain?.expectedMove.upperBound ?? null,
      // OI-wall S/R (where positioning is concentrated) and price-pivot
      // S/R (where price itself has previously reacted) are two distinct
      // signals that can disagree — both surfaced rather than only one.
      // support/resistance/pivotSupport/pivotResistance stay as the
      // single strongest level each for any existing reader of this
      // field; supportLevels/resistanceLevels and the full pivot ladder
      // below are the same data, just not collapsed to one level —
      // intraday trading wants the full ladder, not just the top one.
      support: putWall?.strike ?? null,
      resistance: callWall?.strike ?? null,
      supportLevels,
      resistanceLevels,
      pivotSupport: pivots?.s1 ?? null,
      pivotResistance: pivots?.r1 ?? null,
      pivotPP: pivots?.pp ?? null,
      pivotS1: pivots?.s1 ?? null,
      pivotS2: pivots?.s2 ?? null,
      pivotS3: pivots?.s3 ?? null,
      pivotR1: pivots?.r1 ?? null,
      pivotR2: pivots?.r2 ?? null,
      pivotR3: pivots?.r3 ?? null,
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
      // Whether this poll fell in the opening/closing noise window and
      // had its volume-confirmation bar raised as a result (see
      // isNoisyIntradayWindow) — surfaced so it's auditable, not a
      // silent adjustment.
      noisyIntradayWindow: !isPositional && isNoisyIntradayWindow(exchange),
      votes: voteSnapshot,
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
  // Was aliasing pcrVote (already its own dedicated pcrScore below) instead
  // of reflecting actual options OI activity — now scores the real
  // buying-vs-writing / covering-vs-unwinding flow read.
  const optionsOiScore = contribution(optionOiFlowVote, directionSign);
  const pcrScore = clamp(Math.round(50 + (pcr - 1) * 40), 0, 100);
  // Scored against the underlying's OWN realized volatility, not an absolute
  // IV level. The old 100 - IV×2.5 scale was tuned to index options (~12-20%
  // IV) and read 0 for anything at 40%+, so CRUDEOIL — which normally trades
  // at 40-60% IV — scored 0 whether or not its premium was actually rich.
  // 50 = IV in line with HV; cheaper than realized scores higher (good for
  // an option buyer), richer scores lower. No resolvable IV or HV means no
  // relative read, so it scores neutral.
  const ivScore = atmIvPct > 0 && ivVsHv.spreadPct != null ? clamp(Math.round(50 - ivVsHv.spreadPct), 0, 100) : 50;

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
  const oiShiftMagnitude = Math.min(Math.abs(oiShiftChangeOiPct), 50) / 50; // 0..1
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

  // --- Trade-quality context: regime alignment and room to target ---
  // Neither changes the bias read itself; they decide whether that read is
  // a good OPTION-BUYING trade. The regime was computed and shown but never
  // used: across 87 live intraday trades, 38% ran against the 1H regime and
  // won 30% (avg -0.09R) vs 52% (+0.07R) with it, and range-bound regimes
  // averaged -0.22R. The factors below are a judgment call on that small
  // sample — every setup now records its context so they can be re-checked.
  const alignment = regimeAlignment(direction, regime);
  const setupConfidence = direction === 'NEUTRAL' ? confidence : Math.round(confidence * REGIME_CONFIDENCE_FACTOR[alignment]);
  const room = roomToTarget(direction, chain?.spotPrice ?? spot, callLevels, putLevels, pivots);

  // Phase 3 (spec §20) — how old was the OI-wall data roomToTarget() just
  // filtered candidates by? Diffs the same one-fetch chain timestamp
  // signal-freshness.ts already reads for every OI-derived input against
  // decision time. Measured only: roomToTarget's own OI_WALL_MIN_STRENGTH_PCT
  // filter and its result (`room`, above) are unchanged by this.
  const roomCheckOiAgeSeconds =
    chain?.timestamp != null && Number.isFinite(chain.timestamp)
      ? Math.max(0, Math.round((decisionNow() - chain.timestamp) / 1000))
      : null;

  // Location quality (shadow): where this entry sits among the levels that
  // matter, rather than only which way the read points. Recorded on every
  // setup and refusal so it can be validated on live trades before it is
  // allowed to gate anything — see location-quality.ts.
  const locationSpot = chain?.spotPrice ?? spot;
  const todayCandles = filterToday(candles15m);
  const structuralLevels: StructuralLevel[] = [
    ...callLevels.map((l): StructuralLevel => ({ price: l.strike, kind: 'OI_WALL', strengthPct: l.strengthPct })),
    ...putLevels.map((l): StructuralLevel => ({ price: l.strike, kind: 'OI_WALL', strengthPct: l.strengthPct })),
    ...(pivots ? ([
      { price: pivots.r1, kind: 'PIVOT' as const }, { price: pivots.r2, kind: 'PIVOT' as const }, { price: pivots.r3, kind: 'PIVOT' as const },
      { price: pivots.s1, kind: 'PIVOT' as const }, { price: pivots.s2, kind: 'PIVOT' as const }, { price: pivots.s3, kind: 'PIVOT' as const },
    ] as StructuralLevel[]) : []),
    ...(vwapDataAvailable && sessionVwap > 0 ? ([{ price: sessionVwap, kind: 'VWAP' as const }] as StructuralLevel[]) : []),
    ...(todayCandles.length > 0
      ? ([
          { price: Math.max(...todayCandles.map((c) => c.high)), kind: 'DAY_HIGH' as const },
          { price: Math.min(...todayCandles.map((c) => c.low)), kind: 'DAY_LOW' as const },
        ] as StructuralLevel[])
      : []),
    ...(previousSessionCandles.length > 0
      ? ([
          { price: Math.max(...previousSessionCandles.map((c) => c.high)), kind: 'PREV_DAY_HIGH' as const },
          { price: Math.min(...previousSessionCandles.map((c) => c.low)), kind: 'PREV_DAY_LOW' as const },
        ] as StructuralLevel[])
      : []),
  ].filter((l) => Number.isFinite(l.price) && l.price > 0);
  const location = assessLocation({ spot: locationSpot, direction, atrPoints: atrShortNow > 0 ? atrShortNow : null, levels: structuralLevels });

  // Name the setup the engine has ALREADY detected. Every argument below is a
  // reading computed earlier in this function and already voted on; nothing
  // here detects anything, and the result is written to the decision record
  // and read by no rule.
  const setupClassification = classifySetup({
    direction,
    shortPattern: shortTermPattern?.pattern ?? null,
    longPattern: longTermPattern?.pattern ?? null,
    vcpDetected: vcp != null,
    vcpBreakoutConfirmed,
    structureEvent: marketStructure.lastEvent
      ? { type: marketStructure.lastEvent.type, direction: marketStructure.lastEvent.direction }
      : null,
    liquiditySweep: liquiditySweep ? { type: liquiditySweep.type } : null,
    activeFvg: activeFvg ? { direction: activeFvg.gap.type } : null,
    activeOrderBlock: activeOrderBlock ? { type: activeOrderBlock.block.type } : null,
    supertrendFlipConfirmed: st15JustFlipped && volumeConfirms,
    bollingerBreakout: (bbPercentB > 1 || bbPercentB < 0) && volumeConfirms,
    emaTrendAligned: emaTrend?.aligned === true && emaTrend?.slopeOk === true,
    vwapReclaim: false,
    rsiDivergence:
      rsiDivergence && rsiDivergence.signal !== 'NONE' ? { direction: rsiDivergence.signal } : null,
  });

  // Strategy label (Phase 1): the same already-computed readings, named in
  // the loss-attribution taxonomy. Labelling only — read by no rule.
  const strategyLabels = classifyStrategyLabels({
    direction,
    setupTriggers: setupClassification.allTriggers,
    premiumDiscountZone: premiumDiscount.zone,
    candlePattern: candlePattern ? { pattern: candlePattern.pattern, direction: candlePattern.direction } : null,
    positioning: voteSnapshot.positioning,
  });

  const entryContext: SetupEntryContext = {
    regime,
    regimeAlignment: alignment,
    biasConfidence: confidence,
    setupConfidence,
    ivVsHv: ivVsHv.reading,
    ivVsHvSpreadPct: ivVsHv.spreadPct,
    atmIvPct: atmIvPct > 0 ? Math.round(atmIvPct * 100) / 100 : null,
    hvPct: hvPct != null ? Math.round(hvPct * 100) / 100 : null,
    vwapDeviationPct: vwapDataAvailable ? Math.round(vwapDeviationPct * 1000) / 1000 : null,
    todayChangePct: Math.round(todayChangePct * 100) / 100,
    minutesSinceOpen: minutesSinceSessionOpen(exchange),
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    volumeSource,
    roomToTargetPoints: room ? Math.round(room.points * 100) / 100 : null,
    atrPoints: atrShortNow > 0 ? Math.round(atrShortNow * 100) / 100 : null,
    locationScore: location.score,
    locationAheadAtr: location.aheadAtr != null ? Math.round(location.aheadAtr * 100) / 100 : null,
    locationBehindAtr: location.behindAtr != null ? Math.round(location.behindAtr * 100) / 100 : null,
    locationAheadKind: location.nearestAhead?.kind ?? null,
    locationReason: location.reasons[0] ?? null,
    // Validation review, fix 1: the level the structural stop is placed
    // beyond, and the spot the location was read at.
    locationBehindLevel: location.nearestBehind?.price ?? null,
    locationBehindKind: location.nearestBehind?.kind ?? null,
    locationSpot: locationSpot > 0 ? locationSpot : null,
    roomLevel: room ? Math.round(room.level * 100) / 100 : null,
    roomLevelSource: room?.source ?? null,
    optionOiBaselineCoverage: Math.round(optionOiBaselineCoverage * 100) / 100,
    setupClassification,
    // Phase 1 persistence: the numbers below were already computed above
    // and are recorded as-is. No gate reads them.
    strategyLabels,
    voteContributions: voteContributionsFrom(score),
    directionScore: voteSnapshot.chartNet,
    setupQualityScore: overall,
    // Phase 3 persistence — see the fields' own comments above.
    adxValue,
    atrZ: atrPctZ,
    freshBreakoutUp,
    freshBreakoutDown,
    roomCheckOiAgeSeconds,
    // Coverage/lag round: what each positioning input and the regime were
    // actually measured from, so decisions under different baselines are
    // never pooled blind.
    positioningBaseline,
    regimeSource,
    adx15m: adx15mValue != null ? Math.round(adx15mValue * 100) / 100 : null,
    breakoutPersistBarsAgo: breakoutPersist?.barsAgo ?? null,
  };

  const tradeSetup: TradeSetup = chain
    ? await resolveStickyTradeSetup(provider, underlying, exchange, chain, direction, setupConfidence, regime, overall, mode, voteSnapshot, entryContext, {
        trigger: momentumRead?.trigger ?? null,
        lastClosedBar,
      })
    : { available: false, reason: 'Option chain unavailable for this symbol — cannot size a setup.' };

  const result: MarketBiasResult = { bias, score, tradeSetup };
  biasComputedAt.set(`${exchange}:${underlying}:${mode}`, Date.now());

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
// to near midnight (09:00-23:30 during US DST, 09:00-23:55 otherwise) —
// same open/close-minutes math as NSE/BSE, just a much longer window. The
// close is read for the decision's own date so a replay uses that date's DST.
const MIN_REMAINING_SESSION_FRACTION = 0.05;

function remainingSessionFraction(exchange: Exchange): number {
  const hours = TRADING_HOURS[exchange];
  const at = decisionDate();
  const ist = new Date(at.toLocaleString('en-US', { timeZone: hours.timezone }));
  const [openH, openM] = hours.open.split(':').map(Number);
  const [closeH, closeM] = getSessionCloseTime(exchange, at).split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const nowMinutes = ist.getHours() * 60 + ist.getMinutes();
  const totalSessionMinutes = closeMinutes - openMinutes;
  const remainingMinutes = closeMinutes - nowMinutes;
  return Math.max(MIN_REMAINING_SESSION_FRACTION, Math.min(1, remainingMinutes / totalSessionMinutes));
}

// The opening auction settling and end-of-day unwinding/rollover flows
// make price action structurally noisier in these two windows than at
// the identical reading mid-session — a fresh Supertrend flip or
// Bollinger breakout at 9:20am shouldn't carry the same weight as one at
// 11:30am. Raising the volume-confirmation bar during these windows
// (rather than suppressing votes outright) means a genuinely strong move
// still gets through, just needs more conviction than mid-session —
// every fresh-signal check already gated on volumeConfirms (Supertrend
// flip, Bollinger breakout) tightens together from this one change
// point, no need to touch each vote individually.
const OPENING_WINDOW_MINUTES = 30;
const CLOSING_WINDOW_MINUTES = 15;
const NOISY_WINDOW_VOLUME_MULTIPLIER = 1.5;

function isNoisyIntradayWindow(exchange: Exchange): boolean {
  const hours = TRADING_HOURS[exchange];
  const at = decisionDate();
  const ist = new Date(at.toLocaleString('en-US', { timeZone: hours.timezone }));
  const [openH, openM] = hours.open.split(':').map(Number);
  const [closeH, closeM] = getSessionCloseTime(exchange, at).split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const nowMinutes = ist.getHours() * 60 + ist.getMinutes();
  // The closing-side check on its own has no upper bound — caught live:
  // it read "noisy" for the entire stretch from 15:15 onward, including
  // hours after the market had actually closed, not just the intended
  // last-15-minutes-of-real-trading window. Gate on the session actually
  // being open first.
  if (nowMinutes < openMinutes || nowMinutes > closeMinutes) return false;
  return nowMinutes < openMinutes + OPENING_WINDOW_MINUTES || nowMinutes > closeMinutes - CLOSING_WINDOW_MINUTES;
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
/**
 * NIFTY's direction when it disagrees with this setup's, else null.
 *
 * Was a hard refusal inside checkReliabilityFilters, which had a
 * consequence nobody had noticed: it made the Market Scanner's
 * Stock-Specific Movers section — built specifically to catch stocks
 * running on their own story against the tape — incapable of EVER
 * producing a result on a trending day, because every counter-index setup
 * was killed upstream before that section saw it. Confirmed live: GVT&D
 * +8.77% and BANDHANBNK +4.18% (both BULLISH at 71%/95% confidence) were
 * refused solely because NIFTY was bearish.
 *
 * Reported rather than enforced now, so the caller decides: the
 * market-aligned candidate list still rejects these, the stock-specific
 * pass accepts them, and the setup is marked so no UI can present a
 * counter-index trade as though the index agreed with it.
 */
async function checkCounterToIndex(
  underlying: string,
  exchange: Exchange,
  direction: BiasDirection,
  mode: TradingMode
): Promise<BiasDirection | null> {
  // Only meaningful for an individual stock against the index; an index
  // can't fight itself, and MCX/BSE commodities have no real equity-index
  // relationship to check against.
  const isNseStock = exchange === 'NSE' && !(INDEX_SYMBOLS as readonly string[]).includes(underlying);
  if (!isNseStock || direction === 'NEUTRAL') return null;

  // The index's own technical direction right now.
  const niftyDirection = await lookupCachedBiasDirection('NSE', 'NIFTY', mode);
  if (niftyDirection != null && niftyDirection !== 'NEUTRAL' && niftyDirection !== direction) {
    return niftyDirection;
  }

  // Institutional Flow's next-day read for the index — a different source
  // (FII/DII positioning rather than price structure) for the same
  // question, so it belongs on the same footing rather than as a second
  // hard block behind this one.
  const predicted = await lookupInstitutionalDirection('NIFTY');
  if (predicted != null && predicted !== 'NEUTRAL' && predicted !== direction) {
    return predicted;
  }
  return null;
}

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
      const today = decisionIstDate();
      const tomorrow = new Date(decisionNow() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const upcoming = actions.find((a) => a.exDate === today || a.exDate === tomorrow);
      if (upcoming) {
        return `${upcoming.type} ex-date ${upcoming.exDate === today ? 'today' : 'tomorrow'} (${upcoming.purpose}) — the price move around this is the corporate action, not a technical signal.`;
      }
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Corporate-action reliability check failed — proceeding ungated');
    }
  }

  if (direction === 'NEUTRAL') return null; // nothing left to disagree with

  // NOTE: broader-market (NIFTY) alignment used to be a hard block here.
  // It's now reported separately via `checkCounterToIndex` and surfaced as
  // TradeSetup.counterIndex rather than refusing outright — see that
  // function for why. It stays a block for the market-aligned candidate
  // list, but the Market Scanner's Stock-Specific Movers pass exists
  // precisely to catch stocks moving on their own story, and this gate made
  // that section structurally incapable of ever producing a result.

  // NOTE: Institutional Flow's next-day index read was ALSO a hard block
  // here, and relaxing only the NIFTY-direction check above achieved
  // nothing — the counter-index movers it was meant to release
  // (GVT&D +8.77%, BANDHANBNK +4.18%) simply fell through to this one and
  // were refused all the same, leaving Stock-Specific Movers at zero.
  //
  // It's the same class of test — "the broad index disagrees with this
  // stock" — just sourced from FII/DII positioning rather than price
  // structure, and it's a NEXT-DAY read being applied to an intraday
  // setup. Both now travel together through checkCounterToIndex.

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

/** Every vote behind a bias read (-1/0/+1, event votes can be ±2 via repeats in `structure`). */
interface BiasVoteSnapshot {
  price: Record<'vwap' | 'rsi' | 'supertrendShort' | 'supertrendLong' | 'macd' | 'bollinger' | 'emaTrend' | 'rsiDivergence' | 'vcpBreakout', number>;
  structure: number[];
  positioning: { futuresOi: number; pcr: number; optionOiFlow: number };
  /** Net of price + structure — the single capped "candles" source. */
  chartNet: number;
  /** Net of futures OI + PCR + option OI flow — the positioning source. */
  positioningNet: number;
}

interface StoredTradeSetup extends TradeSetup {
  direction: BiasDirection;
  voteSnapshot?: BiasVoteSnapshot; // the votes that minted this setup — persisted with its Backtesting row
  entryContext?: SetupEntryContext; // regime/IV/VWAP/room context at entry — persisted with its Backtesting row
  day: string; // YYYY-MM-DD, IST
  signalId?: string; // links to the persisted `signals` row for backtesting (see backtesting.ts)
  reversalStreak?: number; // confident opposite reads since the streak started — see REVERSAL_CONFIRM_POLLS
  reversalSince?: number; // when the first of those reads landed (epoch ms) — see REVERSAL_CONFIRM_SECONDS
  initialStopLoss?: number; // the SL at generation time, fixed — `stopLoss` itself trails upward as price moves favorably, this is what "1x/2x initial risk" is measured against
  generatedAt?: number; // epoch ms, for elapsed-time reads
  excursion?: TradeExcursion; // best/worst seen since entry — see trade-health.ts
  health?: { state: string; score: number; wouldExit: boolean; reason: string; at: number }; // shadow only, never closes a position
  // --- Phase 1 instrumentation (recorded, never read by a gate) ---
  decisionId?: string; // the TAKE decision_snapshots row that minted this setup — later stale/dead/outcome flags link to it
  underlyingAtGeneration?: number; // spot when minted — what re-surface staleness is measured against
  signalFreshness?: SurfacedFreshness; // attached to the RETURNED object on a re-surface only, never persisted
  logic?: LogicStamp; // validation review: logicVersion + flags this setup was minted under (absent before stamping)
  momentumBreak?: StoredMomentumBreak; // momentum-break family only: the trigger it was minted on (LEVEL_RECLAIMED reads it)
}

/** Staleness of a re-surfaced sticky setup, as shown on the response. Measured only — see signal-freshness.ts. */
interface SurfacedFreshness {
  stale: boolean;
  evaluated: boolean;
  moveAtr: number | null;
  thresholdAtr: number;
  ageSeconds: number | null;
  enforced: false;
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

// --- Fresh-data and re-entry gates ---
// Two failure modes found reviewing the Backtesting table against live
// trading, both of which locked in setups nobody could actually have taken:
//
// 1. Off-hours generation. Nothing stopped a new setup being built while
//    the exchange was shut — the institutional scanner polls every 15
//    minutes around the clock, so just after midnight it rolled the prior
//    day's setup over and immediately minted a new one from the frozen
//    closing quotes (NIFTY CE 23,400 @ 134.32 on three consecutive nights,
//    two of them a weekend). A 09:03 BANKNIFTY setup priced off pre-open
//    quotes then "won" +77% on the 09:15 gap. SETUP_OPENING_SETTLE_MINUTES
//    also skips the first ticks after the bell, while quotes are still
//    catching up from the pre-open auction.
//
// 2. Immediate re-entry after a losing close. An SL hit falls straight
//    through to fresh generation, and the bias that produced the losing
//    trade usually still reads the same way — so the next poll bought the
//    same side again (three NIFTY PE stop-outs in one morning as the index
//    climbed). Every stop-loss LOSS starts a same-direction cooldown, and
//    MAX_SAME_DIRECTION_LOSSES_PER_DAY stops that direction for the day.
//    The opposite direction is never blocked.
//
//    Deliberately NOT applied to a bias-reversal exit, even one below
//    entry. That was tried (16 Sep) and checked against history: of 4
//    same-direction re-entries within an hour of a losing reversal exit, 2
//    were winners (+1.15R, +2.52R target hit) — blocking them would have
//    cost +3.26R to save -0.41R. A reversal exit means the read flickered;
//    a stop-loss means price actually moved against the trade. The two
//    measurable same-direction re-entries right after a stop-loss lost
//    -1.01R and -1.46R.
//
// Holidays (including MCX's half-day closures) come from EXCHANGE_HOLIDAYS
// in @fno/shared, which needs each new year's list added.
// Evidence from the 93 closed setups recorded to 17 Sep (R is net of costs):
//
//   Intraday entries in the session's first 60 minutes: 20 trades, -7.5R.
//   Skipping them alone moves the book from -4.9R to +2.6R. The first trade
//   of a day averaged -0.62R and the second -0.64R, against +0.25R for the
//   fourth onward — the deficit is entirely in the day's opening attempts,
//   whenever they fire.
//
//   Confidence below 75: 34 trades, -6.6R, and 85% of the 60-74 band expired
//   without reaching either level. Above 75 the score stops discriminating
//   (75-89 +0.06R, 90-100 -0.01R), so 75 is a floor, not a ranking.
//
//   Together: 54 trades, +7.7R, profit factor 1.40, max drawdown 6.8R against
//   14.4R. Fewer trades, and the losing streak drops from 9 to 5.
const SETUP_OPENING_GUARD_MINUTES = 60;
const MIN_SETUP_CONFIDENCE = 75;

// After a stop-loss (see the cooldown block below for the measured numbers):
//   any new setup waits POST_LOSS_SETTLE_MINUTES, whatever the symbol;
//   the same symbol+direction waits SL_COOLDOWN_SECONDS;
//   and anything else that day needs POST_LOSS_MIN_CONFIDENCE.
const POST_LOSS_SETTLE_MINUTES = 15;
const POST_LOSS_MIN_CONFIDENCE = 80;

const SL_COOLDOWN_SECONDS = 60 * 60;
const SL_COOLDOWN_SECONDS_POSITIONAL = 60 * 60 * 24; // a positional thesis that just stopped out isn't re-evaluated within the hour
const MAX_SAME_DIRECTION_LOSSES_PER_DAY = 2;

interface GateRefusal {
  code: NoTradeCode;
  reason: string;
}

function sessionGateReason(exchange: Exchange, mode: TradingMode): GateRefusal | null {
  const sinceOpen = minutesSinceSessionOpen(exchange);
  if (sinceOpen == null) {
    const holiday = getExchangeHoliday(exchange);
    const closedFor = holiday ? ` for ${holiday.name}${holiday.closed === 'FULL' ? '' : ` (${holiday.closed.toLowerCase()} session)`}` : '';
    return { code: 'MARKET_CLOSED', reason: `${exchange} is closed${closedFor} — new trade setups are only built from live session quotes, not the frozen last prints.` };
  }
  if (sinceOpen < SETUP_OPENING_SETTLE_MINUTES) {
    return { code: 'OPENING_HOUR', reason: `Waiting out the first ${SETUP_OPENING_SETTLE_MINUTES} minutes after the session opens — quotes are still settling from the pre-open auction.` };
  }
  // The opening hour is where the losses are. Positional entries are day-scale
  // reads and aren't judged on where the first hour's noise put the price, so
  // the guard is intraday only.
  if (mode === 'INTRADAY' && sinceOpen < SETUP_OPENING_GUARD_MINUTES) {
    return {
      code: 'OPENING_HOUR',
      reason:
        `Market structure is still forming — ${Math.round(sinceOpen)} minutes into the session, and intraday setups wait for ${SETUP_OPENING_GUARD_MINUTES}. ` +
        `Across the recorded history the first hour's entries lost 7.5R over 20 trades while everything after it made money.`,
    };
  }
  // Validation review, fix 5 (flag CLOSING_GUARD): the explicit backstop at
  // the other end of the session. Intraday only; existing setups untouched.
  // With the flag off this returns null, exactly as before.
  const closing = closingGuardReason({
    enabled: TRADING_FLAGS.CLOSING_GUARD,
    mode,
    exchange,
    minutesToClose: minutesToSessionClose(exchange, decisionNow()),
    guardMinutes: TRADING_PARAMS.SETUP_CLOSING_GUARD_MINUTES,
  });
  if (closing) return closing;
  return null;
}

// Positioning veto: never mint a setup when futures OI, PCR AND option OI
// flow all point the other way. With the candles capped as one source this
// combination already nets to NEUTRAL (+3 vs -3) and can't produce a
// direction — it's kept as an explicit guard so a future re-weighting can't
// quietly reopen the CRUDEOIL case, and so the refusal reads plainly.
function positioningConflictReason(direction: BiasDirection, votes: BiasVoteSnapshot | undefined): GateRefusal | null {
  if (!votes || direction === 'NEUTRAL') return null;
  const against = direction === 'BULLISH' ? -1 : 1;
  const { futuresOi, pcr, optionOiFlow } = votes.positioning;
  if (futuresOi === against && pcr === against && optionOiFlow === against) {
    return { code: 'POSITIONING_CONFLICT', reason: `Futures OI, PCR and option OI flow all read ${direction === 'BULLISH' ? 'bearish' : 'bullish'} — not taking a ${direction} setup against every positioning signal.` };
  }
  return null;
}

/** Any stop-loss on this exchange+mode blocks every new setup for a few minutes. */
function postLossSettleKey(exchange: Exchange, mode: TradingMode): string {
  return `trade_setup_post_loss_settle:${exchange}:${mode}`;
}

/** Set for the rest of the IST day once something stopped out — raises the bar for what follows. */
function postLossDayKey(exchange: Exchange, mode: TradingMode, day: string): string {
  return `trade_setup_post_loss_day:${exchange}:${mode}:${day}`;
}

function slCooldownKey(exchange: Exchange, underlying: string, mode: TradingMode, direction: BiasDirection): string {
  return `trade_setup_sl_cooldown:${exchange}:${underlying}:${mode}:${direction}`;
}

function slLossCountKey(exchange: Exchange, underlying: string, mode: TradingMode, direction: BiasDirection, day: string): string {
  return `trade_setup_sl_losses:${exchange}:${underlying}:${mode}:${direction}:${day}`;
}

/**
 * Starts the same-direction cooldown and counts toward the daily cap. The
 * count is claimed once per setup (`setupId`) — the price-level monitor and
 * an on-demand poll can both record the same close, and counting it twice
 * would end that direction for the day after a single loss.
 */
async function registerLosingClose(exchange: Exchange, underlying: string, mode: TradingMode, direction: BiasDirection, setupId: string): Promise<void> {
  const day = decisionIstDate();
  const countKey = slLossCountKey(exchange, underlying, mode, direction, day);
  try {
    await redis.set(slCooldownKey(exchange, underlying, mode, direction), '1', 'EX', mode === 'POSITIONAL' ? SL_COOLDOWN_SECONDS_POSITIONAL : SL_COOLDOWN_SECONDS);
    // Short settle across every symbol on this exchange+mode, then a raised
    // bar for the rest of the day.
    await redis.set(postLossSettleKey(exchange, mode), '1', 'EX', POST_LOSS_SETTLE_MINUTES * 60);
    const istDay = decisionIstDate();
    await redis.set(postLossDayKey(exchange, mode, istDay), '1', 'EX', 24 * 60 * 60);
    const firstCount = await redis.set(`trade_setup_loss_counted:${setupId}`, '1', 'EX', 60 * 60 * 48, 'NX');
    if (firstCount === 'OK') {
      await redis.incr(countKey);
      await redis.expire(countKey, 60 * 60 * 24);
    }
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Losing-close cooldown write failed');
  }
}

/**
 * What follows a stop-loss, measured rather than assumed. Of the 39 setups
 * that followed a same-day loss:
 *
 *   within 15 minutes        12 trades, -0.28R, profit factor 0.45
 *   15-60 minutes later       7 trades, +0.82R, profit factor 8.03
 *   60+ minutes later        20 trades, +0.41R
 *   same symbol AND side
 *     within the hour         5 trades, -0.48R
 *   a different symbol/side
 *     within the hour        14 trades, +0.34R, profit factor 2.40
 *
 * So a flat hour of silence was wrong in both directions: it blocked the
 * best-performing group in the whole dataset (a different setup, 15-60
 * minutes after a loss) while leaving the genuinely bad one (any re-entry
 * inside 15 minutes) open. The gate is now conditional: a short settle for
 * everything, the full hour only for the setup that just failed, and a
 * higher confidence bar for the rest of the day.
 */
// Exported for the momentum-break pipeline test (the post-loss floor on a trigger's quality).
export async function losingCloseCooldownReason(underlying: string, exchange: Exchange, direction: BiasDirection, mode: TradingMode, confidence: number): Promise<GateRefusal | null> {
  if (direction === 'NEUTRAL') return null;
  const day = decisionIstDate();
  try {
    const settleTtl = await redis.ttl(postLossSettleKey(exchange, mode));
    if (settleTtl > 0) {
      return { code: 'POST_LOSS_COOLDOWN', reason: (
        `A setup stopped out ${POST_LOSS_SETTLE_MINUTES - Math.ceil(settleTtl / 60)} minutes ago — new entries wait ${POST_LOSS_SETTLE_MINUTES} minutes for the move that caused it to finish. ` +
        `Re-entries inside that window lost 0.28R a trade across 12 recorded trades; the same setups taken 15-60 minutes later made 0.82R.`
      ) };
    }
    const lostToday = await redis.get(postLossDayKey(exchange, mode, day));
    if (lostToday && confidence < POST_LOSS_MIN_CONFIDENCE) {
      return { code: 'POST_LOSS_COOLDOWN', reason: (
        `Something already stopped out on ${exchange} today, so the bar for the next setup is confidence ${POST_LOSS_MIN_CONFIDENCE} — this reads ${confidence}. ` +
        `A fresh, clearly stronger setup is allowed immediately; a marginal one is not.`
      ) };
    }
    const [cooldownTtl, losses] = await Promise.all([
      redis.ttl(slCooldownKey(exchange, underlying, mode, direction)),
      redis.get(slLossCountKey(exchange, underlying, mode, direction, day)),
    ]);
    const lossCount = Number(losses ?? 0);
    if (lossCount >= MAX_SAME_DIRECTION_LOSSES_PER_DAY) {
      return { code: 'DIRECTION_LOCKED', reason: `${underlying} has already stopped out ${lossCount} ${direction} setups today — no more ${direction} entries until tomorrow.` };
    }
    if (cooldownTtl > 0) {
      return { code: 'SAME_SYMBOL_SIDE', reason: `${underlying}'s last ${direction} setup hit its stop-loss — no same-direction re-entry for another ${Math.ceil(cooldownTtl / 60)} min (that repeat lost 0.48R a trade in the recorded history).` };
    }
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Losing-close cooldown read failed — proceeding ungated');
  }
  return null;
}

// --- Phase 1: gate diagnostics and signal staleness (observation only) ---

/**
 * The same four readings losingCloseCooldownReason() consults, returned raw
 * so the gate-diagnostics layer can evaluate each of its three codes on its
 * own. READ-ONLY: it reads the same keys and writes nothing. Null when the
 * reads fail — the diagnostic then says NOT_EVALUATED instead of guessing.
 */
async function readLosingCloseState(underlying: string, exchange: Exchange, direction: BiasDirection, mode: TradingMode): Promise<LosingCloseState | null> {
  if (direction === 'NEUTRAL') return null;
  const day = decisionIstDate();
  try {
    const [settleTtl, lostToday, cooldownTtl, losses] = await Promise.all([
      redis.ttl(postLossSettleKey(exchange, mode)),
      redis.get(postLossDayKey(exchange, mode, day)),
      redis.ttl(slCooldownKey(exchange, underlying, mode, direction)),
      redis.get(slLossCountKey(exchange, underlying, mode, direction, day)),
    ]);
    return {
      settleTtlSeconds: settleTtl,
      lostToday: !!lostToday,
      sameDirectionLossCount: Number(losses ?? 0),
      sameSideCooldownTtlSeconds: cooldownTtl,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 3 (spec §16) — minutes since the most recent stop-loss, recovered
 * from the exact same Redis TTLs losingCloseCooldownReason() above already
 * reads for the gate check. No new key, no new read pattern: a TTL only
 * proves elapsed time while it's still alive, so this is honest about what
 * it cannot recover rather than guessing:
 *
 *   0-15 min   any symbol on this exchange+mode — from postLossSettleKey's
 *              own POST_LOSS_SETTLE_MINUTES TTL.
 *   15-60 min  THIS symbol+direction's own last loss only (INTRADAY;
 *              POSITIONAL's cooldown key lives 24h, not a usable "minutes"
 *              read against a 60-minute frame) — from slCooldownKey's own
 *              SL_COOLDOWN_SECONDS TTL.
 *   null       neither TTL is alive: no recent loss, or a loss more than an
 *              hour old, or a loss on a DIFFERENT symbol/direction between
 *              those two windows. postLossDayKey confirms a loss happened
 *              today in that gap but not when, so this returns null rather
 *              than invent a number — recorded as "not recoverable", a
 *              different fact from "no loss".
 *
 * Reporting only: this never feeds back into the cooldown gate itself.
 */
async function readMinutesSinceLastLoss(underlying: string, exchange: Exchange, mode: TradingMode, direction: BiasDirection): Promise<number | null> {
  if (direction === 'NEUTRAL') return null;
  try {
    const [settleTtl, cooldownTtl] = await Promise.all([
      redis.ttl(postLossSettleKey(exchange, mode)),
      redis.ttl(slCooldownKey(exchange, underlying, mode, direction)),
    ]);
    return minutesSinceLastLossFromTtls(settleTtl, cooldownTtl, mode, POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Minutes-since-last-loss read failed');
    return null;
  }
}

/**
 * Measures whether a sticky setup being handed back on a later poll has gone
 * stale against the live underlying. Returns what to show on the response.
 *
 * MEASUREMENT ONLY. The setup is not invalidated, not re-priced and not
 * re-written to Redis; the first stale sighting is recorded against the TAKE
 * decision that minted it (a stale flag plus a SIGNAL_STALE gate-diagnostic
 * row), fire-and-forget.
 */
function observeStickyStaleness(stored: StoredTradeSetup, storedChain: OptionChain | null, underlying: string): SurfacedFreshness {
  const underlyingAtGeneration = stored.underlyingAtGeneration ?? stored.excursion?.underlyingEntry ?? null;
  const atrPoints = stored.entryContext?.atrPoints ?? stored.excursion?.atrAtEntry ?? null;
  const currentUnderlying = storedChain?.spotPrice ?? null;
  const assessment = assessStaleness({
    underlyingAtGeneration,
    currentUnderlying,
    atrPoints,
    generatedAt: stored.generatedAt ?? null,
    now: decisionNow(),
  });
  if (assessment.stale && stored.decisionId) {
    void flagStaleOnce(stored.decisionId, assessment, { underlyingAtGeneration, currentUnderlying, atrPoints }, underlying);
  }
  return {
    stale: assessment.stale,
    evaluated: assessment.evaluated,
    moveAtr: assessment.moveAtr,
    thresholdAtr: assessment.thresholdAtr,
    ageSeconds: assessment.ageSeconds,
    enforced: false,
  };
}

async function flagStaleOnce(
  decisionId: string,
  assessment: StalenessAssessment,
  context: { underlyingAtGeneration: number | null; currentUnderlying: number | null; atrPoints: number | null },
  underlying: string
): Promise<void> {
  try {
    // One record per setup: the first stale sighting, not one per poll.
    const first = await redis.set(`signal_stale_flagged:${decisionId}`, '1', 'EX', 60 * 60 * 24 * 3, 'NX');
    if (first !== 'OK') return;
    logger.info(
      { shadow: 'SIGNAL_STALE', underlying, decisionId, moveAtr: assessment.moveAtr, thresholdAtr: assessment.thresholdAtr },
      'Signal staleness: a re-surfaced sticky setup has gone stale (measured only — not invalidated)'
    );
    await markDecisionStale(decisionId, assessment);
    await recordGateDiagnostics(decisionId, [staleSignalDiagnostic(assessment, context, decisionNow())]);
  } catch (err: any) {
    logger.warn({ error: err.message, decisionId }, 'Signal staleness: record failed');
  }
}

/** A re-surfaced sticky setup, with its measured staleness attached to the response only. */
function surfaceSticky(setup: StoredTradeSetup, currentValue: number | null, isSpread: boolean, storedChain: OptionChain | null, underlying: string): TradeSetup {
  let signalFreshness: SurfacedFreshness | undefined;
  try {
    signalFreshness = observeStickyStaleness(setup, storedChain, underlying);
  } catch {
    signalFreshness = undefined; // instrumentation must never break a re-surface
  }
  return withLiveMark(signalFreshness ? { ...setup, signalFreshness } : setup, currentValue, isSpread);
}

// A target is a resting limit order — it fills AT the target, not at
// whatever higher print the next poll happened to see after a gap through
// it (BANKNIFTY's +77% "win" against a +37% target). A stop is the
// opposite: a stop-market order fills wherever the market is, so a gap
// through it is a genuine, worse fill and keeps the observed price.
function exitValueForPriceHit(stored: StoredTradeSetup, isSpread: boolean, hitTarget: boolean, currentValue: number | null): number | null {
  if (!hitTarget || isSpread || currentValue == null || stored.target == null) return currentValue;
  return Math.min(currentValue, stored.target);
}

async function resolveStickyTradeSetup(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  chain: OptionChain,
  direction: BiasDirection,
  confidence: number,
  regime: MarketRegime,
  intelligenceScore: number,
  mode: TradingMode = 'INTRADAY',
  voteSnapshot?: BiasVoteSnapshot,
  entryContext?: SetupEntryContext,
  momentum?: { trigger: MomentumBreakSignal | null; lastClosedBar: { time: number; close: number } | null }
): Promise<TradeSetup> {
  const isPositional = mode === 'POSITIONAL';
  const setupTtl = isPositional ? STICKY_TRADE_SETUP_TTL_SECONDS_POSITIONAL : STICKY_TRADE_SETUP_TTL_SECONDS;
  // Mode-scoped key — INTRADAY and POSITIONAL setups for the same symbol
  // are entirely different positions (different SL%, different expected
  // holding period), not variations of one setup, so they can't share a
  // Redis slot.
  const key = `trade_setup:${exchange}:${underlying}:${mode}`;
  const today = decisionIstDate();

  let stored: StoredTradeSetup | null = null;
  try {
    const raw = await redis.get(key);
    if (raw) stored = JSON.parse(raw) as StoredTradeSetup;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Sticky trade setup read failed — generating fresh');
  }
  // The setup this caller found in the slot, if any. The mint lock below uses
  // it to tell "someone else minted while I was computing" from "this is the
  // setup I have just closed and am replacing".
  const priorDecisionId = stored?.decisionId ?? null;

  // Only an actual locked-in setup (available: true) is sticky — an
  // "unavailable" verdict (neutral bias, low confidence) isn't a position
  // to protect from re-evaluation, so it re-checks current conditions
  // every poll like any other live read rather than getting stuck once
  // confidence happens to dip for one cycle.
  // A setup generated before a data-quality fix (e.g. a diverging or
  // oscillating IV solver inflating the target) can otherwise stay locked
  // in all day — its target is unreachable so hitSL/hitTarget below never
  // fires — silently serving a broken number for the rest of the session.
  // Re-applying the same R:R band buildTradeSetup itself enforces on every
  // read closes that gap without needing a manual cache clear — this is what
  // lets a fix land and immediately self-heal any setup already sitting in
  // Redis, not just new ones generated after. Now bounded on BOTH sides:
  // the floor retires setups minted before the minimum-R:R fix, which were
  // risking more than they could win (see MIN_RISK_REWARD's own comment).
  // The R:R cap only makes sense for a naked long, whose target comes from
  // a delta×expected-move projection that can run away on bad upstream
  // data — a spread's max profit/loss are geometrically bounded by real
  // strike widths and real current premiums, so it's sanity-checked by
  // requiring positive maxProfit/maxLoss instead.
  const storedIsPlausible =
    stored?.available &&
    (stored.structureType === 'SPREAD'
      ? stored.maxProfit != null && stored.maxProfit > 0 && stored.maxLoss != null && stored.maxLoss > 0
      : stored.riskReward != null && stored.riskReward <= MAX_RISK_REWARD && stored.riskReward >= MIN_RISK_REWARD);

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
    const backfilledId = await recordTradeSetupGenerated(
      underlying,
      exchange,
      stored,
      stored.direction,
      confidence,
      regime,
      intelligenceScore,
      mode,
      stored.voteSnapshot,
      stored.entryContext,
      // The rules the setup was MINTED under, not the ones running now; null
      // for a setup minted before stamping existed.
      stored.logic ?? null
    );
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
  // Price the locked setup off its OWN contract, not whichever expiry this
  // poll's chain happens to be — see chainForStoredSetup.
  const storedChain = stored?.available ? await chainForStoredSetup(provider, underlying, exchange, chain, stored) : chain;

  // Momentum break: a trigger bar acts once — the first caller to claim it
  // may reverse the slot and mint; every other caller (and every later poll
  // inside the same 15 minutes) reads the slot as usual.
  const trigger = momentum?.trigger ? await claimMomentumTrigger(exchange, underlying, mode, momentum.trigger) : null;

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
      const legPrices = stored!.legs.map((l) => ({ action: l.action, price: legLtpOrNull(storedChain, l.strike, l.side) }));
      const progress = evaluateSpreadProgress(legPrices, stored!.netPremium!, stored!.maxProfit!, stored!.maxLoss!);
      currentValue = progress.currentValue;
      hitSL = progress.hitStop;
      hitTarget = progress.hitTarget;
    } else {
      // SL/target are about the option's own price, not the current bias
      // read — check them first and unconditionally, so a real win/loss is
      // never masked by a same-tick direction flicker.
      const currentLtp = legLtpOrNull(storedChain, stored!.strike!, stored!.side!);
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

    // Momentum break (checked after the premium stop/target, before any
    // consensus exit): a trigger trade is exempt from BIAS_REVERSED and holds
    // until stop, target, session end or LEVEL_RECLAIMED; a fresh trigger the
    // other way closes whatever the slot holds (TRIGGER_REVERSAL). A
    // consensus setup with no opposing trigger gets the logic below, as before.
    const slotAction: SlotAction =
      hitSL || hitTarget ? { kind: 'CONSENSUS_FLOW' } : triggerSlotAction({ stored: stored!, trigger, lastClosedBar: momentum?.lastClosedBar ?? null });

    if (hitSL || hitTarget) {
      const outcome = classifyPriceHitOutcome(stored!, isSpread, hitTarget);
      await recordTradeSetupOutcome(stored!, outcome, exitValueForPriceHit(stored!, isSpread, hitTarget, currentValue), {
        underlying,
        exchange,
        mode,
        reason: closeReasonForPriceHit(stored!, isSpread, hitTarget),
      });
      // falls through to fresh generation below (subject to the losing-close cooldown)
    } else if (slotAction.kind === 'HOLD_TRIGGER') {
      return surfaceSticky(stored!, currentValue, isSpread, storedChain, underlying);
    } else if (slotAction.kind === 'CLOSE') {
      logger.info({ underlying, exchange, mode, reason: slotAction.reason, held: stored!.strategy ?? 'CONSENSUS', heldDirection: stored!.direction }, 'Momentum break: closing the held setup');
      await recordTradeSetupOutcome(stored!, 'EXPIRED', currentValue, { underlying, exchange, mode, reason: slotAction.reason });
      // falls through to fresh generation below
    } else if (stored!.direction === direction) {
      // Bias still agrees with the locked setup — fully sticky. Clear any
      // reversal streak that had started building from an earlier blip,
      // since the reversal didn't hold.
      if (!stored!.reversalStreak) return surfaceSticky(stored!, currentValue, isSpread, storedChain, underlying);
      const reset: StoredTradeSetup = { ...stored!, reversalStreak: 0, reversalSince: undefined };
      try {
        await redis.set(key, JSON.stringify(reset), 'EX', setupTtl);
      } catch (err: any) {
        logger.warn({ error: err.message, underlying }, 'Sticky trade setup reversal-streak reset failed');
      }
      return surfaceSticky(reset, currentValue, isSpread, storedChain, underlying);
    } else if (direction === 'NEUTRAL' || confidence < MIN_CONFIDENCE) {
      // Mixed or low-confidence read — not a reversal. Hold the position and
      // leave any streak as it is (see REVERSAL_CONFIRM_POLLS).
      return surfaceSticky(stored!, currentValue, isSpread, storedChain, underlying);
    } else {
      // A confident opposite read — confirm it once on refreshed data
      // before exiting, rather than acting on a single read that may share
      // cached candles with the one before it (see REVERSAL_CONFIRM_SECONDS).
      const now = decisionNow();
      const since = stored!.reversalSince ?? now;
      const streak = (stored!.reversalStreak ?? 0) + 1;
      const confirmMs = (isPositional ? REVERSAL_CONFIRM_SECONDS_POSITIONAL : REVERSAL_CONFIRM_SECONDS) * 1000;
      if (streak < REVERSAL_CONFIRM_POLLS || now - since < confirmMs) {
        const bumped: StoredTradeSetup = { ...stored!, reversalStreak: streak, reversalSince: since };
        try {
          await redis.set(key, JSON.stringify(bumped), 'EX', setupTtl);
        } catch (err: any) {
          logger.warn({ error: err.message, underlying }, 'Sticky trade setup reversal-streak write failed');
        }
        return surfaceSticky(bumped, currentValue, isSpread, storedChain, underlying);
      }
      // Reversal confirmed across enough polls — inconclusive, not a loss.
      // Still worth a mark-to-market exit price where we can get one, so
      // it's not just a blank row in the backtest.
      await recordTradeSetupOutcome(stored!, 'EXPIRED', currentValue, { underlying, exchange, mode, reason: 'BIAS_REVERSED' });
    }
  } else if (storedIsPlausible && stored?.signalId) {
    // Day rolled over — a setup from a prior session is unconditionally
    // stale regardless of direction, no debounce needed.
    await recordTradeSetupOutcome(stored!, 'EXPIRED', currentExitValue(storedChain, stored!), { underlying, exchange, mode, reason: 'SESSION_ENDED' });
  } else if (!storedIsPlausible && stored?.available && stored?.signalId) {
    // A previously-implausible setup (e.g. a diverging IV solver's target,
    // or a bad-quote spread) is about to be silently replaced below — found
    // in a backtesting-data review that this left the OLD database row
    // permanently stuck at outcome: null ("OPEN" forever), since neither
    // branch above ever ran for it. Close it out as EXPIRED first so the
    // self-heal doesn't leave a zombie row behind.
    await recordTradeSetupOutcome(stored!, 'EXPIRED', currentExitValue(storedChain, stored!), { underlying, exchange, mode, reason: 'SETUP_INVALIDATED' });
  }

  // Momentum break: the slot is empty now (nothing held, or it was just
  // closed above). A claimed trigger runs its own chain first — the safety
  // gates plus TRIGGER_QUALITY. Minted: that is this poll's setup. Refused:
  // the refusal is recorded and the consensus chain below runs as before.
  if (trigger) {
    const triggered = await resolveMomentumBreakSetup({
      provider, underlying, exchange, mode, key, today, setupTtl, chain, trigger, regime, intelligenceScore, voteSnapshot, entryContext, priorDecisionId,
    });
    if (triggered) return triggered;
  }

  // Everything above only resolves an EXISTING setup, which is safe off-hours
  // (the frozen last print is the session's real close). Minting a NEW one
  // needs live quotes and no fresh stop-out in the same direction.
  const riskOff = await riskOffReason(exchange, mode);
  const reliability = riskOff ? null : await checkReliabilityFilters(underlying, exchange, direction, mode);
  // A feed the engine cannot read is not a market view. This sits beside the
  // risk circuit breaker at the front of the chain, ahead of every rule that
  // reasons about price, because those rules would otherwise be reasoning
  // about a stale or broken quote and recording the result as a judgement.
  const feedBlock = dataQualityBlock(exchange, underlying);

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
  //
  // (Computed here, ahead of the refusal chain, only so the corrected room
  // measure below can see the target actually used. Pure; unchanged.)
  //
  // Part A rule 2 (flag FNO_VALIDATION): the IV behind that move is capped at
  // HV × IV_TARGET_CAP_MULT — an IV of 138% against HV 27% produced the fake
  // 3.2x target on 29 Sep. Target only; rich IV still raises the R:R bar via
  // RICH_IV_RR. Per chain, because an expiry fallback prices a second chain.
  //
  // Room to target: the move a target may assume is capped at the distance
  // to the nearest strong OI wall or pivot in the trade's direction. The
  // target used to be delta × expected move with no regard for what sits in
  // between, and the further it reached the worse it did: setups projecting
  // R:R 2.2+ won 0 of 16 (avg -0.37R) vs +0.17R below 1.9. A capped target
  // that no longer clears the minimum R:R is refused, like any other.
  const roomPoints = entryContext?.roomToTargetPoints ?? null;
  const targetMoveFor = (c: OptionChain) => {
    const atmIvPct = computeAtmIv(c);
    const uncapped = isPositional
      ? c.expectedMove.points
      : (() => {
          if (atmIvPct <= 0) return c.expectedMove.points;
          const oneDayMove = calculateExpectedMove(c.spotPrice, atmIvPct / 100, 1, underlying).expectedMove;
          return oneDayMove * Math.sqrt(remainingSessionFraction(exchange));
        })();
    const cap = FNO_VALIDATION
      ? capExpectedMoveByHv(uncapped, atmIvPct > 0 ? atmIvPct : null, entryContext?.hvPct ?? null, FNO_VALIDATION_PARAMS.IV_TARGET_CAP_MULT)
      : null;
    const expected = cap ? cap.points : uncapped;
    const capped = roomPoints != null && roomPoints < expected;
    return {
      targetExpectedMovePoints: expected,
      targetCapped: capped,
      targetMovePoints: capped ? roomPoints! : expected,
      ivCap: cap
        ? {
            atmIvPct: atmIvPct > 0 ? round2(atmIvPct) : null,
            hvPct: entryContext?.hvPct != null ? round2(entryContext.hvPct) : null,
            mult: FNO_VALIDATION_PARAMS.IV_TARGET_CAP_MULT,
            ivUsedPct: cap.ivUsedPct != null ? round2(cap.ivUsedPct) : null,
            capped: cap.capped,
            uncappedMovePoints: round2(uncapped),
            cappedMovePoints: round2(cap.points),
          }
        : null,
    };
  };
  const primaryMove = targetMoveFor(chain);
  const targetExpectedMovePoints = primaryMove.targetExpectedMovePoints;
  const targetCapped = primaryMove.targetCapped;
  const targetMovePoints = primaryMove.targetMovePoints;

  // Validation review, fix 2 — the corrected room measure. The old one (kept
  // below as roomSufficient) divides the UNCAPPED move by ATR and fails ~94%
  // of the time; V2 uses the target distance actually used. Recorded on every
  // decision; refuses only under ROOM_GATE (default off — no outcome data yet).
  const room2 = roomV2({ availableAtr: entryContext?.locationAheadAtr ?? null, targetMovePoints, atrPoints: entryContext?.atrPoints ?? null });
  if (entryContext) {
    entryContext.roomRequiredAtrV2 = room2.requiredAtrV2 != null ? Math.round(room2.requiredAtrV2 * 100) / 100 : null;
    entryContext.roomSufficientV2 = room2.sufficientV2;
  }

  // Validation review, fix 4 (flag CONCURRENCY_CAP, default OFF): how much of
  // the live paper book already leans this way. The Redis read happens only
  // when the flag is on.
  const concurrencyExposure: ExposureSnapshot | null =
    TRADING_FLAGS.CONCURRENCY_CAP && direction !== 'NEUTRAL'
      ? await readExposureAtCreation(
          { key, exchange, underlying, mode, direction, strike: null, side: null, expiry: null, riskAmount: 0 },
          today
        )
      : null;

  const refusal: GateRefusal | null =
    (riskOff ? { code: 'RISK_OFF' as const, reason: riskOff } : null) ??
    (feedBlock ? { code: 'NO_QUOTE' as const, reason: feedBlock } : null) ??
    sessionGateReason(exchange, mode) ??
    (confidence < MIN_SETUP_CONFIDENCE
      ? {
          code: 'LOW_SETUP_QUALITY' as const,
          reason: `Confidence ${confidence}/100 is below the ${MIN_SETUP_CONFIDENCE} a setup needs. Below that bar the recorded trades lost 6.6R across 34 of them, and 85% of the weakest band expired without touching either level.`,
        }
      : null) ??
    // Validation review, fix 2 (flags LOCATION_GATE, ROOM_GATE). Null when off.
    locationGateReason({
      enabled: TRADING_FLAGS.LOCATION_GATE,
      locationScore: entryContext?.locationScore ?? null,
      minScore: TRADING_PARAMS.LOCATION_GATE_MIN_SCORE,
      locationReason: entryContext?.locationReason ?? null,
    }) ??
    roomGateReason({
      enabled: TRADING_FLAGS.ROOM_GATE,
      sufficientV2: room2.sufficientV2,
      availableAtr: entryContext?.locationAheadAtr ?? null,
      requiredAtrV2: room2.requiredAtrV2,
    }) ??
    positioningConflictReason(direction, voteSnapshot) ??
    (await losingCloseCooldownReason(underlying, exchange, direction, mode, confidence)) ??
    (reliability ? { code: 'RELIABILITY_FILTER' as const, reason: reliability } : null) ??
    // Validation review, fix 4. Null when CONCURRENCY_CAP is off.
    concurrencyGateReason({ enabled: TRADING_FLAGS.CONCURRENCY_CAP, exposure: concurrencyExposure, max: TRADING_PARAMS.MAX_CONCURRENT_SAME_DIRECTION });
  const unreliableReason = refusal?.reason ?? null;

  // --- Gate diagnostics (Phase 1, observation only) ---
  // Computed AFTER `refusal` is fixed, from the same inputs, and never used
  // to change it: the live chain above is untouched and still decides alone.
  // Each gate is evaluated on its own so a record shows every gate that
  // would have refused, not only the first. The pure parts are captured now;
  // the post-loss reads run lazily, only for a decision that is recorded.
  const diagnosticsAt = decisionNow();
  // Part A: set once the contract has been validated below; read lazily by the
  // FNO_VALIDATION diagnostic row (NOT_EVALUATED when a gate above refused first).
  let consensusFnoRecord: TradeSetupFnoValidation | null = null;
  const diagnosticSnapshot = {
    sessionRefusal: sessionGateReason(exchange, mode),
    minutesSinceOpen: minutesSinceSessionOpen(exchange),
    positioningRefusal: positioningConflictReason(direction, voteSnapshot),
    minutesToClose: minutesToSessionClose(exchange, diagnosticsAt),
  };
  const gateDiagnosticsFor = async (): Promise<GateDiagnostic[]> => {
    try {
      const losingClose = await readLosingCloseState(underlying, exchange, direction, mode);
      const rows = evaluateGateDiagnostics(
        {
          direction,
          mode,
          confidence,
          riskOffReason: riskOff,
          feedBlockReason: feedBlock,
          sessionRefusal: diagnosticSnapshot.sessionRefusal,
          minutesSinceOpen: diagnosticSnapshot.minutesSinceOpen,
          positioningRefusal: diagnosticSnapshot.positioningRefusal,
          positioningVotes: voteSnapshot?.positioning ?? null,
          losingClose,
          // The live chain only runs the reliability check when not RISK_OFF.
          reliability: { evaluated: riskOff == null, reason: reliability },
          liveRefusalCode: refusal?.code ?? null,
          thresholds: {
            minSetupConfidence: MIN_SETUP_CONFIDENCE,
            openingSettleMinutes: SETUP_OPENING_SETTLE_MINUTES,
            openingGuardMinutes: SETUP_OPENING_GUARD_MINUTES,
            postLossSettleMinutes: POST_LOSS_SETTLE_MINUTES,
            postLossMinConfidence: POST_LOSS_MIN_CONFIDENCE,
            maxSameDirectionLossesPerDay: MAX_SAME_DIRECTION_LOSSES_PER_DAY,
          },
        },
        diagnosticsAt
      );
      // Phase 3 (spec §20) — not part of the live chain (see gate-diagnostics.ts):
      // logged so a report can tell whether room-to-target ever ran on stale
      // OI, never read back and never able to refuse anything.
      rows.push(oiWallFreshnessDiagnostic(entryContext?.roomCheckOiAgeSeconds ?? null, diagnosticsAt));
      if (FNO_VALIDATION) rows.push(fnoValidationDiagnostic({ enabled: true, record: consensusFnoRecord, params: { ...FNO_VALIDATION_PARAMS }, at: diagnosticsAt }));
      // Validation-review gates: one row each, enforced or not, so an
      // unenforced gate's would-refuse rate is measured on live decisions.
      rows.push(
        ...evaluateValidationGateDiagnostics(
          {
            mode,
            exchange,
            liveRefusalCode: refusal?.code ?? null,
            closing: { enforced: TRADING_FLAGS.CLOSING_GUARD, minutesToClose: diagnosticSnapshot.minutesToClose, guardMinutes: TRADING_PARAMS.SETUP_CLOSING_GUARD_MINUTES },
            location: { enforced: TRADING_FLAGS.LOCATION_GATE, score: entryContext?.locationScore ?? null, minScore: TRADING_PARAMS.LOCATION_GATE_MIN_SCORE },
            room: {
              enforced: TRADING_FLAGS.ROOM_GATE,
              availableAtr: entryContext?.locationAheadAtr ?? null,
              requiredAtrV2: room2.requiredAtrV2,
              sufficientV2: room2.sufficientV2,
              requiredAtrV1: entryContext?.roomRequiredAtr ?? null,
              sufficientV1: entryContext?.roomSufficient ?? null,
            },
            concurrency: { enforced: TRADING_FLAGS.CONCURRENCY_CAP, exposure: concurrencyExposure, max: TRADING_PARAMS.MAX_CONCURRENT_SAME_DIRECTION },
          },
          diagnosticsAt
        )
      );
      return rows;
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Gate diagnostics: evaluation failed');
      return [];
    }
  };

  // Phase 3 (spec §15) — labelled here (not in computeMarketBias) because
  // this is where a decision is actually recorded; entryContext already
  // carries the raw ADX/atrZ/breakout readings classifyRegime() used.
  // SETUP_OPENING_GUARD_MINUTES is the live gate's own window — reused, not
  // re-picked, so this always agrees with what OPENING_HOUR actually guards.
  const openingEnvironment = classifyOpeningEnvironment(
    {
      minutesSinceOpen: diagnosticSnapshot.minutesSinceOpen,
      adxValue: entryContext?.adxValue ?? 0,
      atrZ: entryContext?.atrZ ?? 0,
      freshBreakoutUp: entryContext?.freshBreakoutUp ?? false,
      freshBreakoutDown: entryContext?.freshBreakoutDown ?? false,
    },
    SETUP_OPENING_GUARD_MINUTES
  );

  // Phase 3 (spec §16) — recovers elapsed minutes from the exact Redis TTLs
  // losingCloseCooldownReason() above already read for the gate check. See
  // the function's own comment for what is and is not recoverable.
  const minutesSinceLastLoss = await readMinutesSinceLastLoss(underlying, exchange, mode, direction);

  const phase1Context = {
    strategy: entryContext?.strategyLabels ?? null,
    confidenceDimensions: entryContext
      ? {
          voteContributions: entryContext.voteContributions ?? null,
          directionScore: entryContext.directionScore ?? null,
          setupQualityScore: entryContext.setupQualityScore ?? null,
        }
      : null,
    // Phase 3 persistence — see each value's own comment above.
    openingEnvironment,
    minutesSinceLastLoss,
    roomCheckOiAgeSeconds: entryContext?.roomCheckOiAgeSeconds ?? null,
  };

  if (refusal != null) {
    logDecision({
      at: decisionNow(),
      symbol: underlying,
      exchange,
      mode,
      decision: 'SKIP',
      code: refusal.code,
      reason: refusal.reason,
      regime: entryContext?.regime ?? null,
      bias: direction,
      setupQuality: confidence,
      locationScore: entryContext?.locationScore ?? null,
      locationReason: entryContext?.locationReason ?? null,
      roomAvailableAtr: entryContext?.roomAvailableAtr ?? null,
      roomRequiredAtr: entryContext?.roomRequiredAtr ?? null,
      roomSufficient: entryContext?.roomSufficient ?? null,
    });
    // The refusal, recorded in full. The missed-winner audit grades it later
    // against what the market actually did, which is the only way to tell
    // capital protection from having simply stopped trading.
    const refusedSide = direction === 'BEARISH' ? 'PE' : 'CE';
    const blocks = snapshotBlocks(chain, entryContext, null, refusedSide);
    const instrumentation = snapshotInstrumentation(exchange, entryContext, null);
    recordDecisionSnapshot({
      ...instrumentation,
      ...phase1Context,
      freshness: {
        timestamps: inputTimestampsFrom(chain, findLeg(chain, chain.atmStrike, refusedSide)),
        underlyingPriceAtGeneration: chain.spotPrice,
      },
      gateDiagnostics: gateDiagnosticsFor,
      symbol: underlying,
      exchange,
      mode,
      expiry: chain.expiry,
      decision: 'REFUSE',
      reasonCode: refusal.code,
      reason: refusal.reason,
      regime: entryContext?.regime ?? null,
      bias: direction,
      confidence,
      pcr: chain.pcrDetail?.oiPCR ?? null,
      underlyingPrice: chain.spotPrice,
      atr: entryContext?.atrPoints ?? null,
      ...blocks,
    });
  }
  if (unreliableReason != null) {
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Sticky trade setup clear failed');
    }
    return { available: false, reason: unreliableReason, noTradeCode: refusal?.code };
  }

  // Reported, not enforced — see checkCounterToIndex. Attached to the built
  // setup below so each consumer can apply its own policy.
  const counterIndex = await checkCounterToIndex(underlying, exchange, direction, mode);

  const vix = await lookupIndiaVix(provider, exchange);
  const slPremiumPct = isPositional ? POSITIONAL_SL_PREMIUM_PCT : undefined;

  // targetExpectedMovePoints / targetMovePoints are computed above, ahead of
  // the refusal chain (unchanged; moved so the V2 room measure can use them).
  //
  // Room to run (shadow): the space ahead against the move the target needs.
  // The existing cap already trims the target to the nearest wall or pivot;
  // this records whether there was ever enough room to be worth taking.
  const atrForRoom = entryContext?.atrPoints ?? null;
  const roomCheck = assessRoom(
    entryContext?.locationAheadAtr ?? null,
    atrForRoom && atrForRoom > 0 ? targetExpectedMovePoints / atrForRoom : null
  );
  if (entryContext) {
    entryContext.roomAvailableAtr = roomCheck.availableAtr != null ? Math.round(roomCheck.availableAtr * 100) / 100 : null;
    entryContext.roomRequiredAtr = roomCheck.requiredAtr != null ? Math.round(roomCheck.requiredAtr * 100) / 100 : null;
    entryContext.roomSufficient = roomCheck.sufficient;
  }
  if (roomCheck.sufficient === false) {
    logger.info(
      { shadow: 'ROOM_TO_RUN', underlying, exchange, mode, availableAtr: roomCheck.availableAtr, requiredAtr: roomCheck.requiredAtr, locationScore: entryContext?.locationScore ?? null },
      'Room to run: this setup WOULD be refused for insufficient room (shadow only)'
    );
  }

  const roomNote = targetCapped
    ? ` Target move capped at ${roomPoints!.toFixed(0)} pts — the room to the ${formatRoomSource(entryContext!.roomLevelSource)} at ${entryContext!.roomLevel!.toFixed(0)} — instead of the ${targetExpectedMovePoints.toFixed(0)}-pt expected move.`
    : '';
  const regimeNote =
    entryContext && entryContext.setupConfidence < entryContext.biasConfidence
      ? ` Confidence reduced from ${entryContext.biasConfidence} to ${entryContext.setupConfidence}: ${
          entryContext.regimeAlignment === 'RANGE' ? `a ${entryContext.regime} regime rarely gives an option buyer the move it needs` : `this runs against the ${entryContext.regime} regime`
        }.`
      : '';

  // Option-quality context. The instrument is part of the trade, so the
  // builder is told what the premium it is about to buy costs in decay and
  // where its IV sits in its own year — neither of which the chain leg
  // carries. Expected hold is the session remaining for an intraday setup
  // and a working week for a positional one, since that is what decides how
  // much theta actually gets paid.
  const ivRank = await ivRankFor(underlying, chain.expiry, computeAtmIv(chain)).catch(() => null);
  const expectedHoldHours = isPositional
    ? 5 * 6.25
    : Math.max(0.5, remainingSessionMinutesFrom(exchange, decisionNow()) / 60);
  // Part A (flag FNO_VALIDATION): the strike is chosen by |delta| band, the
  // builder enforces the cost ceiling and the stop-outside-noise rule, and a
  // failing 0-DTE contract falls back to the next expiry. Flag off =
  // buildTradeSetup on chain.atmStrike exactly as before.
  const validated = await buildWithFnoValidation({
    enabled: FNO_VALIDATION,
    primary: chain,
    side: direction === 'BEARISH' ? 'PE' : 'CE',
    params: { deltaMin: FNO_VALIDATION_PARAMS.OPTION_DELTA_BAND_MIN, deltaMax: FNO_VALIDATION_PARAMS.OPTION_DELTA_BAND_MAX, deltaTarget: FNO_VALIDATION_PARAMS.OPTION_DELTA_TARGET },
    contextFor: (c) => {
      const move = c === chain ? primaryMove : targetMoveFor(c);
      return { expectedMovePoints: move.targetMovePoints, expectedHoldHours, ivRank, hvPct: entryContext?.hvPct ?? null, ivCap: move.ivCap };
    },
    fetchNextExpiry: (expiry) => buildOptionChain(provider, underlying, exchange, expiry),
    onError: (stage, err: any) => logger.warn({ error: err?.message ?? String(err), stage, underlying, exchange, mode }, 'F&O validation: next-expiry chain unavailable — no fallback contract'),
    build: (c, strike, ctx) =>
      buildTradeSetup(
        c.strikes,
        strike,
        direction,
        confidence,
        ctx.expectedMovePoints,
        slPremiumPct,
        vix,
        c.dte,
        c.lotSize,
        entryContext?.atrPoints ?? null,
        // 0.05 is the premium tick on NSE/BSE options and the MCX option
        // contracts this engine trades; the chain leg does not carry its own.
        {
          ivRank,
          hvPct: entryContext?.hvPct ?? null,
          tickSize: 0.05,
          expectedHoldHours,
          // Validation review, fixes 1 and 6. The switches come from the server's
          // config (trading-flags.ts) so the analytics package stays pure; with
          // both off the builder ignores every field below.
          flags: { structuralStop: TRADING_FLAGS.STRUCTURAL_STOP, richIvRr: TRADING_FLAGS.RICH_IV_RR },
          spot: entryContext?.locationSpot ?? c.spotPrice,
          nearestBehindLevel: entryContext?.locationBehindLevel ?? null,
          structuralStopBufferAtr: TRADING_PARAMS.STRUCTURAL_STOP_BUFFER_ATR,
          ivVsHv: entryContext?.ivVsHv ?? null,
          richIvMinRiskReward: TRADING_PARAMS.RICH_IV_MIN_RISK_REWARD,
          ...(FNO_VALIDATION
            ? { fnoValidation: { enabled: true, maxCostPctOfPremium: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM, minOptionStopAtr: FNO_VALIDATION_PARAMS.MIN_OPTION_STOP_ATR } }
            : {}),
        }
      ),
  });
  const builtRaw = validated.setup;
  // The contract actually traded (or finally refused) — the next expiry's chain after a fallback.
  const usedChain = validated.chain;
  consensusFnoRecord = validated.fnoValidation;

  // --- Phase 2 shadow models (observation only) ---
  // Computed AFTER builtRaw is fixed, from the same chain and inputs, into a
  // separate object that is only ever handed to the decision snapshot. None of
  // it flows back into builtRaw/fresh, the sticky setup, or any gate.
  const shadowModels = computeShadowModels(builtRaw, usedChain, direction, targetMovePoints, expectedHoldHours, {
    ivRank,
    hvPct: entryContext?.hvPct ?? null,
    underlying,
  });

  // Record WHICH contract the strike/entry/SL/target belong to. A strike
  // alone is ambiguous — the same strike exists in every listed expiry at a
  // different premium — and this is what later tracking prices against.
  // Monthly stock options carry weeks of time value, so on a one-session
  // target they rarely clear the reward:risk gate (measured: the target
  // reaches ~25-29% of premium with a full session left, ~20% by midday).
  // That's the gate working, not a missing setup — say so, and where a
  // stock setup can come from instead.
  const isNseStock = exchange === 'NSE' && !(INDEX_SYMBOLS as readonly string[]).includes(underlying);
  const stockNote =
    !builtRaw.available && isNseStock && !isPositional && builtRaw.reason.startsWith('Reward:risk after costs')
      ? ` Monthly stock options carry weeks of time value, so a one-session move rarely pays for the stop — switch this stock to Positional for a multi-day setup.`
      : '';
  const built: TradeSetup = builtRaw.available
    ? { ...builtRaw, expiry: usedChain.expiry, dte: usedChain.dte, reason: `${builtRaw.reason}${roomNote}${regimeNote}` }
    : { ...builtRaw, reason: `${builtRaw.reason}${stockNote}${roomNote}${regimeNote}` };
  const fresh: TradeSetup =
    built.available && counterIndex
      ? {
          ...built,
          counterIndex,
          reason: `${built.reason} NOTE: NIFTY is ${counterIndex} — this runs against the broader market, so it stands on this stock's own move alone.`,
        }
      : built;

  if (!fresh.available) {
    // Clear any previously locked setup now that conditions no longer
    // support one — otherwise a stale setup from earlier today could
    // resurface with an outdated entry price if direction swings back.
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Sticky trade setup clear failed');
    }
    // Phase 3 (spec §5) — until now a refusal from buildTradeSetup itself
    // (poor option quality, cost exceeding the edge, reward:risk too low
    // after costs, a bad ATM quote, an unrealistic target) returned straight
    // to the caller with no persisted row — only the gate-level `refusal`
    // computed above (risk-off, session, confidence, positioning, cooldown,
    // reliability) got one. That left this whole refusal family queryable
    // only via whatever sentence the UI happened to show. Recorded exactly
    // as buildTradeSetup computed it: no new check, nothing here changes
    // what refuses.
    const refusedSide: 'CE' | 'PE' = direction === 'BEARISH' ? 'PE' : 'CE';
    const refusalBlocks = snapshotBlocks(usedChain, entryContext, fresh, refusedSide);
    const refusalInstrumentation = snapshotInstrumentation(exchange, entryContext, fresh);
    recordDecisionSnapshot({
      ...refusalInstrumentation,
      ...phase1Context,
      freshness: {
        timestamps: inputTimestampsFrom(usedChain, findLeg(usedChain, usedChain.atmStrike, refusedSide)),
        underlyingPriceAtGeneration: usedChain.spotPrice,
      },
      gateDiagnostics: gateDiagnosticsFor,
      contractValidation: fresh.contractValidation ?? null,
      symbol: underlying,
      exchange,
      mode,
      expiry: usedChain.expiry,
      decision: 'REFUSE',
      reasonCode: fresh.noTradeCode ?? null,
      reason: fresh.reason,
      regime: entryContext?.regime ?? null,
      bias: direction,
      confidence,
      pcr: chain.pcrDetail?.oiPCR ?? null,
      underlyingPrice: chain.spotPrice,
      atr: entryContext?.atrPoints ?? null,
      ...refusalBlocks,
    });
    return fresh;
  }

  // --- The setup-creating branch ---
  // Everything from here to the Telegram push mints a NEW setup: a `signals`
  // row, a TAKE decision row, the sticky slot write and the notification.
  // Several callers can reach this point for the same slot at once (a browser
  // poll, the scanners, the trade-setup monitor, the background evaluator), so
  // with BACKGROUND_BIAS on it runs under a Redis SET NX mint lock: one caller
  // mints, any other returns the setup that caller minted — no second row, no
  // second message. Flag off = the unlocked path exactly as before.
  const mintFresh = (): Promise<StoredTradeSetup> =>
    mintTradeSetup({
      underlying, exchange, mode, key, today, setupTtl, chain: usedChain, fresh, direction, confidence, regime, intelligenceScore,
      voteSnapshot, entryContext, phase1Context, gateDiagnosticsFor, shadowModels,
    });
  return mintUnderLock({ underlying, exchange, mode, key, today, isPositional, priorDecisionId, mintFresh });
}

/**
 * The setup mint lock (BACKGROUND_BIAS): one caller mints, any other returns
 * the setup that caller minted. Split out of resolveStickyTradeSetup unchanged
 * so the momentum-break family mints under the very same lock (same key, so
 * the two families can never double-mint the one shared slot).
 */
async function mintUnderLock(args: {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  key: string;
  today: string;
  isPositional: boolean;
  priorDecisionId: string | null;
  mintFresh: () => Promise<StoredTradeSetup>;
}): Promise<TradeSetup> {
  const { underlying, exchange, mode, key, today, isPositional, priorDecisionId, mintFresh } = args;
  if (!COVERAGE_LAG_FLAGS.BACKGROUND_BIAS) return mintFresh();

  const readMintedByOther = async (): Promise<StoredTradeSetup | null> => {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      const s = JSON.parse(raw) as StoredTradeSetup;
      return s.available && s.decisionId != null && s.decisionId !== priorDecisionId && (isPositional || s.day === today) ? s : null;
    } catch (err: any) {
      logger.warn({ error: err.message, underlying, exchange, mode }, 'Mint lock: slot re-read failed — treating the slot as empty');
      return null;
    }
  };
  const outcome = await mintOnce<StoredTradeSetup, StoredTradeSetup>({
    store: {
      setNx: async (k, v, ttl) => (await redis.set(k, v, 'EX', ttl, 'NX')) === 'OK',
      get: (k) => redis.get(k),
      del: (k) => redis.del(k),
    },
    lockKey: mintLockKey(exchange, underlying, mode),
    ttlSeconds: COVERAGE_LAG_PARAMS.SETUP_MINT_LOCK_TTL_SECONDS,
    waitMs: COVERAGE_LAG_PARAMS.SETUP_MINT_LOCK_WAIT_MS,
    readExisting: readMintedByOther,
    mint: mintFresh,
    onError: (stage, err: any) =>
      logger.warn(
        { error: err?.message ?? String(err), stage, underlying, exchange, mode },
        stage === 'ACQUIRE' ? 'Mint lock: could not take the lock — minting unlocked' : 'Mint lock: release failed — it expires on its TTL'
      ),
  });
  if (outcome.kind === 'MINTED') return outcome.value;
  if (outcome.kind === 'EXISTING') {
    logger.info({ underlying, exchange, mode, decisionId: outcome.value.decisionId }, 'Mint lock: another caller minted this setup — returning theirs, not minting again');
    return outcome.value;
  }
  logger.info({ underlying, exchange, mode }, 'Mint lock: another caller is still minting this setup — nothing minted by this poll');
  return { available: false, reason: 'A setup for this symbol is being generated by another evaluation right now — it will show on the next refresh.' };
}

// --- Momentum-break family (flag MOMENTUM_BREAK) ---

/**
 * A trigger bar is acted on once. The first caller to claim it (Redis SET NX,
 * keyed on the bar) may close an opposite setup and mint; everyone else gets
 * null and reads the slot as usual. A failed claim is logged and treated as
 * not claimed — a missed trigger is safer than a double one.
 */
async function claimMomentumTrigger(exchange: Exchange, underlying: string, mode: TradingMode, trigger: MomentumBreakSignal): Promise<MomentumBreakSignal | null> {
  try {
    const first = await redis.set(`momentum_break_claimed:${exchange}:${underlying}:${mode}:${trigger.barTime}`, '1', 'EX', 60 * 60, 'NX');
    return first === 'OK' ? trigger : null;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange, barTime: trigger.barTime }, 'Momentum break: trigger claim failed — not acting on it');
    return null;
  }
}

/**
 * The trigger's own chain and mint. Safety gates (risk-off, feed, session /
 * opening / closing, post-loss cooldown judged on the trigger's QUALITY so the
 * 80 floor after a loss applies, reliability, concurrency) plus
 * TRIGGER_QUALITY; the consensus-only gates are not consulted. The option leg
 * is built by the ordinary buildTradeSetup: target move = distance to the
 * trigger's target, premium stop = max(15%, |Δ|·stop distance / mid) through
 * the unprotected slPremiumPct argument, the broken level as the structure
 * behind, confidence = quality — so its R:R minimums (1.5, or 2.0 on rich IV)
 * apply unchanged. Returns the minted setup, or null when refused (recorded).
 */
async function resolveMomentumBreakSetup(ctx: {
  provider: MarketDataProvider;
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  key: string;
  today: string;
  setupTtl: number;
  chain: OptionChain;
  trigger: MomentumBreakSignal;
  regime: MarketRegime;
  intelligenceScore: number;
  voteSnapshot: BiasVoteSnapshot | undefined;
  entryContext: SetupEntryContext | undefined;
  priorDecisionId: string | null;
}): Promise<TradeSetup | null> {
  const { provider, underlying, exchange, mode, key, today, setupTtl, chain, trigger, regime, intelligenceScore, voteSnapshot, entryContext, priorDecisionId } = ctx;
  const direction: BiasDirection = trigger.direction;
  const quality = trigger.quality;
  const at = decisionNow();
  const spot = chain.spotPrice;

  const riskOff = await riskOffReason(exchange, mode);
  const reliability = riskOff ? null : await checkReliabilityFilters(underlying, exchange, direction, mode);
  const feedBlock = dataQualityBlock(exchange, underlying);
  const session = sessionGateReason(exchange, mode);
  const cooldown = await losingCloseCooldownReason(underlying, exchange, direction, mode, quality);
  const concurrencyExposure: ExposureSnapshot | null = TRADING_FLAGS.CONCURRENCY_CAP
    ? await readExposureAtCreation({ key, exchange, underlying, mode, direction, strike: null, side: null, expiry: null, riskAmount: 0 }, today)
    : null;
  const concurrency = concurrencyGateReason({ enabled: TRADING_FLAGS.CONCURRENCY_CAP, exposure: concurrencyExposure, max: TRADING_PARAMS.MAX_CONCURRENT_SAME_DIRECTION });
  const refusal = triggerRefusal({ riskOff, feedBlock, session, cooldown, reliability, concurrency }, trigger, at, spot);

  const triggerContext: SetupEntryContext | undefined = entryContext
    ? {
        ...entryContext,
        setupConfidence: quality,
        locationBehindLevel: trigger.levelPrice,
        locationBehindKind: trigger.levelKind,
        setupClassification: {
          setupType: 'MOMENTUM_BREAK',
          setupFamily: 'MOMENTUM',
          primaryTrigger: `${trigger.levelKind}_BREAK`,
          allTriggers: ['MOMENTUM_BREAK', trigger.levelKind],
          detail: { ...trigger },
        },
        momentumBreak: storedMomentumBreak(trigger),
      }
    : undefined;

  const minutesSinceOpen = minutesSinceSessionOpen(exchange);
  let momentumFnoRecord: TradeSetupFnoValidation | null = null;
  const gateDiagnosticsFor = async (): Promise<GateDiagnostic[]> => {
    try {
      const losingClose = await readLosingCloseState(underlying, exchange, direction, mode);
      // The safety rows only — this family's chain has no LOW_SETUP_QUALITY or POSITIONING_CONFLICT.
      const rows = evaluateGateDiagnostics(
        {
          direction,
          mode,
          confidence: quality,
          riskOffReason: riskOff,
          feedBlockReason: feedBlock,
          sessionRefusal: session,
          minutesSinceOpen,
          positioningRefusal: null,
          positioningVotes: null,
          losingClose,
          reliability: { evaluated: riskOff == null, reason: reliability },
          liveRefusalCode: refusal?.code ?? null,
          thresholds: {
            minSetupConfidence: MIN_SETUP_CONFIDENCE,
            openingSettleMinutes: SETUP_OPENING_SETTLE_MINUTES,
            openingGuardMinutes: SETUP_OPENING_GUARD_MINUTES,
            postLossSettleMinutes: POST_LOSS_SETTLE_MINUTES,
            postLossMinConfidence: POST_LOSS_MIN_CONFIDENCE,
            maxSameDirectionLossesPerDay: MAX_SAME_DIRECTION_LOSSES_PER_DAY,
          },
        },
        at
      ).filter((r) => r.gate !== 'LOW_SETUP_QUALITY' && r.gate !== 'POSITIONING_CONFLICT');
      rows.push(triggerQualityDiagnostic(trigger, refusal, at));
      if (FNO_VALIDATION) rows.push(fnoValidationDiagnostic({ enabled: true, record: momentumFnoRecord, params: { ...FNO_VALIDATION_PARAMS }, at }));
      rows.push(
        ...evaluateValidationGateDiagnostics(
          {
            mode,
            exchange,
            liveRefusalCode: refusal?.code ?? null,
            closing: { enforced: TRADING_FLAGS.CLOSING_GUARD, minutesToClose: minutesToSessionClose(exchange, at), guardMinutes: TRADING_PARAMS.SETUP_CLOSING_GUARD_MINUTES },
            location: { enforced: false, score: entryContext?.locationScore ?? null, minScore: TRADING_PARAMS.LOCATION_GATE_MIN_SCORE },
            room: { enforced: false, availableAtr: null, requiredAtrV2: null, sufficientV2: null, requiredAtrV1: null, sufficientV1: null },
            concurrency: { enforced: TRADING_FLAGS.CONCURRENCY_CAP, exposure: concurrencyExposure, max: TRADING_PARAMS.MAX_CONCURRENT_SAME_DIRECTION },
          },
          at
        ).filter((r) => r.gate === 'CLOSING_HOUR' || r.gate === 'CONCURRENT_EXPOSURE')
      );
      return rows;
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Momentum break: gate diagnostics failed');
      return [];
    }
  };

  const phase1Context = {
    strategy: entryContext?.strategyLabels ?? null,
    confidenceDimensions: entryContext
      ? { voteContributions: entryContext.voteContributions ?? null, directionScore: entryContext.directionScore ?? null, setupQualityScore: entryContext.setupQualityScore ?? null }
      : null,
    openingEnvironment: classifyOpeningEnvironment(
      {
        minutesSinceOpen,
        adxValue: entryContext?.adxValue ?? 0,
        atrZ: entryContext?.atrZ ?? 0,
        freshBreakoutUp: entryContext?.freshBreakoutUp ?? false,
        freshBreakoutDown: entryContext?.freshBreakoutDown ?? false,
      },
      SETUP_OPENING_GUARD_MINUTES
    ),
    minutesSinceLastLoss: await readMinutesSinceLastLoss(underlying, exchange, mode, direction),
    roomCheckOiAgeSeconds: entryContext?.roomCheckOiAgeSeconds ?? null,
  };
  const side: 'CE' | 'PE' = direction === 'BEARISH' ? 'PE' : 'CE';
  const describe = `Momentum break ${direction}: ${trigger.levelKind} ${trigger.levelPrice} broken on ${trigger.volMult}x volume and a ${trigger.rangeMult}x-ATR range (quality ${quality}); underlying stop ${trigger.stop}, target ${trigger.target} (${trigger.targetKind}).`;

  const recordRefusal = (code: NoTradeCode | null, reason: string, setup: TradeSetup | null) => {
    logDecision({
      at,
      symbol: underlying,
      exchange,
      mode,
      decision: 'SKIP',
      code: code ?? 'UNKNOWN',
      reason,
      regime,
      bias: direction,
      setupQuality: quality,
      locationScore: entryContext?.locationScore ?? null,
      locationReason: entryContext?.locationReason ?? null,
      roomAvailableAtr: null,
      roomRequiredAtr: null,
      roomSufficient: null,
    });
    recordDecisionSnapshot({
      ...snapshotInstrumentation(exchange, triggerContext, setup),
      ...phase1Context,
      freshness: { timestamps: inputTimestampsFrom(chain, findLeg(chain, chain.atmStrike, side)), underlyingPriceAtGeneration: spot },
      gateDiagnostics: gateDiagnosticsFor,
      contractValidation: setup?.contractValidation ?? null,
      symbol: underlying,
      exchange,
      mode,
      expiry: chain.expiry,
      decision: 'REFUSE',
      reasonCode: code,
      reason,
      regime,
      bias: direction,
      confidence: quality,
      pcr: chain.pcrDetail?.oiPCR ?? null,
      underlyingPrice: spot,
      atr: trigger.atr,
      ...snapshotBlocks(chain, triggerContext, setup, side),
    });
  };

  if (refusal) {
    logger.info({ underlying, exchange, code: refusal.code }, 'Momentum break: trigger refused by its chain');
    recordRefusal(refusal.code, `${describe} Refused: ${refusal.reason}`, null);
    return null;
  }

  const stopDistance = Math.abs(trigger.stop - spot);
  const targetMove = Math.abs(trigger.target - spot);
  const vix = await lookupIndiaVix(provider, exchange);
  const ivRank = await ivRankFor(underlying, chain.expiry, computeAtmIv(chain)).catch((err: any) => {
    logger.warn({ error: err.message, underlying }, 'Momentum break: IV rank unavailable — building without it');
    return null;
  });
  const expectedHoldHours = Math.max(0.5, remainingSessionMinutesFrom(exchange, at) / 60);
  // Part A applies to this family too; its target is a level, so no IV cap.
  const validated = await buildWithFnoValidation({
    enabled: FNO_VALIDATION,
    primary: chain,
    side,
    params: { deltaMin: FNO_VALIDATION_PARAMS.OPTION_DELTA_BAND_MIN, deltaMax: FNO_VALIDATION_PARAMS.OPTION_DELTA_BAND_MAX, deltaTarget: FNO_VALIDATION_PARAMS.OPTION_DELTA_TARGET },
    contextFor: () => ({ expectedMovePoints: targetMove, expectedHoldHours, ivRank, hvPct: entryContext?.hvPct ?? null, ivCap: null }),
    fetchNextExpiry: (expiry) => buildOptionChain(provider, underlying, exchange, expiry),
    onError: (stage, err: any) => logger.warn({ error: err?.message ?? String(err), stage, underlying, exchange }, 'Momentum break: next-expiry chain unavailable — no fallback contract'),
    build: (c, strike) => {
      const sl = triggerSlPremiumPct(c.strikes, strike, direction, stopDistance);
      return buildTradeSetup(
        c.strikes,
        strike,
        direction,
        quality,
        targetMove,
        sl?.slPremiumPct,
        vix,
        c.dte,
        c.lotSize,
        trigger.atr,
        {
          ivRank,
          hvPct: entryContext?.hvPct ?? null,
          tickSize: 0.05,
          expectedHoldHours,
          flags: { structuralStop: TRADING_FLAGS.STRUCTURAL_STOP, richIvRr: TRADING_FLAGS.RICH_IV_RR },
          spot,
          nearestBehindLevel: trigger.levelPrice,
          structuralStopBufferAtr: TRADING_PARAMS.STRUCTURAL_STOP_BUFFER_ATR,
          ivVsHv: entryContext?.ivVsHv ?? null,
          richIvMinRiskReward: TRADING_PARAMS.RICH_IV_MIN_RISK_REWARD,
          ...(FNO_VALIDATION
            ? { fnoValidation: { enabled: true, maxCostPctOfPremium: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM, minOptionStopAtr: FNO_VALIDATION_PARAMS.MIN_OPTION_STOP_ATR } }
            : {}),
        }
      );
    },
  });
  const builtRaw = validated.setup;
  const usedChain = validated.chain;
  momentumFnoRecord = validated.fnoValidation;
  if (!builtRaw.available) {
    // Far-dated contracts will often land here on REWARD_RISK_TOO_LOW: the
    // option cannot pay for a stop where the break is wrong. Recorded, honest.
    logger.info({ underlying, exchange, code: builtRaw.noTradeCode ?? null }, 'Momentum break: option leg refused by buildTradeSetup');
    recordRefusal(builtRaw.noTradeCode ?? null, `${describe} ${builtRaw.reason}`, builtRaw);
    return null;
  }
  const fresh: TradeSetup = {
    ...builtRaw,
    strategy: MOMENTUM_BREAK_STRATEGY,
    expiry: usedChain.expiry,
    dte: usedChain.dte,
    reason: `${describe} ${builtRaw.reason}`,
  };
  const shadowModels = computeShadowModels(builtRaw, usedChain, direction, targetMove, expectedHoldHours, { ivRank, hvPct: entryContext?.hvPct ?? null, underlying });
  const mintFresh = (): Promise<StoredTradeSetup> =>
    mintTradeSetup({
      underlying, exchange, mode, key, today, setupTtl, chain: usedChain, fresh, direction, confidence: quality, regime, intelligenceScore,
      voteSnapshot, entryContext: triggerContext, phase1Context, gateDiagnosticsFor, shadowModels,
      momentumBreak: storedMomentumBreak(trigger),
    });
  return mintUnderLock({ underlying, exchange, mode, key, today, isPositional: false, priorDecisionId, mintFresh });
}

/**
 * Mints one new sticky setup: the `signals` row, the TAKE decision row, the
 * slot write and the Telegram push. Split out of resolveStickyTradeSetup
 * (unchanged line for line) so the mint lock can wrap it.
 */
async function mintTradeSetup(ctx: {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  key: string;
  today: string;
  setupTtl: number;
  chain: OptionChain;
  fresh: TradeSetup;
  direction: BiasDirection;
  confidence: number;
  regime: MarketRegime;
  intelligenceScore: number;
  voteSnapshot: BiasVoteSnapshot | undefined;
  entryContext: SetupEntryContext | undefined;
  phase1Context: Pick<DecisionSnapshotInput, 'strategy' | 'confidenceDimensions' | 'openingEnvironment' | 'minutesSinceLastLoss' | 'roomCheckOiAgeSeconds'>;
  gateDiagnosticsFor: () => Promise<GateDiagnostic[]>;
  shadowModels: ReturnType<typeof computeShadowModels>;
  /** Momentum-break family only: the trigger, carried in the slot for LEVEL_RECLAIMED. */
  momentumBreak?: StoredMomentumBreak;
}): Promise<StoredTradeSetup> {
  const {
    underlying, exchange, mode, key, today, setupTtl, chain, fresh, direction, confidence, regime, intelligenceScore,
    voteSnapshot, entryContext, phase1Context, gateDiagnosticsFor, shadowModels,
  } = ctx;
  // Which rules and flags minted this setup — carried on the sticky setup and
  // written to signals.inputs.logic so pre- and post-review trades are never pooled.
  const logic = liveLogicStamp();
  const signalId = await recordTradeSetupGenerated(underlying, exchange, fresh, direction, confidence, regime, intelligenceScore, mode, voteSnapshot, entryContext, logic);

  logDecision({
    at: decisionNow(),
    symbol: underlying,
    exchange,
    mode,
    decision: "ENTER",
    code: "ENTERED",
    reason: fresh.reason ?? "Setup taken",
    regime,
    bias: direction,
    setupQuality: confidence,
    locationScore: entryContext?.locationScore ?? null,
    locationReason: entryContext?.locationReason ?? null,
    roomAvailableAtr: entryContext?.roomAvailableAtr ?? null,
    roomRequiredAtr: entryContext?.roomRequiredAtr ?? null,
    roomSufficient: entryContext?.roomSufficient ?? null,
    riskReward: fresh.riskReward ?? null,
    estimatedCostPct: fresh.estimatedCostPct ?? null,
    // What the not-yet-live gates would have said about this same trade.
    shadow: { room: entryContext?.roomSufficient !== false, location: (entryContext?.locationScore ?? 100) >= 40 },
  });
  // Generated here so the sticky setup can carry it: later stale/dead flags
  // and the eventual simulated close are written back to this same row.
  const takeDecisionId = randomUUID();
  {
    const blocks = snapshotBlocks(chain, entryContext, fresh, fresh.available ? fresh.side ?? null : null);
    const instrumentation = snapshotInstrumentation(exchange, entryContext, fresh);
    const takenLeg = fresh.strike != null && fresh.side ? findLeg(chain, fresh.strike, fresh.side) : null;
    recordDecisionSnapshot({
      ...instrumentation,
      ...phase1Context,
      decisionId: takeDecisionId,
      signalId: signalId ?? null,
      freshness: {
        timestamps: inputTimestampsFrom(chain, takenLeg),
        underlyingPriceAtGeneration: chain.spotPrice,
      },
      gateDiagnostics: gateDiagnosticsFor,
      shadowModels,
      // Simulated-portfolio accounting over the OTHER live sticky setups.
      // Read lazily after the row is written; never blocks or alters this setup.
      exposure: () => {
        const current = toExposureSetup(key, { ...fresh, direction, day: today }, today);
        return current ? readExposureAtCreation(current, today) : Promise.resolve(null);
      },
      symbol: underlying,
      exchange,
      mode,
      expiry: chain.expiry,
      decision: 'TAKE',
      reason: fresh.reason ?? 'Setup taken',
      regime,
      bias: direction,
      confidence,
      pcr: chain.pcrDetail?.oiPCR ?? null,
      underlyingPrice: chain.spotPrice,
      atr: entryContext?.atrPoints ?? null,
      setup: fresh,
      ...blocks,
    });
    captureUnderlyingObservation({
      at: decisionNow(),
      symbol: underlying,
      exchange,
      token: chain.underlying ?? underlying,
      ltp: chain.spotPrice,
      open: null,
      high: null,
      low: null,
      close: chain.spotPrice,
      volume: null,
      vwap: null,
      atr: entryContext?.atrPoints ?? null,
    });
  }

  const toStore: StoredTradeSetup = {
    ...fresh,
    direction,
    day: today,
    generatedAt: decisionNow(),
    signalId,
    initialStopLoss: fresh.stopLoss,
    voteSnapshot,
    entryContext,
    decisionId: takeDecisionId,
    underlyingAtGeneration: chain.spotPrice,
    logic,
    ...(ctx.momentumBreak ? { momentumBreak: ctx.momentumBreak } : {}),
  };
  try {
    await redis.set(key, JSON.stringify(toStore), 'EX', setupTtl);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Sticky trade setup write failed');
  }

  // Push exactly here and nowhere else. This branch is the ONLY one that
  // mints a genuinely new setup — every other path either returns a setup
  // already locked in Redis or backfills its database row, and hooking
  // those would re-notify the same setup on every poll. Fire-and-forget:
  // the notification is a side effect of the setup, never a precondition,
  // so a Telegram outage cannot stop a setup being generated.
  notifyTradeSetup({ underlying, exchange, mode, direction, confidence, setup: toStore });

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
  mode: TradingMode,
  votes?: BiasVoteSnapshot,
  context?: SetupEntryContext,
  logic: LogicStamp | null = null
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
            expiry: fresh.expiry ?? null,
            dte: fresh.dte ?? null,
            estimatedCostPct: fresh.estimatedCostPct ?? null,
            // Part A (flag FNO_VALIDATION): strike-by-delta, IV cap, cost, stop-noise and expiryFallback — present only when the flag was on.
            ...(fresh.fnoValidation ? { fnoValidation: fresh.fnoValidation } : {}),
            votes: votes ?? null,
            // Entry context (regime alignment, IV vs HV, VWAP distance, day
            // move, time into session, room to target) — so these can be
            // measured against outcomes instead of guessed at.
            context: context ?? null,
            // Validation review: logicVersion + the flag set (and tunables)
            // this setup was minted under. Null = minted before stamping.
            logic,
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

interface TradeCloseContext {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  reason: TradeCloseReason;
}

async function recordTradeSetupOutcome(
  stored: StoredTradeSetup,
  outcome: 'WIN' | 'LOSS' | 'EXPIRED',
  exitValue: number | null,
  close: TradeCloseContext
): Promise<void> {
  // A naked long's return% is the % change in the option's own premium.
  // A spread has no single "entry price" to measure against that way —
  // maxLoss (the capital genuinely at risk) is the meaningful reference,
  // so a spread's return% is P&L as a % of that risk instead.
  const isSpread = stored.structureType === 'SPREAD';
  let returnPercent: number | null = null;
  if (exitValue != null) {
    if (isSpread && stored.maxLoss != null && stored.maxLoss > 0 && stored.netPremium != null) {
      const pnl = exitValue - stored.netPremium;
      returnPercent = Math.round((pnl / stored.maxLoss) * 10000) / 100;
    } else if (stored.entry != null && stored.entry > 0) {
      returnPercent = Math.round(((exitValue - stored.entry) / stored.entry) * 10000) / 100;
    }
  }

  // No signalId: pre-dates Backtesting or failed to record on generation —
  // no row to update, but the position still closed, so it's still notified.
  if (stored.signalId) {
    try {
      await sql`
        UPDATE signals
        SET inputs = inputs || ${sql.json({
          outcome,
          exitPrice: exitValue,
          exitTime: decisionNow(),
          // Structured, not guessed: every exit says which kind it was.
          closeReason: close.reason,
          holdMinutes: stored.generatedAt ? Math.round((decisionNow() - stored.generatedAt) / 60000) : null,
          excursion: stored.excursion ? { ...stored.excursion } : null,
          healthAtExit: stored.health ? { ...stored.health } : null,
          // Validation review, fix 3 — measurement only, no fill change. How far
          // past the stop a losing exit filled, as a share of entry: the gap-
          // through part of the −1R average loser, separate from costs.
          ...(outcome === 'LOSS' ? { stopOvershootPct: stopOvershootPct(stored, exitValue) } : {}),
        })}, fwd_1d_return = ${returnPercent}
        WHERE id = ${stored.signalId}
      `;
    } catch (err: any) {
      logger.warn({ error: err.message, signalId: stored.signalId }, 'Backtesting: failed to record trade setup outcome');
    }
  }

  // A stop, recorded with the state that explains it, at the instant it
  // fires. Six of the seventeen historical stops are permanently unclassified
  // because the chain state that would have settled them was gone by the time
  // anyone looked; this is what stops that happening again. Historical
  // unknowns are not rewritten.
  if (close.reason === 'STOP_LOSS' || close.reason === 'TRAILING_STOP' || close.reason === 'BREAKEVEN_STOP') {
    recordStopEvent({
      setupId: stored.signalId ?? null,
      symbol: close.underlying,
      exchange: close.exchange,
      mode: close.mode,
      direction: stored.direction ?? null,
      // No live underlying price at this point in the close path; the entry
      // price and the excursion are what the classification actually needs.
      underlyingPrice: null,
      underlyingAtEntry: stored.excursion?.underlyingEntry ?? null,
      optionPrice: exitValue,
      entryPrice: stored.entry ?? null,
      stopPrice: stored.stopLoss ?? null,
      targetPrice: stored.target ?? null,
      atr: stored.excursion?.atrAtEntry ?? null,
      stopInAtr: stored.stopInAtr ?? null,
      targetInAtr: stored.targetInAtr ?? null,
      mfe: stored.excursion?.premiumMfe ?? null,
      mae: stored.excursion?.premiumMae ?? null,
      // The UNDERLYING excursion in its own ATR is what separates a broken
      // thesis from a decayed option, so it is derived here from the two
      // values the monitor folded forward rather than left to a later guess.
      mfeAtr:
        stored.excursion?.atrAtEntry && stored.excursion.atrAtEntry > 0
          ? stored.excursion.underlyingMfe / stored.excursion.atrAtEntry
          : null,
      maeAtr:
        stored.excursion?.atrAtEntry && stored.excursion.atrAtEntry > 0
          ? stored.excursion.underlyingMae / stored.excursion.atrAtEntry
          : null,
      holdMinutes: stored.generatedAt ? Math.round((decisionNow() - stored.generatedAt) / 60000) : null,
      marketRegime: stored.entryContext?.regime ?? null,
      setupType: stored.entryContext?.setupClassification?.setupType ?? null,
      tradeHealth: stored.health?.state ?? null,
      context: { closeReason: close.reason, outcome, returnPercent },
    });
  }

  const dedupeId = stored.signalId ?? `${close.exchange}:${close.underlying}:${close.mode}:${stored.generatedAt ?? 'unknown'}`;
  // Stop-loss hits only — see MAX_SAME_DIRECTION_LOSSES_PER_DAY for why a
  // losing bias-reversal exit doesn't start a cooldown.
  if (outcome === 'LOSS' && stored.direction !== 'NEUTRAL') {
    await registerLosingClose(close.exchange, close.underlying, close.mode, stored.direction, dedupeId);
  }

  // R against the stop the trade was OPENED with — a trailed stop would
  // understate the risk actually taken.
  const initialStop = stored.initialStopLoss ?? stored.stopLoss;
  const riskPct =
    !isSpread && stored.entry != null && stored.entry > 0 && initialStop != null ? ((stored.entry - initialStop) / stored.entry) * 100 : null;
  const rMultiple = returnPercent != null && riskPct != null && riskPct > 0 ? Math.round((returnPercent / riskPct) * 100) / 100 : null;

  // Phase 1: backfill how this SIMULATED position closed onto the TAKE
  // decision that minted it, in the explicit exit-reason vocabulary, with the
  // same gross R the notifier below reports. Fire-and-forget; analytics only.
  void recordEventualOutcome({ decisionId: stored.decisionId, signalId: stored.signalId }, exitReasonFromCloseReason(close.reason), close.reason, rMultiple);
  // Phase 2: which of the two already-separate close branches fired (premium
  // stop/target, evaluated first; or the bias-reversal branch). Labels the
  // close reason that branch already set — no new condition. Analytics only.
  void recordInvalidationReason({ decisionId: stored.decisionId, signalId: stored.signalId }, invalidationReasonFromCloseReason(close.reason));

  notifyTradeSetupClosed({
    ...close,
    outcome,
    side: stored.side ?? null,
    strike: stored.strike ?? null,
    expiry: stored.expiry ?? null,
    strategy: stored.strategy ?? null,
    entry: isSpread ? stored.netPremium ?? null : stored.entry ?? null,
    exitPrice: exitValue,
    returnPercent,
    rMultiple,
    generatedAt: stored.generatedAt ?? null,
    dedupeId,
  });
}

function closeReasonForPriceHit(stored: StoredTradeSetup, isSpread: boolean, hitTarget: boolean): TradeCloseReason {
  if (hitTarget) return 'TARGET';
  if (isSpread) return 'STOP_LOSS';
  return stored.stopLoss! > stored.entry! ? 'TRAILING_STOP' : stored.stopLoss! === stored.entry! ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
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
function legLtpOrNull(chain: OptionChain | null, strike: number, side: 'CE' | 'PE'): number | null {
  if (!chain) return null;
  const ltp = findLeg(chain, strike, side)?.ltp;
  return ltp != null && ltp > 0 ? ltp : null;
}

/**
 * The chain a locked setup must be priced from: its own expiry's. The chain
 * a poll builds is the nearest expiry (INTRADAY) or a DTE-window pick that
 * slides over the days (POSITIONAL), so once that rolls to a different
 * expiry the same strike is a DIFFERENT contract at a different premium —
 * reading it would record a stop/target hit or exit price from a contract
 * the setup never held. Returns null when the setup's own contract can't be
 * priced (e.g. expired and delisted: buildOptionChain falls back to the
 * nearest listed expiry instead), which leaves the setup unresolved by price
 * rather than resolved off the wrong contract. Setups locked before expiry
 * was recorded keep the old behaviour.
 */
async function chainForStoredSetup(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  chain: OptionChain,
  stored: StoredTradeSetup
): Promise<OptionChain | null> {
  if (!stored.expiry || stored.expiry === chain.expiry) return chain;
  try {
    const own = await buildOptionChain(provider, underlying, exchange, stored.expiry);
    return own.expiry === stored.expiry ? own : null;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, expiry: stored.expiry }, 'Locked setup: own-expiry option chain unavailable — not pricing it off another expiry');
    return null;
  }
}

/** Mark-to-market value of a stored setup right now — a single leg's LTP for a naked long, or the net cost-to-close for a spread. Null if any required leg's quote (or the setup's own chain) is currently unavailable. */
function currentExitValue(chain: OptionChain | null, stored: StoredTradeSetup): number | null {
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
// A live tick more than this far from the chain's quote (cached ≤10s) for
// the same contract is treated as bad data, not a real move.
const TICK_SANITY_MIN_RATIO = 0.5;
const TICK_SANITY_MAX_RATIO = 2;

/** What the monitor needs to watch a still-open naked long on the live tick feed. */
export interface LockedSetupWatch {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  /** The option contract's instrument token — the exact strike, side and expiry the setup holds. */
  token: string;
  stopLoss: number;
  target: number;
}

/**
 * Checks one locked setup's SL/target against its own contract and closes
 * it if either was hit. Returns what to watch on the tick feed while it
 * stays open (naked longs only), or null once it's closed or can't be
 * priced. `observedLtp` is a live tick price that triggered this check — it
 * is used instead of the chain's LTP, which can be up to 10s stale.
 *
 * POSITIONAL setups are covered too now that every setup records its
 * expiry — they used to be excluded because this always fetched the
 * nearest expiry. A positional setup from before expiry was recorded is
 * still skipped (can't be priced safely). Positional setups don't roll
 * over at the day's end.
 */
export async function checkLockedSetupPriceLevels(
  provider: MarketDataProvider,
  exchange: Exchange,
  underlying: string,
  mode: TradingMode = 'INTRADAY',
  observedLtp?: number
): Promise<LockedSetupWatch | null> {
  const key = `trade_setup:${exchange}:${underlying}:${mode}`;

  let stored: StoredTradeSetup | null = null;
  try {
    const raw = await redis.get(key);
    if (raw) stored = JSON.parse(raw) as StoredTradeSetup;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Price-level monitor: sticky setup read failed');
    return null;
  }

  if (!stored?.available) return null;
  if (mode === 'POSITIONAL' && !stored.expiry) return null;

  let chain: OptionChain;
  try {
    // The setup's own expiry, not the nearest — see chainForStoredSetup.
    chain = await buildOptionChain(provider, underlying, exchange, stored.expiry);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying }, 'Price-level monitor: option chain fetch failed — will retry next tick');
    return null;
  }

  // buildOptionChain falls back to the nearest listed expiry when the one
  // asked for is gone — never price this setup off that other contract.
  const pricingChain = !stored.expiry || chain.expiry === stored.expiry ? chain : null;

  const today = decisionIstDate();
  if (mode === 'INTRADAY' && stored.day !== today) {
    // A prior-day INTRADAY setup used to just get silently skipped here —
    // day-rollover EXPIRY only ever happened in resolveStickyTradeSetup's
    // ON-DEMAND path, which never runs for a symbol nobody revisits the
    // next day. That setup's Redis key eventually vanished on its own TTL
    // (2 days) with no outcome ever recorded, leaving its Backtesting row
    // permanently stuck showing "open" — found via a live DB/Redis
    // comparison: 32 DB rows had no outcome, but only 9 were still backed
    // by a real Redis key; the other 23 were exactly this. Same close-out
    // resolveStickyTradeSetup itself uses for a same-poll day rollover.
    await recordTradeSetupOutcome(stored, 'EXPIRED', currentExitValue(pricingChain, stored), { underlying, exchange, mode: 'INTRADAY', reason: 'SESSION_ENDED' });
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ error: err.message, underlying }, 'Price-level monitor: stale-day sticky setup clear failed');
    }
    logger.info({ underlying, exchange }, 'Price-level monitor: closed a prior-day setup nobody had revisited');
    return null;
  }

  const isSpread = stored.structureType === 'SPREAD';
  let currentValue: number | null;
  let hitSL: boolean;
  let hitTarget: boolean;
  let watch: LockedSetupWatch | null = null;

  if (isSpread && stored.legs && stored.netPremium != null && stored.maxProfit != null && stored.maxLoss != null) {
    const legPrices = stored.legs.map((l) => ({ action: l.action, price: legLtpOrNull(pricingChain, l.strike, l.side) }));
    const progress = evaluateSpreadProgress(legPrices, stored.netPremium, stored.maxProfit, stored.maxLoss);
    currentValue = progress.currentValue;
    hitSL = progress.hitStop;
    hitTarget = progress.hitTarget;
  } else if (!isSpread && stored.strike != null && stored.side && stored.stopLoss != null && stored.target != null) {
    // A tick price is only trusted when it's plausibly the same contract's
    // price as the chain's own quote. A tick decoder bug once made every
    // first tick a huge number, closing open setups as WINs at their
    // targets — a price-level close must never rest on one unchecked tick.
    const chainLtp = legLtpOrNull(pricingChain, stored.strike, stored.side);
    const tickUsable =
      observedLtp != null && observedLtp > 0 && (chainLtp == null || (observedLtp >= chainLtp * TICK_SANITY_MIN_RATIO && observedLtp <= chainLtp * TICK_SANITY_MAX_RATIO));
    if (observedLtp != null && !tickUsable) {
      logger.warn({ underlying, exchange, observedLtp, chainLtp }, 'Price-level monitor: tick price implausible vs chain quote — ignored');
    }
    const currentLtp = tickUsable ? observedLtp! : chainLtp;
    currentValue = currentLtp;
    hitSL = currentLtp != null && currentLtp <= stored.stopLoss;
    hitTarget = currentLtp != null && currentLtp >= stored.target;
    const token = pricingChain ? findLeg(pricingChain, stored.strike, stored.side)?.token : undefined;
    if (token) watch = { underlying, exchange, mode, token, stopLoss: stored.stopLoss, target: stored.target };
  } else {
    return null;
  }

  // --- Excursion + trade health (observational) --------------------------
  // Runs on every sweep and every tick. Nothing here closes a position: the
  // health engine records what it WOULD do so the rule can be judged against
  // real outcomes first (see trade-health.ts).
  if (!isSpread && stored.entry != null && stored.entry > 0) {
    const bullish = stored.side !== 'PE';
    const generatedAt = stored.generatedAt ?? decisionNow();
    const base = stored.excursion ?? emptyExcursion(pricingChain?.spotPrice ?? null, stored.entryContext?.atrPoints ?? null, stored.entry);
    const { excursion, changed } = updateExcursion(base, {
      premium: currentValue,
      underlying: pricingChain?.spotPrice ?? null,
      entryPremium: stored.entry,
      initialStop: stored.initialStopLoss ?? stored.stopLoss ?? null,
      bullish,
      at: decisionNow(),
      generatedAt,
    });

    const elapsedMinutes = Math.max(0, (decisionNow() - generatedAt) / 60000);
    const health = assessTradeHealth({
      elapsedMinutes,
      horizonMinutes: mode === 'POSITIONAL' ? (stored.dte ?? 1) * 375 : remainingSessionMinutesFrom(exchange, generatedAt),
      mfeAtr: mfeInAtr(excursion),
      currentProgressAtr:
        excursion.atrAtEntry && excursion.atrAtEntry > 0 && excursion.underlyingEntry && pricingChain?.spotPrice
          ? ((bullish ? pricingChain.spotPrice - excursion.underlyingEntry : excursion.underlyingEntry - pricingChain.spotPrice) / excursion.atrAtEntry)
          : null,
      targetAtr: stored.targetInAtr ?? null,
      premiumRatio: currentValue != null && stored.entry > 0 ? currentValue / stored.entry : null,
    });

    const healthChanged = stored.health?.state !== health.state;
    if (changed || healthChanged) {
      const updated: StoredTradeSetup = {
        ...stored,
        excursion,
        health: { state: health.state, score: health.score, wouldExit: health.wouldExit, reason: health.reason, at: decisionNow() },
      };
      stored = updated;
      try {
        await redis.set(key, JSON.stringify(updated), 'EX', mode === 'POSITIONAL' ? STICKY_TRADE_SETUP_TTL_SECONDS_POSITIONAL : STICKY_TRADE_SETUP_TTL_SECONDS);
      } catch (err: any) {
        logger.warn({ error: err.message, underlying }, 'Trade health: excursion write failed');
      }
    }
    if (healthChanged) {
      logShadowHealth(underlying, exchange, mode, health, elapsedMinutes, excursion);
      // Phase 1: persist the first DEAD reading against the TAKE decision
      // (write-once in SQL). Analytics only — the position stays open.
      const dead = deadTradeMarker(health, excursion, decisionNow());
      if (dead && stored.decisionId) {
        void markDecisionDead(stored.decisionId, dead.deadAt, dead.mfeAtDeadAtr, dead.maeAtDeadAtr);
      }
    }
  }

  if (!hitSL && !hitTarget) return watch;

  const outcome = classifyPriceHitOutcome(stored, isSpread, hitTarget);
  await recordTradeSetupOutcome(stored, outcome, exitValueForPriceHit(stored, isSpread, hitTarget, currentValue), {
    underlying,
    exchange,
    mode,
    reason: closeReasonForPriceHit(stored, isSpread, hitTarget),
  });
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
  logger.info(
    { underlying, exchange, mode, outcome, viaTick: observedLtp != null },
    'Price-level monitor: closed a locked setup that hit SL/target between on-demand checks'
  );
  return null;
}

/**
 * Every entry decision, taken or refused, as one structured line. Skipped
 * trades were previously invisible: the engine explained itself in prose to
 * whoever happened to be looking at the tab, and nothing counted them. These
 * are what the next review reads to ask "what did we turn down, and should we
 * have?".
 */
/**
 * The raw blocks a decision snapshot records, assembled from whatever the
 * decision actually had in scope.
 *
 * Kept separate from logDecision because the log line is for a human reading
 * production logs and the snapshot is for research six months from now. They
 * want different things: the log wants the short reason, the snapshot wants
 * the observation the reason was derived from, including the parts no rule
 * currently reads.
 */
/**
 * The instrumentation fields both decision sites record identically.
 *
 * `shadowWouldRefuse` is what the not-yet-live layers TOGETHER would have
 * concluded — location below its cramped threshold, or room insufficient, or
 * the option graded poor. It is written to the record, compared against what
 * live actually did, and consulted by nothing. Null when none of the shadow
 * layers produced a reading, which is a different fact from "they agreed"
 * and is stored as one.
 */
function snapshotInstrumentation(
  exchange: Exchange,
  entryContext: SetupEntryContext | undefined,
  setup: TradeSetup | null
): {
  setupTag: { setupType: string; setupFamily: string; primaryTrigger: string; detail: Record<string, unknown> } | null;
  minutesFromSessionOpen: number | null;
  sessionBucket: string | null;
  targetAtr: number | null;
  stopAtr: number | null;
  shadow: { wouldRefuse: boolean | null; reasons: string[] } | null;
} {
  const cls = entryContext?.setupClassification ?? null;
  const minutes = minutesSinceSessionOpen(exchange);

  const reasons: string[] = [];
  let anyShadowReading = false;
  if (entryContext?.locationScore != null) {
    anyShadowReading = true;
    if (entryContext.locationScore < 40) reasons.push('POOR_LOCATION');
  }
  if (entryContext?.roomSufficient != null) {
    anyShadowReading = true;
    if (entryContext.roomSufficient === false) reasons.push('INSUFFICIENT_ROOM');
  }
  const grade = setup?.available ? setup.optionQuality?.grade ?? null : null;
  if (grade != null) {
    anyShadowReading = true;
    if (grade === 'POOR' || grade === 'UNTRADEABLE') reasons.push('POOR_OPTION_QUALITY');
  }

  return {
    setupTag: cls
      ? {
          setupType: cls.setupType,
          setupFamily: cls.setupFamily,
          primaryTrigger: cls.primaryTrigger,
          detail: { ...cls.detail, allTriggers: cls.allTriggers },
        }
      : null,
    minutesFromSessionOpen: minutes,
    sessionBucket: sessionBucket(minutes),
    targetAtr: setup?.available ? setup.targetInAtr ?? null : null,
    stopAtr: setup?.available ? setup.stopInAtr ?? null : null,
    shadow: anyShadowReading ? { wouldRefuse: reasons.length > 0, reasons } : null,
  };
}

/**
 * Phase 2 SHADOW models for one freshly built setup: the strike a candidate
 * scorer would have picked, the same paper trade entered at the ask, and a
 * gamma/theta-aware target. Every input is a value the live path already
 * computed; the output goes to the decision snapshot and nowhere else — it is
 * never merged into the setup, the sticky cache, or any gate. Never throws:
 * a failure here is logged and records nothing.
 */
function computeShadowModels(
  setup: TradeSetup,
  chain: OptionChain,
  direction: BiasDirection,
  expectedMovePoints: number,
  expectedHoldHours: number,
  ctx: { ivRank: number | null; hvPct: number | null; underlying: string }
): { strikeSelection: ShadowStrikeSelection | null; execution: ExecutionQualityResult | null; targetV2: TargetEstimateResult | null } | null {
  if (!setup.available || setup.structureType !== 'NAKED_LONG' || direction === 'NEUTRAL') return null;
  if (setup.strike == null || !setup.side || setup.entry == null || setup.stopLoss == null || setup.target == null) return null;
  try {
    const leg = findLeg(chain, setup.strike, setup.side);
    const strikeSelection = scoreStrikeCandidates({
      strikes: chain.strikes,
      liveStrike: chain.atmStrike,
      side: setup.side,
      expiry: chain.expiry,
      expectedMovePoints,
      dte: chain.dte,
      expectedHoldHours,
      ivRank: ctx.ivRank,
      hvPct: ctx.hvPct,
      tickSize: 0.05,
    });
    const execution = assessExecutionQuality({
      bid: leg?.bid,
      ask: leg?.ask,
      ltp: leg?.ltp,
      liveEntry: setup.entry,
      stopLoss: setup.stopLoss,
      target: setup.target,
      lotSize: chain.lotSize,
    });
    const targetV2 = leg
      ? estimateTargetV2({
          entry: setup.entry,
          stopLoss: setup.stopLoss,
          liveTarget: setup.target,
          delta: leg.delta,
          gamma: leg.gamma,
          theta: leg.theta,
          expectedMovePoints,
          expectedHoldHours,
          bid: leg.bid,
          ask: leg.ask,
          lotSize: chain.lotSize,
        })
      : null;
    return { strikeSelection, execution, targetV2 };
  } catch (err: any) {
    logger.warn({ error: err.message, underlying: ctx.underlying }, 'Phase 2 shadow models: evaluation failed — nothing recorded for them');
    return null;
  }
}

function snapshotBlocks(
  chain: OptionChain | null,
  entryContext: SetupEntryContext | undefined,
  setup: TradeSetup | null,
  side: 'CE' | 'PE' | null
): {
  option: Record<string, unknown>;
  underlying: Record<string, unknown>;
  market: Record<string, unknown>;
  location: Record<string, unknown>;
  room: Record<string, unknown>;
  risk: Record<string, unknown>;
} {
  const strike = setup?.available ? setup.strike : chain?.atmStrike;
  const row = chain?.strikes.find((st) => st.strike === strike);
  const leg = side === 'PE' ? row?.put : row?.call;

  return {
    option: {
      symbol: leg?.token ?? null,
      strike: strike ?? null,
      side,
      ltp: leg?.ltp ?? null,
      bid: leg?.bid ?? null,
      ask: leg?.ask ?? null,
      volume: leg?.volume ?? null,
      oi: leg?.oi ?? null,
      changeOi: leg?.changeOi ?? null,
      changeOiBaseline: leg?.changeOiBaseline ?? null,
      iv: leg?.iv ?? null,
      delta: leg?.delta ?? null,
      gamma: leg?.gamma ?? null,
      theta: leg?.theta ?? null,
      vega: leg?.vega ?? null,
      moneyness: leg?.moneyness ?? null,
      greeksSource: leg?.greeksSource ?? null,
      oiInterpretation: leg?.oiInterpretation ?? null,
      dte: chain?.dte ?? null,
      expiry: chain?.expiry ?? null,
      quality: setup?.available ? setup.optionQuality ?? null : null,
    },
    underlying: {
      spot: chain?.spotPrice ?? null,
      changePercent: chain?.underlyingChangePercent ?? null,
      atrPoints: entryContext?.atrPoints ?? null,
      vwapDeviationPct: entryContext?.vwapDeviationPct ?? null,
      todayChangePct: entryContext?.todayChangePct ?? null,
      volumeRatio: entryContext?.volumeRatio ?? null,
      volumeSource: entryContext?.volumeSource ?? null,
      minutesSinceOpen: entryContext?.minutesSinceOpen ?? null,
    },
    market: {
      regime: entryContext?.regime ?? null,
      regimeAlignment: entryContext?.regimeAlignment ?? null,
      biasConfidence: entryContext?.biasConfidence ?? null,
      setupConfidence: entryContext?.setupConfidence ?? null,
      atmIvPct: entryContext?.atmIvPct ?? null,
      hvPct: entryContext?.hvPct ?? null,
      ivVsHv: entryContext?.ivVsHv ?? null,
      ivVsHvSpreadPct: entryContext?.ivVsHvSpreadPct ?? null,
      pcr: chain?.pcrDetail?.oiPCR ?? null,
      maxPain: chain?.maxPain ?? null,
      optionOiBaselineCoverage: entryContext?.optionOiBaselineCoverage ?? null,
      // Coverage/lag round (JSON inside the existing `market` jsonb column).
      positioningBaseline: entryContext?.positioningBaseline ?? null,
      regimeSource: entryContext?.regimeSource ?? null,
      adx15m: entryContext?.adx15m ?? null,
      breakoutPersistBarsAgo: entryContext?.breakoutPersistBarsAgo ?? null,
    },
    location: {
      score: entryContext?.locationScore ?? null,
      aheadAtr: entryContext?.locationAheadAtr ?? null,
      behindAtr: entryContext?.locationBehindAtr ?? null,
      aheadKind: entryContext?.locationAheadKind ?? null,
      reason: entryContext?.locationReason ?? null,
      behindLevel: entryContext?.locationBehindLevel ?? null,
      behindKind: entryContext?.locationBehindKind ?? null,
    },
    room: {
      availableAtr: entryContext?.roomAvailableAtr ?? null,
      requiredAtr: entryContext?.roomRequiredAtr ?? null,
      ratio:
        entryContext?.roomAvailableAtr != null && entryContext?.roomRequiredAtr
          ? entryContext.roomAvailableAtr / entryContext.roomRequiredAtr
          : null,
      sufficient: entryContext?.roomSufficient ?? null,
      levelPoints: entryContext?.roomToTargetPoints ?? null,
      level: entryContext?.roomLevel ?? null,
      levelSource: entryContext?.roomLevelSource ?? null,
      // Validation review, fix 2: the corrected measure (target actually used).
      requiredAtrV2: entryContext?.roomRequiredAtrV2 ?? null,
      sufficientV2: entryContext?.roomSufficientV2 ?? null,
    },
    risk: {
      stopInAtr: setup?.available ? setup.stopInAtr ?? null : null,
      targetInAtr: setup?.available ? setup.targetInAtr ?? null : null,
      estimatedCostPct: setup?.available ? setup.estimatedCostPct ?? null : null,
      riskReward: setup?.available ? setup.riskReward ?? null : null,
      lots: setup?.available ? setup.positionSize?.lots ?? null : null,
      // Validation review, fixes 1 and 6 (absent when those flags were off).
      structuralStop: setup?.structuralStop ?? null,
      stopBeforeStructure: setup?.stopBeforeStructure ?? null,
      requiredRiskReward: setup?.requiredRiskReward ?? null,
    },
  };
}

function logDecision(decision: TradeDecision): void {
  logger.info(
    { tradeDecision: decision },
    decision.decision === 'ENTER' ? `Trade decision: ENTER ${decision.symbol}` : `Trade decision: SKIP ${decision.symbol} (${decision.code})`
  );
}

/** Minutes left in the session from a trade's entry — its realistic horizon. */
function remainingSessionMinutesFrom(exchange: Exchange, generatedAt: number): number {
  const day = new Date(generatedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const session = getSessionWindow(exchange, day);
  if (!session) return 375;
  return Math.max(30, (session.close - generatedAt) / 60000);
}

/**
 * Shadow log for the time-stop. Every state change is recorded with what the
 * rule would have done, so its value can be measured before it is allowed to
 * close anything.
 */
function logShadowHealth(underlying: string, exchange: Exchange, mode: TradingMode, health: TradeHealthAssessment, elapsedMinutes: number, excursion: TradeExcursion): void {
  logger.info(
    {
      shadow: 'TRADE_HEALTH',
      underlying,
      exchange,
      mode,
      state: health.state,
      score: health.score,
      wouldExit: health.wouldExit,
      elapsedMinutes: Math.round(elapsedMinutes),
      mfeAtr: mfeInAtr(excursion),
      progressRatio: health.progressRatio,
      reason: health.reason,
    },
    health.wouldExit ? 'Trade health: a time-stop WOULD close this position (shadow only)' : 'Trade health: state changed'
  );
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
  // Was 3 attempts from 1.5s. The provider already retries a rate-limited
  // request 3 times, so this stacked into as many as 12 broker calls for one
  // candle series — in the middle of a rate-limit storm.
  attempts = 2,
  initialDelayMs = 3000
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

// --- Trade-quality context ---

type RegimeAlignment = 'WITH_TREND' | 'AGAINST_STRONG_TREND' | 'AGAINST_WEAK_TREND' | 'RANGE' | 'NO_TREND';

// Multiplier on bias confidence for the setup gate (MIN_CONFIDENCE). With
// the trend, or in a regime with no trend to fight (high volatility,
// expiry-day gamma — the latter averaged +0.77R live), nothing changes.
const REGIME_CONFIDENCE_FACTOR: Record<RegimeAlignment, number> = {
  WITH_TREND: 1,
  NO_TREND: 1,
  AGAINST_WEAK_TREND: 0.9,
  AGAINST_STRONG_TREND: 0.8,
  RANGE: 0.9,
};

// An OI wall below this strength (vs the strongest wall on its side) isn't
// treated as an obstacle to the target.
const OI_WALL_MIN_STRENGTH_PCT = 70;

interface SetupEntryContext {
  regime: MarketRegime;
  regimeAlignment: RegimeAlignment;
  biasConfidence: number;
  setupConfidence: number;
  ivVsHv: string;
  ivVsHvSpreadPct: number | null;
  atmIvPct: number | null;
  hvPct: number | null;
  vwapDeviationPct: number | null;
  todayChangePct: number;
  minutesSinceOpen: number | null;
  volumeRatio: number;
  volumeSource: string;
  roomToTargetPoints: number | null;
  /** ATR of the underlying on this read's short tier, in points — the scale a stop or target should be judged against. */
  atrPoints: number | null;
  /** Location quality at entry (shadow — recorded, not yet gating). See location-quality.ts. */
  locationScore: number | null;
  locationAheadAtr: number | null;
  locationBehindAtr: number | null;
  locationAheadKind: string | null;
  locationReason: string | null;
  /** Validation review: price and kind of assessLocation's nearestBehind — what the structural stop sits beyond. */
  locationBehindLevel?: number | null;
  locationBehindKind?: string | null;
  /** The underlying price the location was read at. */
  locationSpot?: number | null;
  /** Validation review, fix 2: room measured against the target ACTUALLY used (post room-cap), in ATR. */
  roomRequiredAtrV2?: number | null;
  roomSufficientV2?: boolean | null;
  /**
   * What the engine detected, named. Written to the decision record and read
   * by nothing — see setup-classifier. Optional so a decision made before
   * classification is available still records cleanly as UNKNOWN.
   */
  setupClassification?: SetupClassification | null;
  /** Room to run versus what the target needs, in ATR (shadow). */
  roomAvailableAtr?: number | null;
  roomRequiredAtr?: number | null;
  roomSufficient?: boolean | null;
  roomLevel: number | null;
  roomLevelSource: 'CALL_WALL' | 'PUT_WALL' | 'PIVOT' | null;
  optionOiBaselineCoverage: number;
  /** Phase 1: strategy taxonomy over already-computed readings. Recorded, read by nothing. */
  strategyLabels?: StrategyLabelResult | null;
  /** Phase 1: the ten weighted dimensions behind the intelligence score, as computed. */
  voteContributions?: VoteContributions | null;
  /** Phase 1: the chart-vote net the direction was read from. */
  directionScore?: number | null;
  /** Phase 1: the pre-regime weighted intelligence score. */
  setupQualityScore?: number | null;
  /** Phase 3 (spec §15) — classifyRegime()'s own ADX input, carried through so opening-classifier.ts can reuse it instead of recomputing. */
  adxValue?: number | null;
  /** Phase 3 (spec §15) — classifyRegime()'s own atrZ (atrPctZ) input. */
  atrZ?: number | null;
  /** Phase 3 (spec §15) — classifyRegime()'s own fresh-breakout flags. */
  freshBreakoutUp?: boolean;
  freshBreakoutDown?: boolean;
  /** Phase 3 (spec §20) — age in seconds of the chain-fetch OI data roomToTarget() filtered candidates by. */
  roomCheckOiAgeSeconds?: number | null;
  /** Coverage/lag round — per positioning input, the intraday window or the previous close. */
  positioningBaseline?: PositioningBaselines;
  /** Coverage/lag round — '1H' (classifyRegime as before), '15M_FALLBACK' or 'BREAKOUT_PERSIST'. */
  regimeSource?: RegimeSource;
  /** ADX(14) on the 15m candles when FAST_INTRADAY_REGIME computed it. */
  adx15m?: number | null;
  /** Bars since the volume-confirmed break a held BREAKOUT/BREAKDOWN regime rests on. */
  breakoutPersistBarsAgo?: number | null;
  /** Momentum-break round: the trigger a MOMENTUM_BREAK setup (or refusal) was built from. */
  momentumBreak?: StoredMomentumBreak | null;
}

function regimeAlignment(direction: BiasDirection, regime: MarketRegime): RegimeAlignment {
  if (direction === 'NEUTRAL') return 'NO_TREND';
  switch (regime) {
    case 'RANGE_BOUND':
    case 'LOW_VOLATILITY':
      return 'RANGE';
    case 'STRONG_BULL_TREND':
    case 'BREAKOUT':
    case 'OPERATOR_ACCUMULATION':
      return direction === 'BULLISH' ? 'WITH_TREND' : 'AGAINST_STRONG_TREND';
    case 'STRONG_BEAR_TREND':
    case 'BREAKDOWN':
    case 'OPERATOR_DISTRIBUTION':
      return direction === 'BEARISH' ? 'WITH_TREND' : 'AGAINST_STRONG_TREND';
    case 'WEAK_BULL_TREND':
      return direction === 'BULLISH' ? 'WITH_TREND' : 'AGAINST_WEAK_TREND';
    case 'WEAK_BEAR_TREND':
      return direction === 'BEARISH' ? 'WITH_TREND' : 'AGAINST_WEAK_TREND';
    default:
      return 'NO_TREND';
  }
}

/**
 * Distance from spot to the nearest obstacle in the trade's direction: a
 * strong OI wall (call wall above for a bullish trade, put wall below for a
 * bearish one) or a prior-session pivot (R1-R3 / S1-S3). Null when nothing
 * stands in the way. Levels price has already crossed don't count, so a
 * break through a wall opens room to the next one.
 */
function roomToTarget(
  direction: BiasDirection,
  spot: number,
  callLevels: OiLevel[],
  putLevels: OiLevel[],
  pivots: { r1: number; r2: number; r3: number; s1: number; s2: number; s3: number } | null
): { points: number; level: number; source: 'CALL_WALL' | 'PUT_WALL' | 'PIVOT' } | null {
  if (direction === 'NEUTRAL' || !(spot > 0)) return null;
  const bullish = direction === 'BULLISH';
  const candidates: Array<{ level: number; source: 'CALL_WALL' | 'PUT_WALL' | 'PIVOT' }> = [];
  const walls = bullish ? callLevels : putLevels;
  for (const wall of walls) {
    if (wall.strengthPct >= OI_WALL_MIN_STRENGTH_PCT && (bullish ? wall.strike > spot : wall.strike < spot)) {
      candidates.push({ level: wall.strike, source: bullish ? 'CALL_WALL' : 'PUT_WALL' });
    }
  }
  if (pivots) {
    for (const level of bullish ? [pivots.r1, pivots.r2, pivots.r3] : [pivots.s1, pivots.s2, pivots.s3]) {
      if (Number.isFinite(level) && (bullish ? level > spot : level < spot)) candidates.push({ level, source: 'PIVOT' });
    }
  }
  if (candidates.length === 0) return null;
  const nearest = candidates.reduce((a, b) => (Math.abs(b.level - spot) < Math.abs(a.level - spot) ? b : a));
  return { points: Math.abs(nearest.level - spot), level: nearest.level, source: nearest.source };
}

function formatRoomSource(source: SetupEntryContext['roomLevelSource']): string {
  return source === 'CALL_WALL' ? 'call OI wall' : source === 'PUT_WALL' ? 'put OI wall' : 'pivot';
}

// --- Vote hold bands (hysteresis) ---
const RSI_HOLD_BAND = 3; // RSI points inside the entry threshold a vote holds through
const FUTURES_MOVE_ENTER_PCT = 0.1; // futures day move to start counting as a side
const FUTURES_MOVE_HOLD_PCT = 0.02;
const MACD_ENTER_PCT = 0.005; // histogram as % of price
const VOTE_STATE_TTL_SECONDS = 20 * 60; // an older state is stale — votes start fresh
const VOTE_STATE_TTL_SECONDS_POSITIONAL = 4 * 60 * 60;
// Minimum share of chain legs measured from the previous close before the
// option OI flow uses only those legs.
const OPTION_OI_MIN_PREV_CLOSE_COVERAGE = 0.5;

type ThresholdVoteState = Partial<Record<'vwap' | 'rsi' | 'futuresOi' | 'pcr' | 'optionOiFlow' | 'macd' | 'bollinger', Vote>>;

// bandVote (the hysteresis rule itself) lives in vote-bands.ts, shared with
// the intraday positioning window.

// --- Intraday positioning window: the snapshot rows ---
// One indexed read per capture table (idx_futures_symbol, idx_pcr_symbol,
// idx_oi_snapshots_capture), bounded to [now - window, now] so a replay never
// sees a row from after its decision instant. Cached for the minute, so every
// caller polling the same symbol inside one poll shares one read. A failed
// read is logged and returns nothing, which makes every input fall back to
// its day-level vote — the pre-flag behaviour.
const INTRADAY_POSITIONING_ROWS_CACHE_TTL_SECONDS = 60;

async function loadIntradayPositioningRows(args: {
  exchange: Exchange;
  underlying: string;
  futuresToken: string | null;
  expiry: string | null;
  now: number;
  windowMin: number;
}): Promise<{ futures: FuturesSnapshotPoint[]; pcr: PcrSnapshotPoint[]; legs: OptionLegSnapshotPoint[] }> {
  const empty = { futures: [], pcr: [], legs: [] };
  const from = new Date(args.now - args.windowMin * 60_000);
  const to = new Date(args.now);
  const minuteBucket = Math.floor(args.now / 60_000);
  const key = `intraday_positioning_rows:${args.exchange}:${args.underlying}:${args.futuresToken ?? '-'}:${args.expiry ?? '-'}:${args.windowMin}:${minuteBucket}`;
  try {
    return await cached(key, INTRADAY_POSITIONING_ROWS_CACHE_TTL_SECONDS, async () => {
      const [futuresRows, pcrRows, legRows] = await Promise.all([
        args.futuresToken
          ? sql<{ time: Date; price: string | null; oi: string | null }[]>`
              SELECT time, COALESCE(futures_price, ltp) AS price, oi
              FROM futures_snapshots
              WHERE symbol = ${args.underlying} AND exchange = ${args.exchange} AND token = ${args.futuresToken}
                AND time >= ${from} AND time <= ${to}
              ORDER BY time ASC
            `
          : Promise.resolve([]),
        args.expiry
          ? sql<{ time: Date; oi_pcr: string | null }[]>`
              SELECT time, oi_pcr
              FROM pcr_history
              WHERE symbol = ${args.underlying} AND expiry = ${args.expiry}
                AND time >= ${from} AND time <= ${to}
              ORDER BY time ASC
            `
          : Promise.resolve([]),
        args.expiry
          ? sql<{ time: Date; strike: string; option_type: 'CE' | 'PE'; oi: string | null; ltp: string | null }[]>`
              SELECT time, strike, option_type, oi, ltp
              FROM oi_snapshots
              WHERE symbol = ${args.underlying} AND expiry = ${args.expiry} AND exchange = ${args.exchange}
                AND time >= ${from} AND time <= ${to}
              ORDER BY time ASC
            `
          : Promise.resolve([]),
      ]);
      const ms = (t: Date | string) => new Date(t).getTime();
      return {
        futures: futuresRows
          .map((r) => ({ time: ms(r.time), price: Number(r.price), oi: Number(r.oi) }))
          .filter((p) => Number.isFinite(p.price) && Number.isFinite(p.oi)),
        pcr: pcrRows.map((r) => ({ time: ms(r.time), oiPcr: Number(r.oi_pcr) })).filter((p) => Number.isFinite(p.oiPcr)),
        legs: legRows
          .filter((r) => r.option_type === 'CE' || r.option_type === 'PE')
          .map((r) => ({ time: ms(r.time), strike: Number(r.strike), optionType: r.option_type, oi: Number(r.oi), ltp: Number(r.ltp) }))
          .filter((p) => Number.isFinite(p.strike) && Number.isFinite(p.oi) && Number.isFinite(p.ltp)),
      };
    });
  } catch (err: any) {
    logger.warn(
      { error: err.message, underlying: args.underlying, exchange: args.exchange },
      'Intraday positioning: snapshot read failed — every positioning input uses its day-level vote this poll'
    );
    return empty;
  }
}

async function readVoteState(key: string): Promise<ThresholdVoteState | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as ThresholdVoteState) : null;
  } catch {
    return null; // no hold bands this poll — entry thresholds still apply
  }
}

async function writeVoteState(key: string, state: ThresholdVoteState, isPositional: boolean): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(state), 'EX', isPositional ? VOTE_STATE_TTL_SECONDS_POSITIONAL : VOTE_STATE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, key }, 'Bias vote state write failed — next poll votes without hold bands');
  }
}

function hasRecentVolume(candles: OHLCV[]): boolean {
  return candles.slice(-20).some((c) => c.volume > 0);
}

/**
 * `target` with each bar's volume replaced by the summed volume of `source`
 * bars that started within it ([this bar's start, next bar's start)).
 * Same-interval bars map one to one; finer source bars roll up into coarser
 * target bars (15m into 1H, 1H into Daily). Target bars before the source's
 * history get 0, the same as before borrowing. Both are ascending by time.
 */
function withBorrowedVolume(target: OHLCV[], source: OHLCV[]): OHLCV[] {
  const src = source
    .map((c) => ({ t: Date.parse(c.timestamp), v: c.volume }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
  const starts = target.map((c) => Date.parse(c.timestamp));
  let j = 0;
  return target.map((bar, i) => {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : Infinity;
    if (!Number.isFinite(start)) return { ...bar, volume: 0 };
    while (j < src.length && src[j].t < start) j++;
    let volume = 0;
    let k = j;
    while (k < src.length && src[k].t < end) {
      volume += src[k].v;
      k++;
    }
    j = k;
    return { ...bar, volume };
  });
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
  const todayIST = decisionIstDate();
  const todays = candles.filter(
    (c) => new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === todayIST
  );
  return todays.length >= 2 ? todays : candles.slice(-20);
}

/** Candles from the most recent trading day strictly before today (IST) — the session pivot points are computed from. */
function filterPreviousSession(candles: OHLCV[]): OHLCV[] {
  const todayIST = decisionIstDate();
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

// classifyRegime (and EXPIRY_GAMMA_MAX_DTE) moved verbatim to
// regime-classifier.ts, beside the FAST_INTRADAY_REGIME fallback that reuses
// its ADX bands.

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

export interface OiLevel {
  strike: number;
  oi: number;
  /** OI relative to the single strongest level on this side, 0-100 — the strongest level is always 100, the rest scaled against it. */
  strengthPct: number;
}

// Intraday traders generally want more than just the single heaviest
// strike — a ladder of the next-heaviest levels shows where price is
// likely to find further reaction on the way to (or past) the primary
// wall, not just where the single biggest one sits.
const OI_LEVEL_COUNT = 3;

function findTopOiLevels(
  chain: NonNullable<Awaited<ReturnType<typeof buildOptionChain>>>,
  side: 'call' | 'put',
  count: number = OI_LEVEL_COUNT,
  bounds: { atOrBelow?: number; atOrAbove?: number } = {}
): OiLevel[] {
  const levels: Array<{ strike: number; oi: number }> = [];
  for (const s of chain.strikes) {
    const leg = side === 'call' ? s.call : s.put;
    if (!leg || leg.oi <= 0) continue;
    if (bounds.atOrBelow != null && s.strike > bounds.atOrBelow) continue;
    if (bounds.atOrAbove != null && s.strike < bounds.atOrAbove) continue;
    levels.push({ strike: s.strike, oi: leg.oi });
  }
  levels.sort((a, b) => b.oi - a.oi);
  const top = levels.slice(0, count);
  const maxOi = top[0]?.oi ?? 0;
  return top.map((l) => ({ ...l, strengthPct: maxOi > 0 ? Math.round((l.oi / maxOi) * 100) : 0 }));
}
