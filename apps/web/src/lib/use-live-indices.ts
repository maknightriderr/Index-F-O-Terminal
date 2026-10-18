'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { recordPrice } from './price-history-store';
import type { MarketQuote } from '@fno/shared';
import { quoteObservedAt } from './quote-time';

const POLL_INTERVAL_MS = 20000;

/**
 * Live NIFTY/BANKNIFTY/SENSEX/etc quotes. Starts empty — never shows sample prices; isLive says whether the last poll
 * succeeded. `observedAt` is the newest quote's own observation time (epoch ms) — what freshness is judged from,
 * not whether a request succeeded.
 */
export function useLiveIndices(): { indices: MarketQuote[]; isLive: boolean; observedAt: number | null } {
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

  // The exchange's own time when the quote carries it (audit 2026-10-18, UI-1): after the close that is the last close,
  // not the moment the server re-fetched it — a Sunday fetch of Friday's close no longer reads "last Sun 13:27".
  const observedAt = indices.length ? Math.max(...indices.map(quoteObservedAt)) || null : null;
  return { indices, isLive, observedAt };
}
