'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { DetectedChartPattern } from '@fno/shared';

// The backend scanner only refreshes every ~25 minutes (historical-candle
// fetches are rate-limit-sensitive), so this poll is just a cheap Redis
// read on the server — safe to check far more often than the data itself
// actually changes.
const POLL_INTERVAL_MS = 120000;

export function useChartPatterns(): { patterns: DetectedChartPattern[]; loading: boolean } {
  const [patterns, setPatterns] = useState<DetectedChartPattern[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api
        .getChartPatterns()
        .then((data) => {
          if (cancelled) return;
          setPatterns(data);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
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

  return { patterns, loading };
}
