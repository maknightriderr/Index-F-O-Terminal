'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { WinRateAnalytics, TradeSetupRecord } from '@fno/shared';

const POLL_INTERVAL_MS = 120000; // win-rate stats only change as setups resolve — no need for fast polling

export function useBacktesting(): {
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
      Promise.all([api.getWinRateAnalytics(), api.getTradeSetupHistory(200)])
        .then(([winRate, setups]) => {
          if (cancelled) return;
          setAnalytics(winRate);
          setHistory(setups);
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
  }, []);

  return { analytics, history, loading, isLive };
}
