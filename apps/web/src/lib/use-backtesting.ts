'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { WinRateAnalytics, TradeSetupRecord } from '@fno/shared';

const POLL_INTERVAL_MS = 120000; // win-rate stats only change as setups resolve — no need for fast polling

export function useBacktesting(
  mode: 'ALL' | 'INTRADAY' | 'POSITIONAL' = 'ALL',
  /** Only setups generated at or after this time (epoch ms) — the "Current logic" view. */
  since?: number
): {
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
      Promise.all([api.getWinRateAnalytics(mode, since), api.getTradeSetupHistory(2000)])
        .then(([winRate, setups]) => {
          if (cancelled) return;
          setAnalytics(winRate);
          // History is always the full, unfiltered list from the API — filter
          // client-side so the "Recent Trade Setups" table stays in sync with
          // the selected mode and scope without a second round-trip per toggle.
          setHistory(setups.filter((s) => (mode === 'ALL' || s.mode === mode) && (since == null || s.generatedAt >= since)));
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
  }, [mode, since]);

  return { analytics, history, loading, isLive };
}
