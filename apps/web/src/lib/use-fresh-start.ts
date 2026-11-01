'use client';

// One shared /api/fresh-start/status poll for the Command Center, Strategy Lab, trade detail and the mobile view
// (reference-counted like use-health: it polls only while something shows it).

import { useSyncExternalStore } from 'react';
import type { FreshStartStatus } from '@fno/shared';
import { api } from './api';

export interface FreshStartState { data: FreshStartStatus | null; error: string | null; loading: boolean; fetchedAt: number | null }

const POLL_MS = 15_000;
let state: FreshStartState = { data: null, error: null, loading: true, fetchedAt: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

const publish = (next: FreshStartState) => {
  state = next;
  listeners.forEach((l) => l());
};

async function poll() {
  if (inFlight) return;
  inFlight = true;
  try {
    const data = await api.getFreshStartStatus();
    publish({ data, error: null, loading: false, fetchedAt: Date.now() });
  } catch (err) {
    // The last good payload stays on screen, flagged by `error`, so a blip does not blank the desk.
    publish({ ...state, error: (err instanceof Error && err.message) || 'Fresh-start status unavailable', loading: false });
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

export function useFreshStart(): FreshStartState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
