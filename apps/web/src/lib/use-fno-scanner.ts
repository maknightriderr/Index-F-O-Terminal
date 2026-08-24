'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { recordPrice } from './price-history-store';
import { MOCK_FNO_SCANNER_ROWS } from './mock-data';
import type { FnoScannerRow } from '@fno/shared';

const POLL_INTERVAL_MS = 60000;

/** Live F&O stock universe scanner — server caches a full scan for a few minutes, with rich fallback if backend is offline. */
export function useFnoScanner(exchange = 'NSE'): { rows: FnoScannerRow[]; isLive: boolean; loading: boolean } {
  const [rows, setRows] = useState<FnoScannerRow[]>(MOCK_FNO_SCANNER_ROWS);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Seed mock prices into price history store for sparklines
    for (const r of MOCK_FNO_SCANNER_ROWS) recordPrice(r.symbol, r.price);

    const poll = () => {
      api
        .getFnoScanner(exchange)
        .then((data) => {
          if (cancelled || !data || data.length === 0) return;
          setRows(data);
          setIsLive(true);
          setLoading(false);
          for (const r of data) recordPrice(r.symbol, r.price);
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

