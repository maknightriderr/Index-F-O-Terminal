'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { FiiDiiActivity } from '@fno/shared';

// Persisted once daily server-side — no need to poll faster than the
// same-session refresh useFiiDii already uses for the live snapshot.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

/** Persisted daily FII/DII history, oldest first — sparse until the backend tracker accumulates real days. */
export function useFiiDiiHistory(limit = 30): { data: FiiDiiActivity[]; loading: boolean } {
  const [data, setData] = useState<FiiDiiActivity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getFiiDiiHistory(limit)
        .then((result) => {
          if (cancelled) return;
          setData(result);
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
  }, [limit]);

  return { data, loading };
}
