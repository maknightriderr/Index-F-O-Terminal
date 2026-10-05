// ============================================================
// REQUEST PRIORITY
// ============================================================
// Marks work done on behalf of a person looking at the terminal, so the
// broker request queue can serve it ahead of background jobs. The market
// scanner fires bursts of candle downloads every 5 minutes; behind the
// per-minute cap those bursts could keep a user's bias panel waiting for
// tens of seconds. AsyncLocalStorage carries the mark through every await
// of the request's handler, so nothing between the route and the provider
// needs a priority parameter.
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<'interactive'>();

/** Runs `fn` (and everything it awaits) as interactive work. */
export function runInteractive<T>(fn: () => T): T {
  return context.run('interactive', fn);
}

/** True inside work started by an API request from the terminal. */
export function isInteractiveRequest(): boolean {
  return context.getStore() === 'interactive';
}

// ---------------- fairness: the background max-wait cap (Phase 6) ----------------
// Interactive work still goes first — but a background request that has
// waited longer than REQUEST_MAX_WAIT_MS is promoted ahead of the interactive
// queue, so a busy terminal can never starve the scanners and monitors.

const DEFAULT_MAX_WAIT_MS = 30_000;

/** REQUEST_MAX_WAIT_MS (ms, > 0); anything else is the default (30 s). */
export function parseMaxWaitMs(raw: string | undefined): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_WAIT_MS;
}

export const BACKGROUND_MAX_WAIT_MS = parseMaxWaitMs(process.env.REQUEST_MAX_WAIT_MS);

/**
 * Which queue is served next: interactive first, unless the oldest
 * background request has waited at least `maxWaitMs`.
 */
export function nextLane(args: { highWaiting: number; normalWaiting: number; oldestNormalEnqueuedAt: number | null; now: number; maxWaitMs?: number }): 'high' | 'normal' | null {
  const { highWaiting, normalWaiting, oldestNormalEnqueuedAt, now } = args;
  const maxWait = args.maxWaitMs ?? BACKGROUND_MAX_WAIT_MS;
  if (normalWaiting > 0 && oldestNormalEnqueuedAt != null && now - oldestNormalEnqueuedAt >= maxWait) return 'normal';
  if (highWaiting > 0) return 'high';
  return normalWaiting > 0 ? 'normal' : null;
}
