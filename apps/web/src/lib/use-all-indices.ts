'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { recordPrice } from './price-history-store';
import type { MarketQuote } from '@fno/shared';

const POLL_INTERVAL_MS = 30000;

/** Live quotes for every NSE/BSE/MCX index the terminal tracks — no mock fallback, starts empty. */
export function useAllIndices(): { indices: MarketQuote[]; isLive: boolean; loading: boolean } {
  const [indices, setIndices] = useState<MarketQuote[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getAllIndexQuotes()
        .then((data) => {
          if (cancelled) return;
          setIndices(data);
          setIsLive(true);
          setLoading(false);
          for (const q of data) recordPrice(q.symbol, q.ltp);
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

  return { indices, isLive, loading };
}
