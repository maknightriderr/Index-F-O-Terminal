'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { Alert } from '@fno/shared';

const POLL_INTERVAL_MS = 30000;

/**
 * Live alert feed — server persists+dedupes, this just polls the recent
 * list. `type`/`severity` filter server-side (not just after the fetch),
 * so a filtered view reflects the real matching rows, not whatever
 * happened to be in the last `limit` unfiltered ones.
 */
export function useAlerts(limit = 50, opts: { type?: string; severity?: string } = {}): { alerts: Alert[]; isLive: boolean; loading: boolean } {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const { type, severity } = opts;

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getAlerts(limit, { type, severity })
        .then((data) => {
          if (cancelled) return;
          setAlerts(data);
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
  }, [limit, type, severity]);

  return { alerts, isLive, loading };
}
