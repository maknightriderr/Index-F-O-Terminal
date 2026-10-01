// ============================================================
// SIGNAL DIAGNOSTICS METRICS — pure arithmetic over graded setup_events
// ============================================================
// The definitions the dashboard's tooltips quote. Every figure is a
// SIMULATED paper-trade outcome in R of the underlying stop, never account
// P&L. Callers group by instrument (and label INDEX / MCX); nothing here
// pools across groups.
// ============================================================

export type Segment = 'INDEX' | 'MCX';
export const segmentOf = (exchange: string): Segment => (exchange === 'MCX' ? 'MCX' : 'INDEX');

export interface GradedEventRow {
  time: number;
  resultR: number | null;
  netResultR: number | null;
  mfeR: number | null;
  maeR: number | null;
  costR: number | null;
  spreadR: number | null;
  slippageR: number | null;
  chargesR: number | null;
  costQuality: string | null;
}

export interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]) => (xs.length > 0 ? round4(sum(xs) / xs.length) : null);
const defined = (xs: readonly (number | null)[]) => xs.filter((x): x is number => x != null && Number.isFinite(x));

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator > 0 ? round4(numerator / denominator) : null };
}

/** Sum of winning R ÷ |sum of losing R|. Null with no losing trade (undefined, not infinite). */
export function profitFactor(values: readonly number[]): number | null {
  const wins = sum(values.filter((v) => v > 0));
  const losses = -sum(values.filter((v) => v < 0));
  return losses > 0 ? round4(wins / losses) : null;
}

/** Largest peak-to-trough fall of the cumulative R curve, in time order. 0 when it never falls. */
export function maxDrawdown(valuesInTimeOrder: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const v of valuesInTimeOrder) {
    equity += v;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak - equity);
  }
  return round4(worst);
}

export interface PerformanceStats {
  count: number;
  wins: number;
  winRate: number | null;
  grossR: number;
  avgGrossR: number | null;
  /** Rows with a measured cost; net figures cover only these. */
  netCount: number;
  netR: number | null;
  avgNetR: number | null;
  profitFactor: number | null;
  profitFactorNet: number | null;
  maxDrawdownR: number;
  maxDrawdownNetR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
}

/** Rows must be graded and filled (result_r present). Ordered by time inside. */
export function performanceStats(rows: readonly GradedEventRow[]): PerformanceStats {
  const ordered = [...rows].filter((r) => r.resultR != null).sort((a, b) => a.time - b.time);
  const gross = ordered.map((r) => r.resultR!);
  const net = defined(ordered.map((r) => r.netResultR));
  const wins = gross.filter((v) => v > 0).length;
  return {
    count: gross.length,
    wins,
    winRate: gross.length > 0 ? round4(wins / gross.length) : null,
    grossR: round4(sum(gross)),
    avgGrossR: mean(gross),
    netCount: net.length,
    netR: net.length > 0 ? round4(sum(net)) : null,
    avgNetR: mean(net),
    profitFactor: profitFactor(gross),
    profitFactorNet: net.length > 0 ? profitFactor(net) : null,
    maxDrawdownR: maxDrawdown(gross),
    maxDrawdownNetR: net.length > 0 ? maxDrawdown(net) : null,
    avgMfeR: mean(defined(ordered.map((r) => r.mfeR))),
    avgMaeR: mean(defined(ordered.map((r) => r.maeR))),
  };
}

export interface CostStats {
  /** Graded, filled rows that carry a cost in R. */
  priced: number;
  observed: number;
  modelled: number;
  totalCostR: number | null;
  avgCostR: number | null;
  /** Cost R taken out of trades that were winners before costs. */
  costLeakageR: number | null;
  /** Winners before costs that were not winners after them. */
  flippedByCost: number;
  spreadLeakageR: number | null;
  slippageLeakageR: number | null;
  chargesLeakageR: number | null;
}

export function costStats(rows: readonly GradedEventRow[]): CostStats {
  const priced = rows.filter((r) => r.costR != null && r.resultR != null);
  const total = (pick: (r: GradedEventRow) => number | null) => {
    const xs = defined(priced.map(pick));
    return xs.length > 0 ? round4(sum(xs)) : null;
  };
  const grossWinners = priced.filter((r) => r.resultR! > 0);
  return {
    priced: priced.length,
    observed: priced.filter((r) => r.costQuality === 'OBSERVED').length,
    modelled: priced.filter((r) => r.costQuality === 'MODELLED').length,
    totalCostR: total((r) => r.costR),
    avgCostR: mean(defined(priced.map((r) => r.costR))),
    costLeakageR: grossWinners.length > 0 ? round4(sum(grossWinners.map((r) => r.costR!))) : priced.length > 0 ? 0 : null,
    flippedByCost: grossWinners.filter((r) => r.resultR! - r.costR! <= 0).length,
    spreadLeakageR: total((r) => r.spreadR),
    slippageLeakageR: total((r) => r.slippageR),
    chargesLeakageR: total((r) => r.chargesR),
  };
}

export interface OpportunityStats {
  /** Every objective opportunity, data gaps included. */
  opportunities: number;
  /** Opportunities in an uncovered session or a recording gap: not judged. */
  dataGap: number;
  /** The denominator of every rate: opportunities − dataGap. */
  coveredOpportunities: number;
  detected: number;
  traded: number;
  rejected: number;
  late: number;
  neverDetected: number;
  detectionRate: Rate;
  captureRate: Rate;
  missedRate: Rate;
  lateRate: Rate;
  rejectionRate: Rate;
}

/** From census window classifications: TRADED / DETECTED_BUT_REJECTED / DETECTED_LATE / NEVER_DETECTED / DATA_GAP. */
export function opportunityStats(counts: Readonly<Record<string, number>>): OpportunityStats {
  const traded = counts.TRADED ?? 0;
  const rejected = counts.DETECTED_BUT_REJECTED ?? 0;
  const late = counts.DETECTED_LATE ?? 0;
  const neverDetected = counts.NEVER_DETECTED ?? 0;
  const dataGap = counts.DATA_GAP ?? 0;
  const covered = traded + rejected + late + neverDetected;
  const detected = traded + rejected + late;
  return {
    opportunities: covered + dataGap,
    dataGap,
    coveredOpportunities: covered,
    detected,
    traded,
    rejected,
    late,
    neverDetected,
    detectionRate: rate(detected, covered),
    captureRate: rate(traded, covered),
    missedRate: rate(neverDetected, covered),
    lateRate: rate(late, covered),
    rejectionRate: rate(rejected, covered),
  };
}
