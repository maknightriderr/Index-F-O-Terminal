'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { PaperTradesResponse } from '@fno/shared';

const POLL_MS = 30_000;

/**
 * Every paper trade with its live tracking, estimated costs and explicit status — the server's own record,
 * read-only (the page computes nothing about a trade). Polls while mounted.
 */
export function usePaperTrades(limit = 500): { data: PaperTradesResponse | null; loading: boolean; error: string | null; fetchedAt: number | null; reload: () => void } {
  const [data, setData] = useState<PaperTradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      api
        .getPaperTrades(limit)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
          setLoading(false);
          setFetchedAt(Date.now());
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err?.message ?? 'Request failed');
          setLoading(false);
        });
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [limit, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);
  return { data, loading, error, fetchedAt, reload };
}
