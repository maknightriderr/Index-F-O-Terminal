'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { recordPrice } from './price-history-store';
import type { FnoScannerRow, ReadOnlyMeta } from '@fno/shared';

const POLL_INTERVAL_MS = 60000;

/**
 * The F&O stock universe as the server last recorded it. READ-ONLY: the server never starts a scan because a page
 * asked, so `meta` says where the rows came from (live cache / last-known copy) and how old they are. Starts empty;
 * no sample rows.
 *
 * isLive: the rows came from the live cache (the scan is currently being refreshed by the server).
 * asOf:   when the newest row was observed (epoch ms), null when unknown.
 */
export function useFnoScanner(exchange = 'NSE'): {
  rows: FnoScannerRow[];
  isLive: boolean;
  loading: boolean;
  error: string | null;
  meta: ReadOnlyMeta | null;
  asOf: number | null;
  reload: () => void;
} {
  const [rows, setRows] = useState<FnoScannerRow[]>([]);
  const [meta, setMeta] = useState<ReadOnlyMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getFnoScanner(exchange)
        .then(({ data, meta: m }) => {
          if (cancelled) return;
          setMeta(m ?? null);
          setError(null);
          setLoading(false);
          if (data && data.length > 0) {
            setRows(data);
            for (const r of data) recordPrice(r.symbol, r.price);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err?.message ?? 'Request failed');
          setLoading(false);
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [exchange, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);

  return { rows, isLive: rows.length > 0 && meta?.source === 'CACHE', loading, error, meta, asOf: meta?.asOf ?? null, reload };
}
