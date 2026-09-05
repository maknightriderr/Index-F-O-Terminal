'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { FiiDiiActivity } from '@fno/shared';

// EOD-only data (NSE publishes once, after market close) — no point
// polling anywhere near as often as live quotes; this just needs to
// pick up the one daily update within the session.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

export function useFiiDii(): { data: FiiDiiActivity | null; isLive: boolean; loading: boolean } {
  const [data, setData] = useState<FiiDiiActivity | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getFiiDii()
        .then((result) => {
          if (cancelled) return;
          setData(result);
          setIsLive(result != null);
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
