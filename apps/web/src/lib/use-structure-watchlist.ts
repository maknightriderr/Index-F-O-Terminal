'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { StructureLifecycleView } from '@fno/shared';

// The lifecycle advances on 15-minute bar closes (and on live fills between
// them); a one-minute read of the server's Redis state is plenty.
const POLL_INTERVAL_MS = 60000;

/** Every symbol's running structure lifecycle (GET /api/structure/watchlist). */
export function useStructureWatchlist(): { rows: StructureLifecycleView[]; enabled: boolean; isLive: boolean; loading: boolean } {
  const [rows, setRows] = useState<StructureLifecycleView[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api
        .getStructureWatchlist()
        .then((result) => {
          if (cancelled || !result) return;
          setRows(result.rows);
          setEnabled(result.enabled);
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

  return { rows, enabled, isLive, loading };
}
