// ============================================================
// SETUP COST MEASUREMENT — per-setup option cost and stop distance
// ============================================================
// Measurement only. Nothing in the decision path reads this; it never gates,
// sizes or moves an entry, stop or target. It is written onto setup_events so
// the diagnostics can say what costs took from each setup.
//
// The cost is the live gate's own estimate (estimateRoundTripCost, from
// TRADING_COST_MODEL), split into its parts so each is stored separately:
//   spread    ask − bid of the leg's live quote        OBSERVED when two-sided,
//                                                       else MODELLED (fallback %)
//   slippage  TRADING_COST_MODEL.slippagePct of premium MODELLED (paper trading has
//                                                       no fills to observe)
//   charges   statutory % of premium + brokerage       MODELLED (a fee schedule,
//             (2 orders + GST) spread over one lot      not a contract note)
// The parts sum to estimateRoundTripCost(...).perUnit exactly (pinned by test).
//
// R: the same unit as gross_rr (underlying T1 distance ÷ underlying stop
// distance). A cost per option unit becomes underlying points through the
// leg's |delta|, then R through the underlying stop:
//   cost_r = cost per unit ÷ (|delta| × |entry − stop|)
//   net_rr = gross_rr − cost_r
// No delta → no cost in R (never a flat 0.1R stand-in).
//
// Quality (of the market data, not of the schedule):
//   OBSERVED     premium and spread from a two-sided live quote
//   MODELLED     premium seen, but no two-sided quote: the spread is assumed
//   UNAVAILABLE  no option quote at this transition (WATCH, DEVELOPING, ...)
// ============================================================

import { TRADING_COST_MODEL, type CostDataQuality } from '@fno/shared';

export type ValueSource = 'OBSERVED' | 'MODELLED';

/** The option leg a setup was (or would have been) priced on. */
export interface OptionQuoteInput {
  side: 'CE' | 'PE';
  strike: number;
  expiry: string | null;
  /** TRADED: the minted contract. SELECTED: F&O validation's pick for a refused leg. ATM_PROXY: no contract was chosen, so the ATM leg of the same side stands in. */
  strikeBasis: 'TRADED' | 'SELECTED' | 'ATM_PROXY';
  /** Entry premium: the setup's own entry when it was built, else the leg's mid (or LTP without a two-sided quote). */
  premium: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  lotSize: number | null;
  /** The built setup's premium stop, when a setup was built. */
  premiumStop?: number | null;
}

export interface StopDistance {
  points: number | null;
  atr: number | null;
  /** % of the underlying entry. */
  pct: number | null;
  /** ₹ per lot the underlying stop represents (points × lot size). */
  underlyingRiskPerLot: number | null;
  /** Premium per option unit at risk to the stop. */
  optionRiskPerUnit: number | null;
  optionRiskPerLot: number | null;
  /** PREMIUM_STOP: the built setup's own premium stop. DELTA_X_STOP: |delta| × underlying stop, when no setup was built. */
  optionRiskBasis: 'PREMIUM_STOP' | 'DELTA_X_STOP' | null;
}

export interface SetupCostMeasurement {
  quality: CostDataQuality;
  option: OptionQuoteInput | null;
  sources: { premium: ValueSource | null; spread: ValueSource | null; slippage: ValueSource | null; charges: ValueSource | null };
  /** ₹ per option unit. */
  perUnit: { spread: number; slippage: number; charges: number; total: number } | null;
  costPctOfPremium: number | null;
  costR: number | null;
  spreadR: number | null;
  slippageR: number | null;
  chargesR: number | null;
  grossR: number | null;
  netR: number | null;
  stop: StopDistance;
  costVersion: string;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

export function measureStopDistance(args: { entry: number | null; stop: number | null; atr: number | null; lotSize?: number | null; option?: OptionQuoteInput | null }): StopDistance {
  const { entry, stop, atr } = args;
  const points = finite(entry) && finite(stop) ? Math.abs(entry - stop) : null;
  const lot = args.lotSize ?? args.option?.lotSize ?? null;
  const o = args.option ?? null;
  let optionRiskPerUnit: number | null = null;
  let optionRiskBasis: StopDistance['optionRiskBasis'] = null;
  if (o && finite(o.premium) && finite(o.premiumStop) && o.premium > o.premiumStop) {
    optionRiskPerUnit = o.premium - o.premiumStop;
    optionRiskBasis = 'PREMIUM_STOP';
  } else if (o && finite(o.delta) && points != null && points > 0) {
    optionRiskPerUnit = Math.abs(o.delta) * points;
    optionRiskBasis = 'DELTA_X_STOP';
  }
  return {
    points: points != null ? round4(points) : null,
    atr: points != null && finite(atr) && atr > 0 ? round4(points / atr) : null,
    pct: points != null && finite(entry) && entry > 0 ? round4((points / entry) * 100) : null,
    underlyingRiskPerLot: points != null && finite(lot) && lot > 0 ? round4(points * lot) : null,
    optionRiskPerUnit: optionRiskPerUnit != null ? round4(optionRiskPerUnit) : null,
    optionRiskPerLot: optionRiskPerUnit != null && finite(lot) && lot > 0 ? round4(optionRiskPerUnit * lot) : null,
    optionRiskBasis,
  };
}

/** Pure. Never throws for missing data: absent inputs give nulls and UNAVAILABLE. */
export function measureSetupCost(args: {
  entry: number | null;
  stop: number | null;
  t1: number | null;
  atr: number | null;
  option: OptionQuoteInput | null;
  costVersion: string;
}): SetupCostMeasurement {
  const { entry, stop, t1, option, costVersion } = args;
  const stopPts = finite(entry) && finite(stop) ? Math.abs(entry - stop) : null;
  const grossR = stopPts != null && stopPts > 0 && finite(t1) && finite(entry) ? round4(Math.abs(t1 - entry) / stopPts) : null;
  const stopDistance = measureStopDistance({ entry, stop, atr: args.atr, option });
  const none = { premium: null, spread: null, slippage: null, charges: null };

  const premium = option?.premium;
  if (!option || !finite(premium) || premium <= 0) {
    return { quality: 'UNAVAILABLE', option: option ?? null, sources: none, perUnit: null, costPctOfPremium: null, costR: null, spreadR: null, slippageR: null, chargesR: null, grossR, netR: null, stop: stopDistance, costVersion };
  }

  // The same arithmetic as estimateRoundTripCost (@fno/analytics), kept in parts.
  const twoSided = finite(option.bid) && finite(option.ask) && option.bid > 0 && option.ask > option.bid;
  const spread = twoSided ? option.ask! - option.bid! : premium * (TRADING_COST_MODEL.fallbackSpreadPct / 100);
  const slippage = premium * (TRADING_COST_MODEL.slippagePct / 100);
  const brokerage = 2 * TRADING_COST_MODEL.brokeragePerOrder * (1 + TRADING_COST_MODEL.gstPct / 100);
  const brokeragePerUnit = finite(option.lotSize) && option.lotSize > 0 ? brokerage / option.lotSize : 0;
  const charges = premium * (TRADING_COST_MODEL.statutoryPct / 100) + brokeragePerUnit;
  const total = spread + slippage + charges;

  // Cost in the underlying's R: per-unit cost → underlying points via |delta| → ÷ underlying stop.
  const riskUnit = finite(option.delta) && option.delta !== 0 && stopPts != null && stopPts > 0 ? Math.abs(option.delta) * stopPts : null;
  const inR = (v: number) => (riskUnit != null ? round4(v / riskUnit) : null);
  const costR = inR(total);

  return {
    quality: twoSided ? 'OBSERVED' : 'MODELLED',
    option,
    sources: { premium: 'OBSERVED', spread: twoSided ? 'OBSERVED' : 'MODELLED', slippage: 'MODELLED', charges: 'MODELLED' },
    perUnit: { spread: round4(spread), slippage: round4(slippage), charges: round4(charges), total: round4(total) },
    costPctOfPremium: round4((total / premium) * 100),
    costR,
    spreadR: inR(spread),
    slippageR: inR(slippage),
    chargesR: inR(charges),
    grossR,
    netR: grossR != null && costR != null ? round4(grossR - costR) : null,
    stop: stopDistance,
    costVersion,
  };
}
