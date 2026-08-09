'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { MOCK_NIFTY_BIAS, MOCK_NIFTY_SCORE } from './mock-data';
import type { MarketBias, IntelligenceScore, TradeSetup } from '@fno/shared';

const POLL_INTERVAL_MS = 60000;

const NO_SETUP: TradeSetup = { available: false, reason: 'Live signal engine unreachable.' };

/**
 * Live Market Bias / Regime / Intelligence Score / Trade Setup for a symbol
 * — falls back to the NIFTY mock (clearly flagged via `isLive`) if the
 * backend can't compute it (no historical data access, symbol has no
 * derivatives, etc.).
 */
export function useMarketBias(
  symbol: string,
  exchange: string
): { bias: MarketBias; score: IntelligenceScore; tradeSetup: TradeSetup; isLive: boolean } {
  const [bias, setBias] = useState<MarketBias>(MOCK_NIFTY_BIAS);
  const [score, setScore] = useState<IntelligenceScore>(MOCK_NIFTY_SCORE);
  const [tradeSetup, setTradeSetup] = useState<TradeSetup>(NO_SETUP);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getMarketBias(symbol, exchange)
        .then((data) => {
          if (cancelled) return;
          setBias(data.bias);
          setScore(data.score);
          setTradeSetup(data.tradeSetup);
          setIsLive(true);
        })
        .catch(() => {
          if (cancelled) return;
          setIsLive(false);
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol, exchange]);

  return { bias, score, tradeSetup, isLive };
}
