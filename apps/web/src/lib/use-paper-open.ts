'use client';

// ============================================================
// OPEN PAPER POSITIONS — one shared, light count for the rail badge (both engines)
// ============================================================
// Legacy: the open count of the newest paper-trade window; new engine: open positions in the fresh-start status the
// terminal already polls. One poll per minute however many components read it (reference-counted).

import { useSyncExternalStore } from 'react';
import { api } from './api';

let open: number | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
const poll = () => api.getPaperTrades(80).then((d) => { open = d?.counts?.open ?? null; listeners.forEach((l) => l()); }).catch(() => undefined);
const subscribe = (l: () => void) => {
  listeners.add(l);
  if (!timer) { void poll(); timer = setInterval(poll, 60_000); }
  return () => { listeners.delete(l); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
};
export function useLegacyOpenCount(): number | null {
  return useSyncExternalStore(subscribe, () => open, () => null);
}
