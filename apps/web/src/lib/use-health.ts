'use client';

// ============================================================
// SHARED HEALTH POLL + CLOCK
// ============================================================
// One /api/health poll shared by everything that shows feed status (the top
// bar, the Dashboard status bar, the System Health page) instead of each
// polling on its own. Reference-counted: it polls only while something is
// showing it.
// ============================================================

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { HealthResponse } from './health-model';

export interface HealthState {
  data: HealthResponse | null;
  /** The browser's own error when the last request failed. Cleared by a success. */
  error: string | null;
  loading: boolean;
  /** When the last successful response arrived (epoch ms). */
  fetchedAt: number | null;
}

const POLL_MS = 10_000;
let state: HealthState = { data: null, error: null, loading: true, fetchedAt: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

const publish = (next: HealthState) => {
  state = next;
  listeners.forEach((l) => l());
};

async function poll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const data = await api.getHealth();
    publish({ data, error: null, loading: false, fetchedAt: Date.now() });
  } catch (err) {
    // The last good data is kept for reference, but the page treats a failed request as "API unreachable".
    publish({ data: null, error: (err instanceof Error && err.message) || 'API unreachable', loading: false, fetchedAt: state.fetchedAt });
  } finally {
    inFlight = false;
  }
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  if (!timer) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};

export function useHealth(): HealthState & { refresh: () => void } {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  const refresh = useCallback(() => void poll(), []);
  return { ...s, refresh };
}

/** A clock that re-renders every `ms` (default 1 s), so ages ("12 s ago") and session state stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
