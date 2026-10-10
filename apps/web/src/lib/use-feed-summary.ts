'use client';

// ============================================================
// FEED SUMMARY — one reading of "is the data current?" for the whole UI
// ============================================================
// Combines what the browser can observe: the newest index quote's own
// timestamp, the exchange sessions (computed from the shared calendar), the
// shared /api/health poll and the browser socket. Everything the top bar and the
// Dashboard status bar show comes from here, so they can never disagree.
// ============================================================

import { useMemo } from 'react';
import { isMarketOpen } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { useSystemHealthStore } from '@/stores';
import { useLiveIndices } from './use-live-indices';
import { useHealth, useNow } from './use-health';
import { buildHealthModel, type HealthModel } from './health-model';
import { classifyFreshness, FRESH_WITHIN_MS, type FreshnessResult } from './freshness';

export const EXCHANGES: Exchange[] = ['NSE', 'BSE', 'MCX'];

export interface FeedSummary {
  now: number;
  sessions: Array<{ exchange: Exchange; open: boolean }>;
  /** Freshness of the index quotes shown at the top (NIFTY's own observation time, NSE's session). */
  quotes: FreshnessResult;
  /** The newest quote observation (epoch ms). */
  quotesObservedAt: number | null;
  health: HealthModel;
  apiReachable: boolean;
  browserSocketConnected: boolean;
}

export function useFeedSummary(): FeedSummary {
  const now = useNow(1000);
  const { observedAt } = useLiveIndices();
  const { data, error } = useHealth();
  const ws = useSystemHealthStore((s) => s.health.websocket);

  return useMemo(() => {
    const sessions = EXCHANGES.map((exchange) => ({ exchange, open: isMarketOpen(exchange, now) }));
    const health = buildHealthModel({ data, apiError: error, now, browserSocket: { connected: ws.connected, lastTickAt: ws.lastTick ?? null } });
    const quotes = classifyFreshness({
      observedAt,
      now,
      sessionOpen: sessions.find((s) => s.exchange === 'NSE')?.open ?? null,
      transportConnected: health.apiReachable ? true : false,
      freshWithinMs: FRESH_WITHIN_MS.quote,
    });
    return { now, sessions, quotes, quotesObservedAt: observedAt, health, apiReachable: health.apiReachable, browserSocketConnected: ws.connected };
  }, [now, observedAt, data, error, ws.connected, ws.lastTick]);
}
