// ============================================================
// OPTION_PAYOFF_V2 — a shadow grader that does not guess (2026-10-09)
// ============================================================
// The first grader (forward-validation.ts, OPTION_PAYOFF) asks "did the best
// 15-minute option-chain MID between entry and exit reach the target?". That
// is the wrong instrument for a limit exit: a target that was touched for a
// few seconds between two snapshots, or that filled on a last-traded price
// above a mid, is invisible to it — so it reports targetReached = false for
// trades the system recorded as target WINs.
//
// V2 reads every timestamped option price that exists for the trade, labels
// where each came from, and states what they do and do not prove:
//
//   MONITOR_EXTREME   the best / worst premium the live price monitor saw
//                     (premiumMfe @ premiumMfeAt, premiumMae @ premiumMaeAt) —
//                     the same ticks and quotes that decided the exit
//   CHAIN_SNAPSHOT    the 15-minute chain mids the old grader used
//
// (No persisted option-tick archive exists; the capture tables hold underlying
// ticks only. Post-exit observations are in trade_post_exit and are not used
// to grade the trade: they are after its exit.)
//
// Verdicts, fixed before any result was looked at:
//   a recorded TARGET exit is
//     CORROBORATED          some observation in (entry, exit] is ≥ the target
//     CONTRADICTED_DENSE    observations are continuous (no gap over
//                           DENSE_MAX_GAP_MS, entry→exit) and NONE reached it
//     NOT_CORROBORATED      observations exist but are sparse: a touch between
//                           them cannot be ruled in or out
//     UNVERIFIABLE          no observation at all
//   a recorded STOP_LOSS exit is graded the same way against the initial stop
//   any other exit is checked for the opposite conflict (a target or stop level
//   observed before an exit that did not record it): TARGET_SEEN_NOT_RECORDED /
//   STOP_SEEN_NOT_RECORDED / NO_CONFLICT.
//
// Missing data is never turned into a touch or a miss. Nothing is written to the
// trade, and the grade changes no decision.
// ============================================================

export const PAYOFF_GRADER_VERSION = 'PAYOFF-2.0';
/** Observations no further apart than this, entry to exit, count as continuous. */
export const DENSE_MAX_GAP_MS = 120_000;

export type ObservationSource = 'MONITOR_EXTREME' | 'CHAIN_SNAPSHOT';
export interface PriceObservation {
  at: number;
  premium: number;
  source: ObservationSource;
}

export type PayoffVerdict =
  | 'CORROBORATED'
  | 'CONTRADICTED_DENSE'
  | 'NOT_CORROBORATED'
  | 'UNVERIFIABLE'
  | 'TARGET_SEEN_NOT_RECORDED'
  | 'STOP_SEEN_NOT_RECORDED'
  | 'NO_CONFLICT'
  | 'NOT_APPLICABLE';

export interface PayoffV2Input {
  entry: number;
  target: number | null;
  /** The stop at the mint (the trailing stop is not a recorded level). */
  initialStop: number | null;
  outcome: string | null;
  closeReason: string | null;
  exitPrice: number | null;
  entryAt: number;
  exitAt: number | null;
  projectedPayoff: { netGain: number; deltaGain: number; gammaGain: number; thetaDecay: number; holdHours: number } | null;
  observations: readonly PriceObservation[];
  /** The first grader's answer for the same trade, kept beside V2's so the disagreement is visible. */
  legacy?: { targetReached: boolean | null; marks: number | null } | null;
}

const round = (v: number | null, dp = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** Pure: the monitor's own extremes for a trade as observations (only those with a time and a real move). */
export function monitorExtremes(
  entry: number,
  x: { premiumMfe?: number | null; premiumMfeAt?: number | null; premiumMae?: number | null; premiumMaeAt?: number | null } | null | undefined
): PriceObservation[] {
  const out: PriceObservation[] = [];
  if (!x) return out;
  if (x.premiumMfe != null && x.premiumMfe > entry && x.premiumMfeAt != null && x.premiumMfeAt > 0) out.push({ at: x.premiumMfeAt, premium: x.premiumMfe, source: 'MONITOR_EXTREME' });
  if (x.premiumMae != null && x.premiumMae > 0 && x.premiumMae < entry && x.premiumMaeAt != null && x.premiumMaeAt > 0) out.push({ at: x.premiumMaeAt, premium: x.premiumMae, source: 'MONITOR_EXTREME' });
  return out;
}

function gradeLevel(kind: 'TARGET' | 'STOP', level: number | null, obs: readonly PriceObservation[], dense: boolean): { verdict: PayoffVerdict; firstAt: number | null; by: ObservationSource | null } {
  if (level == null) return { verdict: 'UNVERIFIABLE', firstAt: null, by: null };
  const hit = obs.filter((o) => (kind === 'TARGET' ? o.premium >= level : o.premium <= level)).sort((a, b) => a.at - b.at)[0];
  if (hit) return { verdict: 'CORROBORATED', firstAt: hit.at, by: hit.source };
  if (obs.length === 0) return { verdict: 'UNVERIFIABLE', firstAt: null, by: null };
  return { verdict: dense ? 'CONTRADICTED_DENSE' : 'NOT_CORROBORATED', firstAt: null, by: null };
}

export function gradeOptionPayoffV2(g: PayoffV2Input): { predicted: Record<string, unknown>; actual: Record<string, unknown> } {
  const exitAt = g.exitAt;
  const window = exitAt == null ? [] : g.observations.filter((o) => o.at > g.entryAt && o.at <= exitAt && o.premium > 0).sort((a, b) => a.at - b.at);
  const bySource: Record<string, number> = {};
  for (const o of window) bySource[o.source] = (bySource[o.source] ?? 0) + 1;

  // Gaps over the whole holding window, entry → first → … → last → exit.
  let maxGap: number | null = null;
  if (exitAt != null && window.length) {
    const points = [g.entryAt, ...window.map((o) => o.at), exitAt];
    maxGap = 0;
    for (let i = 1; i < points.length; i++) maxGap = Math.max(maxGap, points[i] - points[i - 1]);
  }
  const dense = maxGap != null && maxGap <= DENSE_MAX_GAP_MS;

  const isTargetExit = g.outcome === 'WIN' && (g.closeReason === 'TARGET' || g.closeReason == null);
  const isStopExit = g.outcome === 'LOSS' && g.closeReason === 'STOP_LOSS';
  const target = isTargetExit || exitAt != null ? gradeLevel('TARGET', g.target, window, dense) : { verdict: 'UNVERIFIABLE' as PayoffVerdict, firstAt: null, by: null };
  const stop = gradeLevel('STOP', g.initialStop, window, dense);

  let verdict: PayoffVerdict;
  let basis: string;
  if (exitAt == null) {
    verdict = 'UNVERIFIABLE';
    basis = 'no recorded exit time';
  } else if (isTargetExit) {
    verdict = target.verdict;
    basis = 'recorded target exit graded against the target level';
  } else if (isStopExit) {
    verdict = stop.verdict;
    basis = 'recorded stop exit graded against the initial stop level';
  } else if (window.length === 0) {
    verdict = 'UNVERIFIABLE';
    basis = 'no observation inside the holding window';
  } else if (target.verdict === 'CORROBORATED') {
    verdict = 'TARGET_SEEN_NOT_RECORDED';
    basis = 'an observation at or above the target before an exit that did not record a target';
  } else if (stop.verdict === 'CORROBORATED' && g.outcome !== 'LOSS') {
    verdict = 'STOP_SEEN_NOT_RECORDED';
    basis = 'an observation at or below the initial stop before an exit that did not record a stop';
  } else {
    verdict = 'NO_CONFLICT';
    basis = 'neither level was observed before the recorded exit';
  }

  const maxPremium = window.length ? Math.max(...window.map((o) => o.premium)) : null;
  const minPremium = window.length ? Math.min(...window.map((o) => o.premium)) : null;
  const projectedGain = g.target != null ? g.target - g.entry : null;
  const maxGain = maxPremium != null ? maxPremium - g.entry : null;
  const legacyTargetReached = g.legacy?.targetReached ?? null;

  return {
    predicted: {
      entry: g.entry,
      target: g.target,
      initialStop: g.initialStop,
      projectedGainPct: round(projectedGain != null && g.entry > 0 ? projectedGain / g.entry : null),
      projectedPayoff: g.projectedPayoff,
    },
    actual: {
      grader: 'OPTION_PAYOFF_V2',
      version: PAYOFF_GRADER_VERSION,
      recorded: { outcome: g.outcome, closeReason: g.closeReason, exitPrice: g.exitPrice, entryAt: g.entryAt, exitAt },
      observations: {
        total: window.length,
        bySource,
        firstAt: window[0]?.at ?? null,
        lastAt: window.length ? window[window.length - 1].at : null,
        maxGapSeconds: maxGap == null ? null : Math.round(maxGap / 1000),
        dense,
        denseThresholdSeconds: DENSE_MAX_GAP_MS / 1000,
      },
      verdict,
      verdictBasis: basis,
      targetLevel: { verdict: target.verdict, firstObservedAt: target.firstAt, observedBy: target.by },
      stopLevel: { verdict: stop.verdict, firstObservedAt: stop.firstAt, observedBy: stop.by },
      maxPremiumObserved: round(maxPremium),
      minPremiumObserved: round(minPremium),
      maxGainPct: round(maxGain != null && g.entry > 0 ? maxGain / g.entry : null),
      // Share of the projected gain the contract offered at its best observed price (1 = reached; null = no observation).
      projectionCaptured: round(maxGain != null && projectedGain != null && projectedGain > 0 ? maxGain / projectedGain : null),
      legacy: { targetReached: legacyTargetReached, marks: g.legacy?.marks ?? null },
      // The first grader said the target was not reached for a trade recorded as a target exit.
      legacyContradictedRecordedExit: isTargetExit && legacyTargetReached === false ? true : isTargetExit && legacyTargetReached === true ? false : null,
    },
  };
}
