'use client';

import { useEffect, useState, useRef } from 'react';
import { api } from './api';
import type { MarketBias, IntelligenceScore, TradeSetup, TradingMode } from '@fno/shared';

const POLL_INTERVAL_MS = 60000;

// Retry after a short delay on the first failure — the server-side
// fallback cache should cover most rate-limit blips, but the network
// request itself can also fail transiently (timeout, 502 from reverse
// proxy, etc.). One quick retry handles the common case without adding
// meaningful latency to the poll cycle.
const RETRY_DELAY_MS = 5000;

const NO_SETUP: TradeSetup = { available: false, reason: 'Live signal engine unreachable.' };

/**
 * What the hook returns before any live read exists for a symbol: a neutral,
 * zero-confidence read with no inputs, carrying the REQUESTED symbol. It used
 * to be the NIFTY sample bias (78% bullish, strong bull trend) — shown under
 * whatever instrument was selected, with nothing on the Dashboard saying so.
 * Consumers should check isLive before presenting direction/regime/score.
 */
export function placeholderBias(symbol: string): MarketBias {
  return {
    symbol,
    direction: 'NEUTRAL',
    bullishProbability: 0,
    bearishProbability: 0,
    neutralProbability: 100,
    confidence: 0,
    regime: 'RANGE_BOUND',
    reasoning: ['Waiting for the live signal engine.'],
    inputs: {},
    timestamp: 0,
  };
}

export function placeholderScore(symbol: string): IntelligenceScore {
  return {
    symbol,
    score: 0,
    trend: 0,
    priceAction: 0,
    futuresOi: 0,
    optionsOi: 0,
    pcr: 0,
    iv: 0,
    oiShifts: 0,
    volume: 0,
    relativeStrength: 0,
    technicals: 0,
    regime: 0,
    reasoning: [],
    timestamp: 0,
  };
}

// Module-level so a revisited symbol/exchange/mode combination shows its
// last-known bias instantly on switch instead of either (a) blanking to the
// generic NIFTY mock, or (b) — the actual prior behavior, since state here
// simply wasn't reset on prop change — silently showing the PREVIOUS
// symbol's bias/regime/score mislabeled under the new symbol's header until
// the first fetch for the new key resolved.
const biasCache = new Map<string, { bias: MarketBias; score: IntelligenceScore; tradeSetup: TradeSetup }>();
function biasCacheKey(symbol: string, exchange: string, mode: TradingMode): string {
  return `${exchange}:${symbol}:${mode}`;
}

/**
 * Live Market Bias / Regime / Intelligence Score / Trade Setup for a symbol
 * — a neutral zero-confidence placeholder (isLive: false) until the backend
 * returns a real read; never sample data.
 *
 * Once live data has been received at least once, subsequent failures
 * preserve the last successful values instead of resetting to mocks —
 * a transient rate-limit blip shouldn't wipe real data the user is
 * actively reading.
 */
export function useMarketBias(
  symbol: string,
  exchange: string,
  mode: TradingMode = 'INTRADAY'
): { bias: MarketBias; score: IntelligenceScore; tradeSetup: TradeSetup; isLive: boolean } {
  const [bias, setBias] = useState<MarketBias>(() => placeholderBias(symbol));
  const [score, setScore] = useState<IntelligenceScore>(() => placeholderScore(symbol));
  const [tradeSetup, setTradeSetup] = useState<TradeSetup>(NO_SETUP);
  const [isLive, setIsLive] = useState(false);
  // Track whether we've ever gotten live data for this symbol — if so,
  // failures keep the last live snapshot instead of reverting to mocks.
  const hasReceivedLive = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const key = biasCacheKey(symbol, exchange, mode);
    const cached = biasCache.get(key);

    // Sync to this key's cache (or the placeholder, if never fetched) the
    // moment symbol/exchange/mode changes — without this, whatever was on
    // screen for the PREVIOUS key stays visible, mislabeled as the new
    // symbol/mode, until the first fetch below resolves.
    setBias(cached?.bias ?? placeholderBias(symbol));
    setScore(cached?.score ?? placeholderScore(symbol));
    setTradeSetup(cached?.tradeSetup ?? NO_SETUP);
    setIsLive(!!cached);
    hasReceivedLive.current = !!cached;

    const fetchBias = async () => {
      try {
        const data = await api.getMarketBias(symbol, exchange, mode);
        if (cancelled) return;
        biasCache.set(key, data);
        setBias(data.bias);
        setScore(data.score);
        setTradeSetup(data.tradeSetup);
        setIsLive(true);
        hasReceivedLive.current = true;
      } catch {
        if (cancelled) return;
        // First failure: retry once after a short delay
        try {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          if (cancelled) return;
          const data = await api.getMarketBias(symbol, exchange, mode);
          if (cancelled) return;
          biasCache.set(key, data);
          setBias(data.bias);
          setScore(data.score);
          setTradeSetup(data.tradeSetup);
          setIsLive(true);
          hasReceivedLive.current = true;
        } catch {
          if (cancelled) return;
          // If we previously had live data (this poll cycle or an earlier
          // visit to this same symbol/exchange/mode), keep it rather than
          // resetting to mocks. Only mark as non-live if we never received
          // live data for this key at all.
          if (!hasReceivedLive.current) {
            setIsLive(false);
          }
          // Otherwise: bias/score/tradeSetup stay at their last live values
        }
      }
    };

    fetchBias();
    const interval = setInterval(fetchBias, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol, exchange, mode]);

  return { bias, score, tradeSetup, isLive };
}
