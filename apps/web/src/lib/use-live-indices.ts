'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { MOCK_INDICES } from './mock-data';
import type { MarketQuote } from '@fno/shared';

const POLL_INTERVAL_MS = 20000;

/** Live NIFTY/BANKNIFTY/SENSEX/etc quotes, falling back to mock data if the backend is unreachable. */
export function useLiveIndices(): { indices: MarketQuote[]; isLive: boolean } {
  const [indices, setIndices] = useState<MarketQuote[]>(MOCK_INDICES);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getIndexQuotes()
        .then((data) => {
          if (cancelled || data.length === 0) return;
          setIndices(data);
          setIsLive(true);
        })
        .catch(() => {
          if (!cancelled) setIsLive(false);
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { indices, isLive };
}
