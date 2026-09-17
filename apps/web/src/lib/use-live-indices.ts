'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { recordPrice } from './price-history-store';
import type { MarketQuote } from '@fno/shared';

const POLL_INTERVAL_MS = 20000;

/** Live NIFTY/BANKNIFTY/SENSEX/etc quotes. Starts empty — never shows sample prices; isLive says whether the last poll succeeded. */
export function useLiveIndices(): { indices: MarketQuote[]; isLive: boolean } {
  const [indices, setIndices] = useState<MarketQuote[]>([]);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getIndexQuotes()
        .then((data) => {
          if (cancelled) return;
          if (data.length === 0) {
            setIsLive(false);
            return;
          }
          setIndices(data);
          setIsLive(true);
          for (const q of data) recordPrice(q.symbol, q.ltp);
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
