'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { FnoScannerRow } from '@fno/shared';

const POLL_INTERVAL_MS = 60000;

/** Live F&O stock universe scanner — server caches a full scan for a few minutes, so this just polls that cache. */
export function useFnoScanner(exchange = 'NSE'): { rows: FnoScannerRow[]; isLive: boolean; loading: boolean } {
  const [rows, setRows] = useState<FnoScannerRow[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getFnoScanner(exchange)
        .then((data) => {
          if (cancelled) return;
          setRows(data);
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
  }, [exchange]);

  return { rows, isLive, loading };
}
