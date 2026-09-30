'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

// Net R and cost quality land at the fill; fill status and the graded
// outcome land hours after the session. Nothing here changes faster.
const POLL_INTERVAL_MS = 2 * 60 * 1000;

/** Mirrors apps/server/src/services/signal-diagnostics.ts diagnosticsSetupOutcomes(). */
export interface SetupOutcome {
  lifecycleId: string;
  eventType: string;
  decision: string | null;
  grossRr: number | null;
  netRr: number | null;
  costR: number | null;
  costQuality: 'OBSERVED' | 'MODELLED' | 'UNAVAILABLE' | null;
  fillStatus: 'FILLED' | 'NO_FILL' | 'NOT_GRADED' | null;
  resultR: number | null;
  netResultR: number | null;
  exitReason: string | null;
  rejectionReason: string | null;
  wouldBeValidIf: string | null;
  grade: string | null;
  gradedAt: number | null;
}

/** The stored measurement for each lifecycle id, keyed by id. Read-only; an error leaves the map empty. */
export function useSetupOutcomes(lifecycleIds: string[]): Record<string, SetupOutcome> {
  const [byId, setById] = useState<Record<string, SetupOutcome>>({});
  const key = [...new Set(lifecycleIds)].sort().join(',');

  useEffect(() => {
    if (!key) {
      setById({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = (await api.getSetupOutcomes(key.split(','))) as any;
        if (cancelled) return;
        const rows = (res?.data?.rows ?? []) as SetupOutcome[];
        setById(Object.fromEntries(rows.map((r) => [r.lifecycleId, r])));
      } catch {
        // Informational only: the card renders without the measurement.
      }
    };
    void load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key]);

  return byId;
}
