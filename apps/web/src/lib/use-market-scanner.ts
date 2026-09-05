'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { MarketScanResult } from '@fno/shared';

// The backend's own scan only refreshes every 5 minutes (a real
// buildMarketBias call per candidate) — this just re-reads its cheap,
// pre-computed Redis cache, so a short poll here is fine.
const POLL_INTERVAL_MS = 60000;

export function useMarketScanner(): { data: MarketScanResult | null; isLive: boolean; loading: boolean } {
  const [data, setData] = useState<MarketScanResult | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getMarketScan()
        .then((result) => {
          if (cancelled || !result) return;
          setData(result);
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

  return { data, isLive, loading };
}
