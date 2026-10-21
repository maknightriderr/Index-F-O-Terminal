// ============================================================
// BROKER CALL STATS (2026-10-21, measurement only)
// ============================================================
// Angel One refused the quote endpoint ~40 times a minute through the 21 Oct
// session (2,510 refusals in an hour), which slowed every read behind it: the
// background pass over SENSEX and MCX took ~20 minutes. Many services poll
// quotes, and nothing said which used the budget. Every broker request is
// counted here by provider, endpoint, caller and outcome, over the last hour.
//
// The caller is the supervised service whose timer started the work
// (service-supervisor.ts runs each callback inside runAsCaller), "terminal"
// for a person's API request, else "other" (tick-feed callbacks, boot work).
// Nothing reads these counts in a decision.
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import { isInteractiveRequest } from './request-priority.js';

export type BrokerCallOutcome = 'OK' | 'RATE_LIMITED' | 'FAILED';

const callerContext = new AsyncLocalStorage<string>();

/** Runs `fn` (and everything it awaits) attributed to `caller`. */
export function runAsCaller<T>(caller: string, fn: () => T): T {
  return callerContext.run(caller, fn);
}

/** Who the current broker request is for. A person's request wins over the service that happens to carry it. */
export function currentCaller(): string {
  if (isInteractiveRequest() && callerContext.getStore() == null) return 'terminal';
  return callerContext.getStore() ?? 'other';
}

/** The endpoint family of a broker URL. */
export function endpointOf(url: string | undefined): string {
  if (!url) return 'other';
  if (url.includes('/quote')) return 'quote';
  if (url.includes('/historical/') || url.includes('/charts/')) return 'historical';
  if (url.includes('optionGreek')) return 'greeks';
  if (url.includes('optionchain')) return 'optionChain';
  return 'other';
}

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;
// minute -> "provider|endpoint|caller|outcome" -> count
const buckets = new Map<number, Map<string, number>>();

export function recordBrokerCall(provider: string, endpoint: string, caller: string, outcome: BrokerCallOutcome, now = Date.now()): void {
  const minute = Math.floor(now / MINUTE_MS);
  let b = buckets.get(minute);
  if (!b) {
    b = new Map();
    buckets.set(minute, b);
    for (const m of buckets.keys()) if (m <= minute - WINDOW_MINUTES) buckets.delete(m);
  }
  const key = `${provider}|${endpoint}|${caller}|${outcome}`;
  b.set(key, (b.get(key) ?? 0) + 1);
}

export interface BrokerCallRow {
  provider: string;
  endpoint: string;
  caller: string;
  ok: number;
  rateLimited: number;
  failed: number;
}

/** The last hour's calls, one row per provider / endpoint / caller, the busiest first. */
export function brokerCallStats(now = Date.now()): { windowMinutes: number; rows: BrokerCallRow[] } {
  const from = Math.floor(now / MINUTE_MS) - WINDOW_MINUTES;
  const rows = new Map<string, BrokerCallRow>();
  for (const [minute, b] of buckets) {
    if (minute <= from) continue;
    for (const [key, n] of b) {
      const [provider, endpoint, caller, outcome] = key.split('|');
      const id = `${provider}|${endpoint}|${caller}`;
      const row = rows.get(id) ?? { provider, endpoint, caller, ok: 0, rateLimited: 0, failed: 0 };
      if (outcome === 'OK') row.ok += n;
      else if (outcome === 'RATE_LIMITED') row.rateLimited += n;
      else row.failed += n;
      rows.set(id, row);
    }
  }
  const total = (r: BrokerCallRow) => r.ok + r.rateLimited + r.failed;
  return { windowMinutes: WINDOW_MINUTES, rows: [...rows.values()].sort((a, b) => total(b) - total(a)) };
}

/** Tests only. */
export function resetBrokerCallStats(): void {
  buckets.clear();
}
