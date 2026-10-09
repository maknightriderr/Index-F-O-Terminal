// ============================================================
// MEASUREMENT CORE — cohorts, eligibility, the conservative-fill scenario and
// the aggregation that keeps denominators honest (2026-10-09)
// ============================================================
// Pure: no database, no Redis. The report (measurement-report.ts) loads closed
// paper trades and feeds them here; every number it returns is computed by these
// functions, so they can be tested without a database and replayed on any
// export of the trades.
//
// Nothing here decides, gates or changes a trade. The recorded outcome, exit,
// stop and target of every trade are inputs; none is modified.
// ============================================================

import { TRADING_COST_MODEL } from '@fno/shared';

// ---------------- cohorts ----------------

/** The 5 October architecture change (signal-engine-metrics.ts ARCHITECTURE_CHANGE_AT) — the baseline; never moved. */
export const BASELINE_CHANGE_AT = Date.parse('2026-10-05T12:00:00Z');
/**
 * Deployment of the H1/H2 tracking fixes (PR #33: slot compare-and-set, never-lost closes,
 * recovery, TRACKING_LOST). Trades closed before it could be overwritten, double-closed or
 * lost, so they are reported apart from trades minted after it.
 */
export const TRACKING_FIX_DEPLOYED_AT = Date.parse('2026-10-08T21:38:00Z');
/**
 * First instant from which a trade carries the new measurements (cost record at the mint, a
 * post-exit watch at the close): the first full session after the release. Earlier trades have
 * none of them and are never back-filled.
 */
export const MEASUREMENT_RELIABLE_FROM = Date.parse('2026-10-12T00:00:00+05:30');

export type Cohort = 'PRE' | 'POST_A' | 'POST_B';
export const COHORTS: readonly Cohort[] = ['PRE', 'POST_A', 'POST_B'];

/** PRE: before the 5 Oct change. POST_A: after it, before the tracking fixes. POST_B: after the tracking fixes. By MINT time. */
export function cohortOf(mintedAt: number): Cohort {
  if (mintedAt < BASELINE_CHANGE_AT) return 'PRE';
  return mintedAt < TRACKING_FIX_DEPLOYED_AT ? 'POST_A' : 'POST_B';
}

// ---------------- the trade record the report reads ----------------

export interface MeasuredTrade {
  id: string;
  symbol: string;
  exchange: string;
  family: string;
  mintedAt: number;
  mode: string;
  structureType: string;
  outcome: string | null;
  closeReason: string | null;
  voided: boolean;
  generatedOffSession: boolean;
  entry: number | null;
  /** The stop AT THE MINT. */
  initialStop: number | null;
  target: number | null;
  exitPrice: number | null;
  estimatedCostPct: number | null;
  /** From trade_cost_records when one exists. */
  cost: { spreadPerUnit: number; spreadSource: 'QUOTE' | 'FALLBACK_ASSUMED'; totalPerUnit: number } | null;
}

export type Eligibility = 'ELIGIBLE' | 'VOIDED' | 'TRACKING_LOST' | 'OFF_SESSION' | 'OPEN' | 'SPREAD' | 'NO_GEOMETRY';

/**
 * Which population a row belongs to. Order matters and is fixed: a TRACKING_LOST row is
 * voided too, but is reported as its own category so the two are not confused. Only ELIGIBLE
 * rows enter any performance figure; every other category is counted, not hidden.
 */
export function eligibilityOf(t: MeasuredTrade): Eligibility {
  if (t.closeReason === 'TRACKING_LOST') return 'TRACKING_LOST';
  if (t.voided) return 'VOIDED';
  if (t.generatedOffSession) return 'OFF_SESSION';
  if (t.structureType === 'SPREAD') return 'SPREAD';
  if (t.outcome == null) return 'OPEN';
  if (!(t.entry != null && t.entry > 0) || t.initialStop == null || !(t.entry - t.initialStop > 0) || t.exitPrice == null) return 'NO_GEOMETRY';
  return 'ELIGIBLE';
}

// ---------------- the conservative-fill scenario ----------------

/**
 * CONSERVATIVE_FILL_V1 — fixed here, before any result was computed with it, and not tuned.
 *
 * The paper engine credits a target exit at min(last traded price, target): a limit sell that
 * fills the instant the price touches it, with no queue and no spread. A real limit sell fills
 * on the bid. The scenario gives back HALF the contract's quoted bid-ask spread on every
 * target exit (the sell leg crosses half of it from the mid), never less than one tick.
 *
 *   haircut h = max(MIN_TICK, HALF_SPREAD_FRACTION × spread at entry)
 *   conservative exit = recorded exit − h          (target exits only)
 *
 * Stop, time, expiry and every other exit are unchanged: they fill at the last traded price
 * already, which is not an idealisation. The same modelled cost (estimatedCostPct) is
 * deducted in both scenarios, so the difference between them isolates the fill. That cost
 * already holds a full spread, so the scenario partly double-counts it: read it as a lower
 * bound on the net result, not an estimate of it.
 *
 * The spread is the one quoted at the mint (trade_cost_records); where none was recorded
 * the cost model's own fallback spread is used and the row is flagged FALLBACK_ASSUMED.
 */
export const CONSERVATIVE_FILL = Object.freeze({
  id: 'CONSERVATIVE_FILL_V1',
  version: 'FILL-1.0',
  HALF_SPREAD_FRACTION: 0.5,
  MIN_TICK: 0.05,
  FALLBACK_SPREAD_PCT: TRADING_COST_MODEL.fallbackSpreadPct,
});

export interface FillScenario {
  /** R per unit risk (entry − initial stop). */
  baselineGrossR: number;
  baselineNetR: number | null;
  conservativeGrossR: number;
  conservativeNetR: number | null;
  haircut: number | null;
  spreadBasis: 'QUOTE' | 'FALLBACK_ASSUMED' | 'NOT_APPLICABLE';
  /** True when a target exit is no longer a gain after the haircut. */
  winBecomesLoss: boolean;
  appliesToExit: boolean;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Pure: baseline vs conservative result of one ELIGIBLE trade. */
export function fillScenarioOf(t: MeasuredTrade): FillScenario | null {
  if (eligibilityOf(t) !== 'ELIGIBLE') return null;
  const entry = t.entry!;
  const risk = entry - t.initialStop!;
  const exit = t.exitPrice!;
  const costR = t.estimatedCostPct != null ? ((t.estimatedCostPct / 100) * entry) / risk : null;
  const baselineGrossR = (exit - entry) / risk;
  const targetExit = t.outcome === 'WIN' && (t.closeReason === 'TARGET' || t.closeReason == null);
  let haircut: number | null = null;
  let spreadBasis: FillScenario['spreadBasis'] = 'NOT_APPLICABLE';
  if (targetExit) {
    const spread = t.cost ? t.cost.spreadPerUnit : entry * (CONSERVATIVE_FILL.FALLBACK_SPREAD_PCT / 100);
    spreadBasis = t.cost ? t.cost.spreadSource : 'FALLBACK_ASSUMED';
    haircut = Math.max(CONSERVATIVE_FILL.MIN_TICK, CONSERVATIVE_FILL.HALF_SPREAD_FRACTION * spread);
  }
  const conservativeExit = haircut != null ? exit - haircut : exit;
  const conservativeGrossR = (conservativeExit - entry) / risk;
  return {
    baselineGrossR: r4(baselineGrossR),
    baselineNetR: costR == null ? null : r4(baselineGrossR - costR),
    conservativeGrossR: r4(conservativeGrossR),
    conservativeNetR: costR == null ? null : r4(conservativeGrossR - costR),
    haircut: haircut == null ? null : r4(haircut),
    spreadBasis,
    winBecomesLoss: targetExit && conservativeExit < entry,
    appliesToExit: targetExit,
  };
}

// ---------------- aggregation ----------------

export interface Tally {
  /** Every row in the group, whatever its category. */
  rows: number;
  excluded: { VOIDED: number; TRACKING_LOST: number; OFF_SESSION: number; OPEN: number; SPREAD: number; NO_GEOMETRY: number };
  /** ELIGIBLE closed trades — the denominator of everything below. */
  n: number;
  wins: number;
  losses: number;
  /** EXPIRED is its own category; never folded into wins or losses. */
  expired: number;
  winRateClosedOnly: number | null;
  winRateAllTrades: number | null;
  expiredShare: number | null;
  baseline: { grossR: number | null; netR: number | null; nNet: number; grossRSameTradesAsNet: number | null };
  /** MODELLED_SENSITIVITY: a what-if on the paper fills — not execution performance. */
  conservative: { basis: 'MODELLED_SENSITIVITY'; grossR: number | null; netR: number | null; nNet: number; grossRSameTradesAsNet: number | null };
  /** The number of trades behind each metric. Net R covers only trades with a recorded cost %, so compare it only with grossRSameTradesAsNet or between groups with equal nNet. */
  denominators: { winRateClosedOnly: number; winRateAllTrades: number; expiredShare: number; grossR: number; netR: number };
  /** Mean R given back to the haircut, over the target exits it applies to. */
  targetExits: { n: number; meanHaircut: number | null; becomeLosses: number; spreadFromQuote: number; spreadFallback: number };
}

const mean = (xs: number[]) => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Pure: one group of trades into a Tally. Win rates are in percent; R figures are means per eligible trade. */
export function tallyOf(trades: readonly MeasuredTrade[]): Tally {
  const excluded = { VOIDED: 0, TRACKING_LOST: 0, OFF_SESSION: 0, OPEN: 0, SPREAD: 0, NO_GEOMETRY: 0 };
  let wins = 0;
  let losses = 0;
  let expired = 0;
  const bg: number[] = [];
  const bn: number[] = [];
  const bgN: number[] = [];
  const cgN: number[] = [];
  const cg: number[] = [];
  const cn: number[] = [];
  let tx = 0;
  const hair: number[] = [];
  let becomeLoss = 0;
  let quote = 0;
  let fallback = 0;
  for (const t of trades) {
    const e = eligibilityOf(t);
    if (e !== 'ELIGIBLE') {
      excluded[e]++;
      continue;
    }
    if (t.outcome === 'WIN') wins++;
    else if (t.outcome === 'LOSS') losses++;
    else expired++;
    const f = fillScenarioOf(t)!;
    bg.push(f.baselineGrossR);
    cg.push(f.conservativeGrossR);
    if (f.baselineNetR != null && f.conservativeNetR != null) {
      bn.push(f.baselineNetR);
      cn.push(f.conservativeNetR);
      bgN.push(f.baselineGrossR);
      cgN.push(f.conservativeGrossR);
    }
    if (f.appliesToExit) {
      tx++;
      if (f.haircut != null) hair.push(f.haircut);
      if (f.winBecomesLoss) becomeLoss++;
      if (f.spreadBasis === 'QUOTE') quote++;
      else fallback++;
    }
  }
  const n = wins + losses + expired;
  return {
    rows: trades.length,
    excluded,
    n,
    wins,
    losses,
    expired,
    winRateClosedOnly: rate(wins, wins + losses),
    winRateAllTrades: rate(wins, n),
    expiredShare: rate(expired, n),
    baseline: { grossR: mean(bg), netR: mean(bn), nNet: bn.length, grossRSameTradesAsNet: mean(bgN) },
    conservative: { basis: 'MODELLED_SENSITIVITY', grossR: mean(cg), netR: mean(cn), nNet: cn.length, grossRSameTradesAsNet: mean(cgN) },
    denominators: { winRateClosedOnly: wins + losses, winRateAllTrades: n, expiredShare: n, grossR: n, netR: bn.length },
    targetExits: { n: tx, meanHaircut: mean(hair), becomeLosses: becomeLoss, spreadFromQuote: quote, spreadFallback: fallback },
  };
}

export interface GroupedTallies {
  cohort: Cohort;
  family: string;
  instrument: string;
  tally: Tally;
}

/**
 * Pure: tallies by cohort × family × instrument — and the same by cohort × family, and by
 * cohort alone, so a family is never judged on one instrument's trades and no group is
 * pooled across cohorts. Groups are never merged: each trade is in exactly one cohort.
 */
export function groupTallies(trades: readonly MeasuredTrade[]): { byCohort: Array<{ cohort: Cohort; tally: Tally }>; byFamily: Array<{ cohort: Cohort; family: string; tally: Tally }>; byInstrument: GroupedTallies[] } {
  const key = (...p: string[]) => p.join('\u0001');
  const cohortMap = new Map<string, MeasuredTrade[]>();
  const familyMap = new Map<string, MeasuredTrade[]>();
  const instMap = new Map<string, MeasuredTrade[]>();
  for (const t of trades) {
    const c = cohortOf(t.mintedAt);
    for (const [m, k] of [
      [cohortMap, key(c)],
      [familyMap, key(c, t.family)],
      [instMap, key(c, t.family, t.symbol)],
    ] as const) {
      const a = m.get(k);
      if (a) a.push(t);
      else m.set(k, [t]);
    }
  }
  const order = (c: Cohort) => COHORTS.indexOf(c);
  return {
    byCohort: [...cohortMap.entries()].map(([k, v]) => ({ cohort: k as Cohort, tally: tallyOf(v) })).sort((a, b) => order(a.cohort) - order(b.cohort)),
    byFamily: [...familyMap.entries()]
      .map(([k, v]) => {
        const [cohort, family] = k.split('\u0001');
        return { cohort: cohort as Cohort, family, tally: tallyOf(v) };
      })
      .sort((a, b) => order(a.cohort) - order(b.cohort) || a.family.localeCompare(b.family)),
    byInstrument: [...instMap.entries()]
      .map(([k, v]) => {
        const [cohort, family, instrument] = k.split('\u0001');
        return { cohort: cohort as Cohort, family, instrument, tally: tallyOf(v) };
      })
      .sort((a, b) => order(a.cohort) - order(b.cohort) || a.family.localeCompare(b.family) || a.instrument.localeCompare(b.instrument)),
  };
}

// ---------------- summaries of the three new record kinds ----------------

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return r4(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const nums = (xs: unknown[]) => xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

/** Pure: the cost records (their `cost` JSON) as medians and shares — modelled values only. */
export function summariseCostRecords(records: ReadonlyArray<any>) {
  const share = (r: any) => (r?.total?.perUnit > 0 && typeof r?.spread?.perUnit === 'number' ? r.spread.perUnit / r.total.perUnit : null);
  const reconciled = records.filter((r) => r?.reconciliation?.matchesSetup === true).length;
  const checkable = records.filter((r) => r?.reconciliation?.matchesSetup != null).length;
  return {
    basis: 'ESTIMATED_MODEL' as const,
    n: records.length,
    spreadFromQuote: records.filter((r) => r?.spread?.source === 'QUOTE').length,
    spreadFallbackAssumed: records.filter((r) => r?.spread?.source === 'FALLBACK_ASSUMED').length,
    medianTotalPct: median(nums(records.map((r) => r?.total?.pctOfEntry))),
    medianCostR: median(nums(records.map((r) => r?.costR))),
    medianCostPctOfPlannedGrossProfit: median(nums(records.map((r) => r?.costPctOfPlannedGrossProfit))),
    medianSpreadShareOfTotal: median(nums(records.map(share))),
    medianBrokeragePlusGstPct: median(nums(records.map((r) => (r?.brokerage?.pctOfEntry ?? 0) + (r?.gstOnBrokerage?.pctOfEntry ?? 0)))),
    reconcilesWithSetupCost: { matches: reconciled, checked: checkable },
  };
}

/** Pure: the post-exit rows (status, outcome, record JSON). Target exits are reported apart from every other close. */
export function summarisePostExit(rows: ReadonlyArray<{ status: string; outcome: string; record: any }>) {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const observed = rows.filter((r) => r.status === 'OBSERVED');
  const of = (outcome: string) => observed.filter((r) => r.outcome === outcome);
  const block = (rs: typeof observed) => {
    const beyondR = nums(rs.map((r) => r.record?.option?.maxBeyondExitR));
    const atLeast = (x: number) => (beyondR.length ? Math.round((beyondR.filter((v) => v >= x).length / beyondR.length) * 1000) / 10 : null);
    const back = rs.map((r) => r.record?.option?.returnedToEntry).filter((v): v is boolean => typeof v === 'boolean');
    return {
      n: rs.length,
      medianMaxBeyondExitR: median(beyondR),
      medianMaxBeyondExitPct: median(nums(rs.map((r) => r.record?.option?.maxBeyondExitPct))),
      shareBeyondExitAtLeast: { '0.25R': atLeast(0.25), '0.5R': atLeast(0.5), '1R': atLeast(1) },
      shareReturnedToEntry: back.length ? Math.round((back.filter(Boolean).length / back.length) * 1000) / 10 : null,
      medianMinutesToPeak: median(nums(rs.map((r) => r.record?.option?.minutesToPeak))),
      medianUnderlyingFavAtr: median(nums(rs.map((r) => r.record?.underlying?.maxFavVsEntryAtr))),
      medianObservations: median(nums(rs.map((r) => r.record?.observations?.total))),
      medianMaxGapSeconds: median(nums(rs.map((r) => r.record?.observations?.maxGapSeconds))),
    };
  };
  return {
    basis: 'OBSERVED_SAMPLED (lower bound: a spike between observations is not seen)',
    rows: rows.length,
    byStatus,
    targetExits: block(of('WIN')),
    stopExits: block(of('LOSS')),
    expired: block(of('EXPIRED')),
  };
}

/** Pure: OPTION_PAYOFF_V2 rows against the first grader's answer for the same trades. */
export function summarisePayoffV2(rows: ReadonlyArray<{ actual: any }>) {
  const byVerdict: Record<string, number> = {};
  for (const r of rows) {
    const v = r.actual?.verdict ?? 'UNKNOWN';
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
  }
  const targetExits = rows.filter((r) => r.actual?.recorded?.outcome === 'WIN' && (r.actual?.recorded?.closeReason === 'TARGET' || r.actual?.recorded?.closeReason == null));
  const legacyFalse = targetExits.filter((r) => r.actual?.legacy?.targetReached === false);
  const legacyKnown = targetExits.filter((r) => typeof r.actual?.legacy?.targetReached === 'boolean');
  return {
    n: rows.length,
    byVerdict,
    recordedTargetExits: {
      n: targetExits.length,
      corroborated: targetExits.filter((r) => r.actual?.verdict === 'CORROBORATED').length,
      contradictedByDenseData: targetExits.filter((r) => r.actual?.verdict === 'CONTRADICTED_DENSE').length,
      notCorroboratedSparse: targetExits.filter((r) => r.actual?.verdict === 'NOT_CORROBORATED').length,
      unverifiable: targetExits.filter((r) => r.actual?.verdict === 'UNVERIFIABLE').length,
    },
    firstGraderComparison: {
      recordedTargetExitsWithAFirstGrade: legacyKnown.length,
      firstGraderSaidTargetNotReached: legacyFalse.length,
      ofThose_v2Corroborated: legacyFalse.filter((r) => r.actual?.verdict === 'CORROBORATED').length,
    },
  };
}
