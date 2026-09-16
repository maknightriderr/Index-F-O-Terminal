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
