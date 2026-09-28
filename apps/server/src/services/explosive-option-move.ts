// ============================================================
// EXPLOSIVE OPTION MOVE — a generalised scenario classifier
// ============================================================
// Names a class of move, not a trade: a cheap out-of-the-money option whose
// premium expands many times over because a structural break in the
// underlying ran in its favour while implied volatility expanded with it —
// the convex payoff an option buyer is ultimately hunting for.
//
// It is GENERAL on purpose. No symbol, strike, expiry or premium appears in
// this file: every criterion is a ratio or a relative threshold, so the same
// classifier applies to any underlying. Specific example scenarios live only
// in test fixtures, and those fixtures are synthetic.
//
// What it is for: a regression anchor. Once historical option-chain data is
// available, a real replay can be run through this same classifier to ask
// whether the engine would have recognised such a move. Until then it is
// exercised only on fabricated data, and it is not wired into any live
// decision — it gates nothing and selects nothing.
// ============================================================

export interface ExplosiveMoveThresholds {
  /** Peak premium must reach at least this multiple of the entry premium. */
  minPremiumMultiple: number;
  /** Entry premium as a % of spot at or below which the option counts as "cheap". */
  maxEntryPremiumPctOfSpot: number;
  /** IV must expand by at least this many volatility points (IV in %), or by the ratio below. */
  minIvExpansionPoints: number;
  minIvExpansionRatio: number;
  /** Option % gain divided by underlying % move in the option's favour. */
  minConvexity: number;
}

export const DEFAULT_EXPLOSIVE_MOVE_THRESHOLDS: ExplosiveMoveThresholds = {
  minPremiumMultiple: 5,
  maxEntryPremiumPctOfSpot: 1,
  minIvExpansionPoints: 10,
  minIvExpansionRatio: 1.3,
  minConvexity: 10,
};

export interface OptionPathPoint {
  /** Epoch ms. */
  t: number;
  premium: number;
  /** Implied volatility in % (e.g. 35 for 35%). Null when not quoted. */
  iv: number | null;
  underlying: number;
}

export interface ExplosiveMoveInput {
  side: 'CE' | 'PE';
  strike: number;
  /** The option's path from entry onward; the first point is the entry. */
  path: readonly OptionPathPoint[];
  /** The last market-structure event on the underlying at or after entry, as analyzeMarketStructure() reports it. */
  structureEvent: { type: 'BOS' | 'CHOCH'; direction: 'BULLISH' | 'BEARISH' } | null;
  thresholds?: ExplosiveMoveThresholds;
}

export interface CriterionResult {
  pass: boolean;
  value: number | string | null;
  threshold: number | string;
}

export interface ExplosiveMoveClassification {
  classification: 'EXPLOSIVE_OPTION_MOVE' | 'NONE';
  isExplosive: boolean;
  criteria: {
    outOfTheMoneyAtEntry: CriterionResult;
    cheapAtEntry: CriterionResult;
    premiumMultiple: CriterionResult;
    ivExpansion: CriterionResult;
    structureBreakInFavour: CriterionResult;
    convexity: CriterionResult;
  };
  peakAt: number | null;
}

/** Classifies an option path. Pure; returns every criterion so a miss says which one failed. */
export function classifyExplosiveOptionMove(input: ExplosiveMoveInput): ExplosiveMoveClassification {
  const th = input.thresholds ?? DEFAULT_EXPLOSIVE_MOVE_THRESHOLDS;
  const entry = input.path[0];
  const fail = (value: number | string | null, threshold: number | string): CriterionResult => ({ pass: false, value, threshold });

  if (!entry || !(entry.premium > 0) || !(entry.underlying > 0)) {
    return {
      classification: 'NONE',
      isExplosive: false,
      criteria: {
        outOfTheMoneyAtEntry: fail(null, 'OTM'),
        cheapAtEntry: fail(null, th.maxEntryPremiumPctOfSpot),
        premiumMultiple: fail(null, th.minPremiumMultiple),
        ivExpansion: fail(null, th.minIvExpansionPoints),
        structureBreakInFavour: fail(null, 'BOS/CHOCH in favour'),
        convexity: fail(null, th.minConvexity),
      },
      peakAt: null,
    };
  }

  const bearishOption = input.side === 'PE';
  const otm = bearishOption ? input.strike < entry.underlying : input.strike > entry.underlying;
  const entryPremiumPct = (entry.premium / entry.underlying) * 100;

  const peak = input.path.reduce((best, p) => (p.premium > best.premium ? p : best), entry);
  const multiple = peak.premium / entry.premium;

  const ivs = input.path.map((p) => p.iv).filter((v): v is number => v != null && v > 0);
  const entryIv = entry.iv != null && entry.iv > 0 ? entry.iv : null;
  const peakIv = ivs.length > 0 ? Math.max(...ivs) : null;
  const ivPoints = entryIv != null && peakIv != null ? peakIv - entryIv : null;
  const ivRatio = entryIv != null && peakIv != null ? peakIv / entryIv : null;
  const ivPass = ivPoints != null && ivRatio != null && (ivPoints >= th.minIvExpansionPoints || ivRatio >= th.minIvExpansionRatio);

  const wanted = bearishOption ? 'BEARISH' : 'BULLISH';
  const structurePass = input.structureEvent != null && input.structureEvent.direction === wanted;

  const underlyingMovePct = ((bearishOption ? entry.underlying - peak.underlying : peak.underlying - entry.underlying) / entry.underlying) * 100;
  const premiumGainPct = (multiple - 1) * 100;
  const convexity = underlyingMovePct > 0 ? premiumGainPct / underlyingMovePct : null;

  const criteria = {
    outOfTheMoneyAtEntry: { pass: otm, value: otm ? 'OTM' : 'ITM/ATM', threshold: 'OTM' },
    cheapAtEntry: { pass: entryPremiumPct <= th.maxEntryPremiumPctOfSpot, value: round(entryPremiumPct), threshold: th.maxEntryPremiumPctOfSpot },
    premiumMultiple: { pass: multiple >= th.minPremiumMultiple, value: round(multiple), threshold: th.minPremiumMultiple },
    ivExpansion: { pass: ivPass, value: ivPoints != null ? round(ivPoints) : null, threshold: th.minIvExpansionPoints },
    structureBreakInFavour: {
      pass: structurePass,
      value: input.structureEvent ? `${input.structureEvent.type} ${input.structureEvent.direction}` : null,
      threshold: `BOS/CHOCH ${wanted}`,
    },
    convexity: { pass: convexity != null && convexity >= th.minConvexity, value: convexity != null ? round(convexity) : null, threshold: th.minConvexity },
  } satisfies ExplosiveMoveClassification['criteria'];

  const isExplosive = Object.values(criteria).every((c) => c.pass);
  return {
    classification: isExplosive ? 'EXPLOSIVE_OPTION_MOVE' : 'NONE',
    isExplosive,
    criteria,
    peakAt: peak.t,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
