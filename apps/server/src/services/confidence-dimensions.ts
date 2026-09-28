// ============================================================
// CONFIDENCE DIMENSIONS — persistence only (Phase 1)
// ============================================================
// The bias engine computes ten vote contributions on every read and keeps
// only their weighted total. This module shapes those ALREADY-COMPUTED
// numbers for the decision record, plus four rollups:
//
//   direction_score      the chart-vote net the direction was read from
//   setup_quality_score  the pre-regime weighted intelligence score
//   tradeability_score   the option-quality score, under the spec's name
//   execution_score      PROVISIONAL — see provisionalExecutionScore()
//
// Nothing here is read by any gate. MIN_SETUP_CONFIDENCE and every other
// threshold are untouched; this is so the next review can see WHICH
// dimension was weak on the trades that lost, instead of one blended number.
// ============================================================

/** The ten weighted dimensions behind `overall`, exactly as market-bias.ts computed them. */
export interface VoteContributions {
  trend: number;
  priceAction: number;
  futuresOi: number;
  optionsOi: number;
  pcr: number;
  iv: number;
  technicals: number;
  oiShifts: number;
  volume: number;
  relativeStrength: number;
}

/** Picks the ten contributions out of an IntelligenceScore-shaped object. */
export function voteContributionsFrom(score: VoteContributions): VoteContributions {
  return {
    trend: score.trend,
    priceAction: score.priceAction,
    futuresOi: score.futuresOi,
    optionsOi: score.optionsOi,
    pcr: score.pcr,
    iv: score.iv,
    technicals: score.technicals,
    oiShifts: score.oiShifts,
    volume: score.volume,
    relativeStrength: score.relativeStrength,
  };
}

// Provisional scales. Chosen to be readable, not fitted: 0 at a spread that
// would eat a typical intraday target, 0 at a quote two minutes old.
const EXECUTION_SPREAD_ZERO_AT_PCT = 10;
const EXECUTION_QUOTE_AGE_ZERO_AT_SECONDS = 120;
const EXECUTION_SPREAD_WEIGHT = 0.7;

export interface ExecutionScore {
  /** 0-100, or null when there was no two-sided quote to judge. */
  score: number | null;
  basis: {
    provisional: true;
    note: string;
    spreadPct: number | null;
    quoteAgeSeconds: number | null;
    spreadComponent: number | null;
    freshnessComponent: number | null;
  };
}

/**
 * PROVISIONAL execution score: how cleanly the paper entry could plausibly
 * have been filled, from the bid-ask spread and how old the quote was.
 *
 * No such score existed before. This is a deliberately simple stand-in until
 * Phase 2's execution-quality work (realistic bid/ask fills) replaces it, and
 * it is stored with its basis so nobody mistakes it for that. It gates
 * nothing and does not change the mid-price entry.
 */
export function provisionalExecutionScore(spreadPct: number | null | undefined, quoteAgeSeconds: number | null | undefined): ExecutionScore {
  const spread = spreadPct != null && Number.isFinite(spreadPct) && spreadPct >= 0 ? spreadPct : null;
  const age = quoteAgeSeconds != null && Number.isFinite(quoteAgeSeconds) && quoteAgeSeconds >= 0 ? quoteAgeSeconds : null;
  const spreadComponent = spread == null ? null : Math.max(0, 100 * (1 - spread / EXECUTION_SPREAD_ZERO_AT_PCT));
  const freshnessComponent = age == null ? null : Math.max(0, 100 * (1 - age / EXECUTION_QUOTE_AGE_ZERO_AT_SECONDS));

  let score: number | null = null;
  if (spreadComponent != null) {
    score =
      freshnessComponent != null
        ? Math.round(spreadComponent * EXECUTION_SPREAD_WEIGHT + freshnessComponent * (1 - EXECUTION_SPREAD_WEIGHT))
        : Math.round(spreadComponent);
  }

  return {
    score,
    basis: {
      provisional: true,
      note: 'Phase 1 stand-in from spread % and quote age; replaced by Phase 2 execution quality. Gates nothing.',
      spreadPct: spread,
      quoteAgeSeconds: age,
      spreadComponent: spreadComponent != null ? Math.round(spreadComponent) : null,
      freshnessComponent: freshnessComponent != null ? Math.round(freshnessComponent) : null,
    },
  };
}
