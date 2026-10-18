// ============================================================
// QUOTE TIME (audit 2026-10-18, UI-1)
// ============================================================
// A quote carries two times: when the server fetched it (`timestamp`) and,
// when the broker said, when the EXCHANGE published it (`exchangeTimestamp`).
// After the close they differ by days: a Sunday fetch of Friday's close is a
// Friday observation. Freshness and "last" labels use the exchange time.
// ============================================================

import type { MarketQuote } from '@fno/shared';

/** The quote's observation time: the exchange's own time when known, else the fetch time. */
export function quoteObservedAt(q: Pick<MarketQuote, 'timestamp' | 'exchangeTimestamp'> | null | undefined): number {
  if (!q) return 0;
  return typeof q.exchangeTimestamp === 'number' && q.exchangeTimestamp > 0 ? q.exchangeTimestamp : q.timestamp || 0;
}
