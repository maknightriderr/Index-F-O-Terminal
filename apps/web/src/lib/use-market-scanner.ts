'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { MarketScanResult, ReadOnlyMeta } from '@fno/shared';

// The backend runs its own scan every 5 minutes while NSE is open. This only re-reads the recorded result,
// which is cheap, so a short poll is fine — and it can never start a scan.
const POLL_INTERVAL_MS = 60000;

/**
 * The newest recorded market scan. READ-ONLY; opening the Market Scanner page never runs a scan (that wrote ~105
 * decision rows on 10 Oct). `runScan` is the explicit action, called only by a person pressing "Run scan".
 */
export function useMarketScanner(): {
  data: MarketScanResult | null;
  isLive: boolean;
  loading: boolean;
  error: string | null;
  meta: ReadOnlyMeta | null;
  scannedAt: number | null;
  running: boolean;
  runScan: () => Promise<void>;
} {
  const [data, setData] = useState<MarketScanResult | null>(null);
  const [meta, setMeta] = useState<ReadOnlyMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api
        .getMarketScan()
        .then(({ data: result, meta: m }) => {
          if (cancelled) return;
          setMeta(m ?? null);
          setError(null);
          setLoading(false);
          if (result) setData(result);
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
  }, []);

  const runScan = useCallback(async () => {
    setRunning(true);
    try {
      const { data: result, meta: m } = await api.runMarketScan();
      setData(result);
      setMeta(m ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The scan could not be run');
    } finally {
      setRunning(false);
    }
  }, []);

  return { data, isLive: data != null && meta?.source === 'CACHE', loading, error, meta, scannedAt: data?.scannedAt ?? meta?.asOf ?? null, running, runScan };
}
