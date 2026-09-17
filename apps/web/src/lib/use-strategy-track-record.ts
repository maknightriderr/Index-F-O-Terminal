'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { StrategyTrackRecord } from '@fno/shared';

// Recommendations are snapshotted and graded once a session — a slow poll is plenty.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

export function useStrategyTrackRecord(): { record: StrategyTrackRecord | null; loading: boolean } {
  const [record, setRecord] = useState<StrategyTrackRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api
        .getStrategyTrackRecord()
        .then((data) => {
          if (cancelled) return;
          setRecord(data);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { record, loading };
}
