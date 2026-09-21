/**
 * OPTION QUALITY
 *
 * The trade is not "a good NIFTY read plus whatever contract is nearest the
 * money". It is the underlying edge, the entry, AND the instrument, and for
 * an option BUYER the instrument can lose a correct directional call on its
 * own: delta too low to convert the move into premium, theta eating more per
 * day than the move is worth, IV rich enough that being right about
 * direction still loses to the vol crush, or a contract nobody is trading so
 * the exit is fiction.
 *
 * This module scores those. It lives in the analytics package, not the
 * server, because the live engine and any historical replay must run the
 * SAME function over the same inputs — a second copy of this logic written
 * for a backtester would make the backtest meaningless.
 *
 * WHAT IS ENFORCED AND WHAT IS NOT
 *
 * The components split into two kinds, and they are treated differently on
 * purpose.
 *
 *   TRADEABILITY is mechanical: is there a two-sided market, is anyone
 *   trading this contract, is the premium above the level where one tick of
 *   granularity swamps the edge. These are not predictions about what wins.
 *   They are statements about whether the trade can be executed and exited
 *   at anything like the price the setup was sized from. Getting one wrong
 *   costs real money with certainty, so these GATE.
 *
 *   PREDICTIVE QUALITY is a hypothesis: that low delta, heavy theta and rich
 *   IV make an otherwise-good setup lose. The evidence for it is strong in
 *   theory and unmeasured in this book — there is not yet a single recorded
 *   trade carrying an option-quality score. So these are SCORED AND
 *   RECORDED, and they do not refuse anything. They get promoted the way
 *   every other rule here does: on their own out-of-sample evidence.
 *
 * Note what already exists and is NOT re-implemented here: the bid-ask
 * spread ceiling (5% of mid on the ATM leg), the no-quote refusal, the delta
 * sanity range, and the cost-aware reward:risk floor all live in
 * trade-setup/index.ts and already gate. This module adds the liquidity,
 * delta-efficiency, theta-burn, IV-richness and premium-granularity reads
 * that nothing was looking at.
 */

export type OptionQualityGrade = 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'UNTRADEABLE';

export interface OptionQualityInput {
  /** Premium the setup is sized from (bid-ask mid where available). */
  entryPremium: number;
  bid: number;
  ask: number;
  /** Contracts traded in this leg today. */
  volume: number;
  openInterest: number;
  /** Signed delta as the chain reports it; magnitude is what matters to a buyer. */
  delta: number;
  /** Theta per day in premium points, as the chain reports it (negative for a long). */
  theta: number;
  iv: number;
  /** Percentile rank of today's ATM IV in its own trailing year, 0-100. Null when history is too short. */
  ivRank: number | null;
  /** Realised volatility of the underlying over a comparable window, in % — for the IV-vs-HV read. */
  hvPct: number | null;
  /** Calendar days to expiry. */
  dte: number;
  /** Absolute distance from spot to this strike, in underlying points. */
  distanceFromSpot: number;
  /** Underlying move the setup expects to capture, in points. */
  expectedMovePoints: number;
  /** Hours the position is expected to be held — sets how much theta actually gets paid. */
  expectedHoldHours: number;
  /** Exchange tick size for this contract's premium. */
  tickSize: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  /** Whether the Greeks came from the broker or were solved locally. */
  greeksSource: 'BROKER' | 'CALCULATED';
}

export interface OptionQualityComponent {
  name: string;
  /** 0-100. */
  score: number;
  /** How much this component counts toward the overall score. */
  weight: number;
  detail: string;
}

export interface OptionQualityAssessment {
  /** 0-100, weighted over the components. Records quality; does not gate. */
  score: number;
  grade: OptionQualityGrade;
  /**
   * False ONLY for a mechanical tradeability failure. A POOR grade with
   * tradeable=true is recorded and traded, because the predictive half of
   * this engine is not validated yet.
   */
  tradeable: boolean;
  /** Set when tradeable is false. */
  refusalReason: string | null;
  components: OptionQualityComponent[];
  /** Premium the expected move should produce, in points — delta-implied, theta-netted. */
  expectedPremiumGain: number | null;
  /** Theta paid over the expected hold, in premium points. */
  thetaCostOverHold: number | null;
  /** Expected premium gain divided by theta paid. Below 1 the clock wins even if the direction is right. */
  thetaEfficiency: number | null;
  /** Human-readable summary, for the trade explanation. */
  summary: string;
}

// ---- Tradeability floors. These gate. ----

/**
 * Below this many contracts traded today, the exit is a hope rather than a
 * plan: a position taken on a leg nobody else is trading has to be unwound
 * into whatever the market maker feels like quoting. Deliberately low — it
 * is a floor against dead contracts, not a liquidity preference.
 */
export const MIN_LEG_VOLUME = 100;

/**
 * Open interest floor, same reasoning. A leg can have low volume today and
 * deep OI (perfectly tradeable); it is the combination of thin volume AND
 * thin OI that means nobody is there.
 */
export const MIN_LEG_OI = 500;

/**
 * A premium this small cannot express a stop. One tick on a 2-rupee option
 * is a 2.5% move, so a 15% stop is six ticks away and ordinary bid-ask
 * jitter walks through it. Expressed in ticks rather than rupees so it holds
 * across contracts with different tick sizes.
 */
export const MIN_PREMIUM_TICKS = 20;

// ---- Predictive thresholds. These score only. ----

/**
 * Delta is the fraction of the underlying's move a buyer actually collects.
 * At 0.25, a 100-point move in the right direction pays 25 points of premium
 * before theta — and the same contract loses on any move that stalls. This
 * is the level below which the instrument stops being a way to express the
 * view.
 */
export const MIN_USEFUL_DELTA = 0.25;
/** Delta at or above this is a full-blooded expression of the underlying move. */
export const GOOD_DELTA = 0.45;

/**
 * Expected premium gain divided by theta paid over the hold. Below 1.0 the
 * clock takes more than the move gives even when the direction is right.
 */
export const MIN_THETA_EFFICIENCY = 1.0;
export const GOOD_THETA_EFFICIENCY = 3.0;

/** IV rank above this means buying premium near its own yearly highs. */
export const RICH_IV_RANK = 75;
/** IV this many times realised volatility is rich regardless of its own rank. */
export const RICH_IV_VS_HV = 1.6;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function assessOptionQuality(input: OptionQualityInput): OptionQualityAssessment {
  const components: OptionQualityComponent[] = [];
  const absDelta = Math.abs(input.delta);
  const hasQuote = input.bid > 0 && input.ask > 0;
  const mid = hasQuote ? (input.bid + input.ask) / 2 : input.entryPremium;
  const spreadPct = hasQuote && mid > 0 ? ((input.ask - input.bid) / mid) * 100 : null;

  // ---------------- Tradeability: these refuse ----------------

  const premiumTicks = input.tickSize > 0 ? input.entryPremium / input.tickSize : Infinity;
  if (premiumTicks < MIN_PREMIUM_TICKS) {
    return untradeable(
      components,
      `Premium ${round(input.entryPremium)} is only ${Math.floor(premiumTicks)} ticks — a stop cannot be placed outside ordinary bid-ask jitter on a contract this cheap.`,
      input
    );
  }

  if (input.volume < MIN_LEG_VOLUME && input.openInterest < MIN_LEG_OI) {
    return untradeable(
      components,
      `Nobody is trading this contract — ${input.volume} traded today against ${input.openInterest} open interest. The exit would have to be negotiated rather than taken.`,
      input
    );
  }

  // ---------------- Predictive: these score ----------------

  // Liquidity, as depth rather than a pass/fail.
  const volumeScore = clamp((Math.log10(Math.max(input.volume, 1)) / Math.log10(50_000)) * 100);
  const oiScore = clamp((Math.log10(Math.max(input.openInterest, 1)) / Math.log10(500_000)) * 100);
  components.push({
    name: 'liquidity',
    score: round(volumeScore * 0.5 + oiScore * 0.5),
    weight: 0.2,
    detail: `${input.volume.toLocaleString('en-IN')} traded, ${input.openInterest.toLocaleString('en-IN')} open interest`,
  });

  // Spread, as quality rather than the existing hard ceiling.
  const spreadScore = spreadPct == null ? 50 : clamp(100 - spreadPct * 20);
  components.push({
    name: 'spread',
    score: round(spreadScore),
    weight: 0.15,
    detail: spreadPct == null ? 'no two-sided market published; sized off LTP' : `${round(spreadPct, 1)}% of mid`,
  });

  // Delta efficiency: how much of the move this contract converts.
  const deltaScore = clamp(((absDelta - 0.1) / (GOOD_DELTA - 0.1)) * 100);
  components.push({
    name: 'delta',
    score: round(deltaScore),
    weight: 0.25,
    detail:
      absDelta < MIN_USEFUL_DELTA
        ? `${round(absDelta)} — below ${MIN_USEFUL_DELTA}, so most of a correct move is not collected`
        : `${round(absDelta)} of the underlying move is captured`,
  });

  // Theta burn against what the move is expected to pay.
  const expectedPremiumGain = input.expectedMovePoints > 0 ? absDelta * input.expectedMovePoints : null;
  const thetaPerDay = Math.abs(input.theta);
  const thetaCostOverHold =
    thetaPerDay > 0 && input.expectedHoldHours > 0 ? thetaPerDay * (input.expectedHoldHours / 24) : null;
  const thetaEfficiency =
    expectedPremiumGain != null && thetaCostOverHold != null && thetaCostOverHold > 0
      ? expectedPremiumGain / thetaCostOverHold
      : null;
  const thetaScore =
    thetaEfficiency == null
      ? 50
      : clamp(((thetaEfficiency - MIN_THETA_EFFICIENCY) / (GOOD_THETA_EFFICIENCY - MIN_THETA_EFFICIENCY)) * 100);
  components.push({
    name: 'theta',
    score: round(thetaScore),
    weight: 0.2,
    detail:
      thetaEfficiency == null
        ? 'no usable theta or expected-move data'
        : `the expected move pays ${round(expectedPremiumGain ?? 0)} against ${round(thetaCostOverHold ?? 0)} of decay over ${round(input.expectedHoldHours, 1)}h (${round(thetaEfficiency)}x)`,
  });

  // IV richness: buying premium expensive is a way to be right and lose.
  const ivVsHv = input.hvPct != null && input.hvPct > 0 ? (input.iv * 100) / input.hvPct : null;
  let ivScore = 50;
  const ivNotes: string[] = [];
  if (input.ivRank != null) {
    ivScore = clamp(100 - input.ivRank);
    ivNotes.push(`IV rank ${Math.round(input.ivRank)}`);
  }
  if (ivVsHv != null) {
    const vsHvScore = clamp(100 - (ivVsHv - 1) * 100);
    ivScore = input.ivRank != null ? (ivScore + vsHvScore) / 2 : vsHvScore;
    ivNotes.push(`IV ${round(ivVsHv)}x realised`);
  }
  if (ivNotes.length === 0) ivNotes.push('no IV history for this symbol');
  components.push({ name: 'iv', score: round(ivScore), weight: 0.2, detail: ivNotes.join(', ') });

  const weightTotal = components.reduce((a, c) => a + c.weight, 0);
  let score = round(components.reduce((a, c) => a + c.score * c.weight, 0) / (weightTotal || 1), 0);

  // The components are not substitutes for one another, so a weighted mean
  // alone is the wrong shape. A contract with 0.12 delta is a bad way to
  // express a directional view no matter how tight its spread and how deep
  // its book — but deep liquidity and a tight spread are enough to carry the
  // mean back into GOOD, which is how an average hides a fatal flaw. Two
  // dimensions are therefore capping rather than contributing: if the
  // instrument does not convert the move into premium, or the decay over the
  // hold outruns what the move pays, the overall read cannot be better than
  // POOR regardless of what the rest looks like.
  const caps: string[] = [];
  if (absDelta < MIN_USEFUL_DELTA) {
    caps.push(`delta ${round(absDelta)} below ${MIN_USEFUL_DELTA}`);
  }
  if (thetaEfficiency != null && thetaEfficiency < MIN_THETA_EFFICIENCY) {
    caps.push(`decay over the hold outruns the expected move (${round(thetaEfficiency)}x)`);
  }
  if (caps.length > 0) score = Math.min(score, 44);

  // Grade bands. UNTRADEABLE is reserved for the mechanical refusals above,
  // so the worst a scored contract can grade here is POOR.
  const grade: OptionQualityGrade = score >= 65 ? 'GOOD' : score >= 45 ? 'ACCEPTABLE' : 'POOR';

  const weakest = [...components].sort((a, b) => a.score - b.score)[0];
  const summaryParts = [`Option quality ${score}/100 (${grade.toLowerCase()})`];
  if (caps.length > 0) summaryParts.push(`capped at poor: ${caps.join('; ')}`);
  else if (grade !== 'GOOD' && weakest) summaryParts.push(`weakest on ${weakest.name}: ${weakest.detail}`);
  if (input.greeksSource === 'CALCULATED') summaryParts.push('Greeks solved locally, not broker-published');
  if (input.moneyness === 'OTM' && input.dte <= 1) {
    summaryParts.push('OTM on expiry day — premium is almost entirely gamma and goes to zero if the move does not arrive');
  }

  return {
    score,
    grade,
    tradeable: true,
    refusalReason: null,
    components,
    expectedPremiumGain: expectedPremiumGain == null ? null : round(expectedPremiumGain),
    thetaCostOverHold: thetaCostOverHold == null ? null : round(thetaCostOverHold),
    thetaEfficiency: thetaEfficiency == null ? null : round(thetaEfficiency),
    summary: summaryParts.join('. ') + '.',
  };
}

function untradeable(
  components: OptionQualityComponent[],
  reason: string,
  input: OptionQualityInput
): OptionQualityAssessment {
  return {
    score: 0,
    grade: 'UNTRADEABLE',
    tradeable: false,
    refusalReason: reason,
    components,
    expectedPremiumGain: null,
    thetaCostOverHold: null,
    thetaEfficiency: null,
    summary: `Option is untradeable: ${reason} Premium ${round(input.entryPremium)}, ${input.volume} traded, ${input.openInterest} open interest.`,
  };
}
