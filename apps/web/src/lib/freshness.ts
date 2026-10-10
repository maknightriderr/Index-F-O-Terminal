// ============================================================
// DATA FRESHNESS — from observation timestamps and session context
// ============================================================
// A socket being connected says nothing about whether a price is current, and
// a quiet feed outside the session is not a failure. Freshness is derived from
// WHEN the value was last observed, whether its exchange is in session, and
// (only as supporting evidence) whether the transport is connected.
//
//   FRESH          observed within the threshold, in session (or session unknown)
//   STALE          in session, but not observed within the threshold
//   DISCONNECTED   in session, not recent, and the transport is down
//   UNAVAILABLE    nothing has ever been observed
//   MARKET_CLOSED  the exchange is not in session: this is the LAST observation, not a live one
// ============================================================

import { formatAge, formatIstDateTime } from './format';

export type Freshness = 'FRESH' | 'STALE' | 'DISCONNECTED' | 'UNAVAILABLE' | 'MARKET_CLOSED';

export interface FreshnessInput {
  /** When this data was last observed (epoch ms), or null when never. */
  observedAt: number | null | undefined;
  now: number;
  /** Whether the instrument's exchange is in session; null when unknown. */
  sessionOpen: boolean | null;
  /** Whether the transport (socket / feed / API) is connected; null when unknown. */
  transportConnected?: boolean | null;
  /** In-session age (ms) up to which an observation is still FRESH. */
  freshWithinMs: number;
}

export interface FreshnessResult {
  state: Freshness;
  ageMs: number | null;
  /** Short uppercase label. */
  label: string;
  /** One sentence for a tooltip / screen reader. */
  detail: string;
}

/** In-session freshness windows, by kind of data. */
export const FRESH_WITHIN_MS = {
  quote: 90_000, // quotes poll every 20 s and tick live
  bias: 6 * 60_000, // the engine re-reads about every 5 min
  scan: 6 * 60_000, // the background scan runs every 5 min
  tradeMark: 4 * 60_000, // the monitor sweeps every ~90 s
  orderFlow: 90_000,
} as const;

const LABEL: Record<Freshness, string> = { FRESH: 'FRESH', STALE: 'STALE', DISCONNECTED: 'DISCONNECTED', UNAVAILABLE: 'UNAVAILABLE', MARKET_CLOSED: 'MARKET CLOSED' };

export function classifyFreshness(i: FreshnessInput): FreshnessResult {
  const observed = typeof i.observedAt === 'number' && i.observedAt > 0 ? i.observedAt : null;
  const ageMs = observed != null ? Math.max(0, i.now - observed) : null;

  if (observed == null) {
    return i.transportConnected === false
      ? { state: 'DISCONNECTED', ageMs, label: LABEL.DISCONNECTED, detail: 'Nothing has been observed and the feed is disconnected.' }
      : { state: 'UNAVAILABLE', ageMs, label: LABEL.UNAVAILABLE, detail: 'No observation has been recorded.' };
  }
  if (i.sessionOpen === false) {
    return { state: 'MARKET_CLOSED', ageMs, label: LABEL.MARKET_CLOSED, detail: `Market closed. Last observation ${formatIstDateTime(observed, i.now)} (${formatAge(ageMs)}); not a live update.` };
  }
  if (ageMs! <= i.freshWithinMs) {
    return { state: 'FRESH', ageMs, label: LABEL.FRESH, detail: `Observed ${formatAge(ageMs)}.` };
  }
  if (i.transportConnected === false) {
    return { state: 'DISCONNECTED', ageMs, label: LABEL.DISCONNECTED, detail: `Last observed ${formatAge(ageMs)} and the feed is disconnected.` };
  }
  return { state: 'STALE', ageMs, label: LABEL.STALE, detail: `Last observed ${formatAge(ageMs)}, older than the ${Math.round(i.freshWithinMs / 1000)} s freshness window while the market is open.` };
}
