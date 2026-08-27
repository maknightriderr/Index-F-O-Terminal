'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { WinRateAnalytics, TradeSetupRecord } from '@fno/shared';

const POLL_INTERVAL_MS = 120000; // win-rate stats only change as setups resolve — no need for fast polling

export function useBacktesting(mode: 'ALL' | 'INTRADAY' | 'POSITIONAL' = 'ALL'): {
  analytics: WinRateAnalytics | null;
  history: TradeSetupRecord[];
  loading: boolean;
  isLive: boolean;
} {
  const [analytics, setAnalytics] = useState<WinRateAnalytics | null>(null);
  const [history, setHistory] = useState<TradeSetupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      Promise.all([api.getWinRateAnalytics(mode), api.getTradeSetupHistory(200)])
        .then(([winRate, setups]) => {
          if (cancelled) return;
          setAnalytics(winRate);
          // History is always the full, unfiltered list from the API — filter
          // client-side so the "Recent Trade Setups" table stays in sync with
          // the selected mode without a second round-trip per toggle.
          setHistory(mode === 'ALL' ? setups : setups.filter((s) => s.mode === mode));
          setIsLive(true);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setIsLive(false);
          setLoading(false);
        });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode]);

  return { analytics, history, loading, isLive };
}
