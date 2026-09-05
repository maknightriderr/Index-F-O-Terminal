'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { MOCK_FII_DII_HISTORY } from './mock-data';
import type { FiiDiiActivity } from '@fno/shared';

// Persisted once daily server-side — no need to poll faster than the
// same-session refresh useFiiDii already uses for the live snapshot.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Persisted daily FII/DII history, oldest first. An empty array on a
 * successful response is a real, honest state (the tracker just hasn't
 * accumulated enough days yet) — NOT the same as the backend being
 * unreachable, so only an actual request failure falls back to mock data.
 */
export function useFiiDiiHistory(limit = 30): { data: FiiDiiActivity[]; loading: boolean; isLive: boolean } {
  const [data, setData] = useState<FiiDiiActivity[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getFiiDiiHistory(limit)
        .then((result) => {
          if (cancelled) return;
          setData(result);
          setIsLive(true);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setData(MOCK_FII_DII_HISTORY);
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
  }, [limit]);

  return { data, loading, isLive };
}
