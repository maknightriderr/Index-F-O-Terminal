// ============================================================
// MEASUREMENT VIEW — display rows from the server's measurement report
// ============================================================
// The server computes every figure (tallies by cohort, family, instrument; costs; payoff grading). This only
// formats them, always with the denominator the figure was computed on, and never as a bare number:
//   * win rate (closed trades only)  = wins / (wins + losses)
//   * win rate (all trades)          = wins / (wins + losses + expired)
//   * net R covers only trades that have a recorded cost %, so it is shown with its own count and with the gross R
//     of those SAME trades — gross over all trades and net over fewer trades are never put side by side unlabelled
// A small sample is flagged; no group is called profitable or unprofitable from it.
// ============================================================

import type { Tally } from './use-measurement';
import { formatNumber, formatR, MISSING } from './format';

/** Below this many closed trades a group is a sample, not evidence. */
export const SMALL_SAMPLE_BELOW = 30;

const pct = (v: number | null) => (v == null ? MISSING : `${v.toFixed(1)}%`);

export interface TallyDisplay {
  closedCounted: number;
  wins: number;
  losses: number;
  expired: number;
  winRateClosed: string;
  winRateAll: string;
  expiredShare: string;
  grossR: string;
  grossRN: number;
  netR: string;
  netRN: number;
  grossRSameTrades: string;
  conservativeNetR: string;
  excluded: string;
  smallSample: boolean;
  netPopulationDiffers: boolean;
}

/** Pure: one tally as display strings, each rate with its denominator. */
export function displayTally(t: Tally): TallyDisplay {
  const decided = t.wins + t.losses;
  const d = t.denominators;
  const closedDen = d?.winRateClosedOnly ?? decided;
  const allDen = d?.winRateAllTrades ?? t.n;
  const grossN = d?.grossR ?? t.n;
  const netN = d?.netR ?? t.baseline.nNet;
  const excluded = Object.entries(t.excluded ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/_/g, ' ').toLowerCase()}`)
    .join(', ');
  return {
    closedCounted: t.n,
    wins: t.wins,
    losses: t.losses,
    expired: t.expired,
    winRateClosed: closedDen > 0 ? `${pct(t.winRateClosedOnly)} (${t.wins} of ${closedDen})` : MISSING,
    winRateAll: allDen > 0 ? `${pct(t.winRateAllTrades)} (${t.wins} of ${allDen})` : MISSING,
    expiredShare: allDen > 0 ? `${pct(t.expiredShare)} (${t.expired} of ${allDen})` : MISSING,
    grossR: t.baseline.grossR != null ? `${formatR(t.baseline.grossR)} (n=${grossN})` : MISSING,
    grossRN: grossN,
    netR: t.baseline.netR != null ? `${formatR(t.baseline.netR)} (n=${netN})` : MISSING,
    netRN: netN,
    grossRSameTrades: t.baseline.grossRSameTradesAsNet != null ? `${formatR(t.baseline.grossRSameTradesAsNet)} (n=${netN})` : MISSING,
    conservativeNetR: t.conservative.netR != null ? `${formatR(t.conservative.netR)} (n=${t.conservative.nNet})` : MISSING,
    excluded: excluded || 'none',
    smallSample: t.n < SMALL_SAMPLE_BELOW,
    netPopulationDiffers: netN !== grossN,
  };
}

/** The cutoff and versions the server reports, as labelled lines. Nothing is hardcoded. */
export function reliabilityLines(r: { measurementsReliableFrom?: string; tradesSinceReliable?: number; withCostRecord?: number; costRecordCoveragePct?: number | null } | undefined) {
  if (!r) return [] as Array<[string, string]>;
  return [
    ['Measurement-reliable from', r.measurementsReliableFrom ? new Date(r.measurementsReliableFrom).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : MISSING],
    ['Trades minted since', r.tradesSinceReliable != null ? String(r.tradesSinceReliable) : MISSING],
    ['of which with a cost record', r.withCostRecord != null ? String(r.withCostRecord) : MISSING],
    ['Cost record coverage', r.costRecordCoveragePct != null ? `${formatNumber(r.costRecordCoveragePct, 1)}%` : 'not yet measurable (no trade in the period)'],
  ] as Array<[string, string]>;
}
