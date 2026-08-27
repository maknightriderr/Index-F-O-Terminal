'use client';

import { useEffect, useState, useRef } from 'react';
import { api } from './api';
import { MOCK_NIFTY_BIAS, MOCK_NIFTY_SCORE } from './mock-data';
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
 * Live Market Bias / Regime / Intelligence Score / Trade Setup for a symbol
 * — falls back to the NIFTY mock (clearly flagged via `isLive`) if the
 * backend can't compute it (no historical data access, symbol has no
 * derivatives, etc.).
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
  const [bias, setBias] = useState<MarketBias>(MOCK_NIFTY_BIAS);
  const [score, setScore] = useState<IntelligenceScore>(MOCK_NIFTY_SCORE);
  const [tradeSetup, setTradeSetup] = useState<TradeSetup>(NO_SETUP);
  const [isLive, setIsLive] = useState(false);
  // Track whether we've ever gotten live data for this symbol — if so,
  // failures keep the last live snapshot instead of reverting to mocks.
  const hasReceivedLive = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Reset live tracking when symbol or mode changes
    hasReceivedLive.current = false;

    const fetchBias = async () => {
      try {
        const data = await api.getMarketBias(symbol, exchange, mode);
        if (cancelled) return;
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
          setBias(data.bias);
          setScore(data.score);
          setTradeSetup(data.tradeSetup);
          setIsLive(true);
          hasReceivedLive.current = true;
        } catch {
          if (cancelled) return;
          // If we previously had live data, keep it (don't reset to mocks).
          // Only mark as non-live if we never received live data at all.
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
