// ============================================================
// EVALUATION CORE — the evidence the 2026-10-15 audit asked for, as pure functions
// ============================================================
// Measurement only. Nothing in the decision path imports this module; it turns
// records the system already keeps into four answers, each with an interval:
//
//   scorecard()        per strategy: is its net R per trade above zero, and
//                      what does the written rule propose (promote / demote /
//                      keep measuring)? The Old Indicator is PROTECTED: it is
//                      the user's benchmark and is never proposed for demotion.
//   signalQuality()    does the direction call predict the underlying's move
//                      (hit rate and signed move in ATR at 30 / 60 / 120 min and
//                      to the session's last observation), and which recorded
//                      vote dimensions carry information (rank correlation)?
//   gateValidation()   per refusal code: did the decisions a gate refused grade
//                      worse than the decisions taken? A gate that refuses
//                      trades no worse than the taken ones is not earning its keep.
//   replayCaps()       the paper book replayed under the portfolio limits
//                      already written in the code (open positions, same
//                      direction, daily loss, trades per day, consecutive
//                      stops): what would have been skipped, and what that does
//                      to net R, worst day and drawdown.
//
// Statistics: trades on one day share the market, so every interval resamples
// WHOLE DAYS (cluster bootstrap), seeded so a report is reproducible. Rules and
// thresholds are fixed here (EVIDENCE_RULES) before any result was read through
// them; changing one is a version bump.
// ============================================================

export const EVIDENCE_RULES = Object.freeze({
  VERSION: 'EVIDENCE-1.0',
  REGISTERED_AT: '2026-10-15',
  /** Two-sided 95% intervals. */
  ALPHA: 0.05,
  RESAMPLES: 2000,
  /** Fewer resamples for the per-dimension correlations, which sort on every draw. */
  RESAMPLES_RANK: 300,
  SEED: 20261015,
  /** A strategy may be proposed for demotion once it has this many closed trades and its upper bound is below 0. */
  MIN_N_DEMOTE: 30,
  /** Promotion needs this many trades, over this many trading days, a lower bound above 0 after a Bonferroni
   *  correction for every strategy that reached the size bar, and both halves of its own record positive. */
  MIN_N_PROMOTE: 100,
  MIN_DAYS_PROMOTE: 20,
  /** Strategy keys the scorecard never proposes to demote (user decision 2026-10-15: the Old Indicator stays). */
  PROTECTED: ['INDICATOR'] as readonly string[],
  /** Forward horizons for the direction test (minutes); a later observation within this tolerance counts. */
  HORIZONS_MIN: [30, 60, 120] as readonly number[],
  HORIZON_TOLERANCE_MIN: 20,
});

// ---------------- deterministic resampling ----------------

/** Group into arrays without copying on every insert. */
function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** mulberry32: a small seeded PRNG so a report's intervals do not change between two reads of the same data. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted: readonly number[], q: number): number => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const r4 = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10_000) / 10_000);
const meanOf = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface ClusterStat {
  n: number;
  clusters: number;
  mean: number | null;
  lo: number | null;
  hi: number | null;
}

/**
 * Mean of `values` with a (1 − alpha) percentile interval from resampling whole clusters (days) with replacement.
 * Fewer than 3 clusters: the mean alone, no interval (too few days to say anything).
 */
export function clusterBootstrapMean(
  values: readonly number[],
  clusters: readonly string[],
  opts: { alpha?: number; resamples?: number; seed?: number } = {}
): ClusterStat {
  const alpha = opts.alpha ?? EVIDENCE_RULES.ALPHA;
  const B = opts.resamples ?? EVIDENCE_RULES.RESAMPLES;
  const sums = new Map<string, { s: number; n: number }>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const e = sums.get(clusters[i]) ?? { s: 0, n: 0 };
    e.s += v;
    e.n += 1;
    sums.set(clusters[i], e);
  }
  const groups = [...sums.values()];
  const n = groups.reduce((a, g) => a + g.n, 0);
  const total = groups.reduce((a, g) => a + g.s, 0);
  const mean = n > 0 ? total / n : null;
  if (groups.length < 3 || n === 0) return { n, clusters: groups.length, mean: r4(mean), lo: null, hi: null };
  const rnd = seededRandom(opts.seed ?? EVIDENCE_RULES.SEED);
  const est: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < groups.length; k++) {
      const g = groups[Math.floor(rnd() * groups.length)];
      s += g.s;
      c += g.n;
    }
    if (c > 0) est.push(s / c);
  }
  est.sort((a, b) => a - b);
  return { n, clusters: groups.length, mean: r4(mean), lo: r4(quantile(est, alpha / 2)), hi: r4(quantile(est, 1 - alpha / 2)) };
}

/** Difference of means (a − b) with an interval from resampling the union of days jointly (both groups keep their days). */
export function clusterBootstrapDiff(
  a: ReadonlyArray<{ v: number; c: string }>,
  b: ReadonlyArray<{ v: number; c: string }>,
  opts: { alpha?: number; resamples?: number; seed?: number } = {}
): { diff: number | null; lo: number | null; hi: number | null; days: number } {
  const alpha = opts.alpha ?? EVIDENCE_RULES.ALPHA;
  const B = opts.resamples ?? EVIDENCE_RULES.RESAMPLES;
  const days = new Map<string, { as: number; an: number; bs: number; bn: number }>();
  for (const x of a) if (Number.isFinite(x.v)) { const d = days.get(x.c) ?? { as: 0, an: 0, bs: 0, bn: 0 }; d.as += x.v; d.an++; days.set(x.c, d); }
  for (const x of b) if (Number.isFinite(x.v)) { const d = days.get(x.c) ?? { as: 0, an: 0, bs: 0, bn: 0 }; d.bs += x.v; d.bn++; days.set(x.c, d); }
  const ds = [...days.values()];
  const tot = ds.reduce((t, d) => ({ as: t.as + d.as, an: t.an + d.an, bs: t.bs + d.bs, bn: t.bn + d.bn }), { as: 0, an: 0, bs: 0, bn: 0 });
  const diff = tot.an > 0 && tot.bn > 0 ? tot.as / tot.an - tot.bs / tot.bn : null;
  if (diff == null || ds.length < 3) return { diff: r4(diff), lo: null, hi: null, days: ds.length };
  const rnd = seededRandom(opts.seed ?? EVIDENCE_RULES.SEED);
  const est: number[] = [];
  for (let k = 0; k < B; k++) {
    let as = 0, an = 0, bs = 0, bn = 0;
    for (let j = 0; j < ds.length; j++) {
      const d = ds[Math.floor(rnd() * ds.length)];
      as += d.as; an += d.an; bs += d.bs; bn += d.bn;
    }
    if (an > 0 && bn > 0) est.push(as / an - bs / bn);
  }
  est.sort((x, y) => x - y);
  return { diff: r4(diff), lo: r4(quantile(est, alpha / 2)), hi: r4(quantile(est, 1 - alpha / 2)), days: ds.length };
}

/** Average ranks (ties share their mean rank). */
function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; null for fewer than 3 pairs or a constant series. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  const pairs = x.map((v, i) => [v, y[i]] as const).filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q));
  if (pairs.length < 3) return null;
  const rx = ranks(pairs.map((p) => p[0]));
  const ry = ranks(pairs.map((p) => p[1]));
  const mx = meanOf(rx)!;
  const my = meanOf(ry)!;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * Spearman with a day-cluster bootstrap interval. The ranks are taken once on the full sample and each resample
 * correlates those ranks (Pearson on ranks): the same statistic without a re-sort per draw, which keeps a 10k-row,
 * 300-draw interval to milliseconds.
 */
export function spearmanByDay(x: readonly number[], y: readonly number[], days: readonly string[], opts: { resamples?: number; seed?: number; alpha?: number } = {}) {
  const keep = x.map((v, i) => i).filter((i) => Number.isFinite(x[i]) && Number.isFinite(y[i]));
  const rho = spearman(keep.map((i) => x[i]), keep.map((i) => y[i]));
  const rx = ranks(keep.map((i) => x[i]));
  const ry = ranks(keep.map((i) => y[i]));
  const byDay = groupBy(keep.map((_, j) => j), (j) => days[keep[j]]);
  const keys = [...byDay.keys()];
  if (rho == null || keys.length < 3) return { n: keep.length, rho: r4(rho), lo: null, hi: null };
  const rnd = seededRandom(opts.seed ?? EVIDENCE_RULES.SEED);
  const B = opts.resamples ?? EVIDENCE_RULES.RESAMPLES_RANK;
  const alpha = opts.alpha ?? EVIDENCE_RULES.ALPHA;
  const est: number[] = [];
  for (let b = 0; b < B; b++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < keys.length; k++) {
      for (const j of byDay.get(keys[Math.floor(rnd() * keys.length)])!) {
        const a = rx[j];
        const c = ry[j];
        n++; sx += a; sy += c; sxx += a * a; syy += c * c; sxy += a * c;
      }
    }
    const vx = sxx - (sx * sx) / n;
    const vy = syy - (sy * sy) / n;
    if (n > 2 && vx > 0 && vy > 0) est.push((sxy - (sx * sy) / n) / Math.sqrt(vx * vy));
  }
  est.sort((p, q) => p - q);
  return { n: keep.length, rho: r4(rho), lo: r4(quantile(est, alpha / 2)), hi: r4(quantile(est, 1 - alpha / 2)) };
}

// ---------------- strategy scorecard ----------------

/** The strategy a paper trade belongs to: its recorded source, else (older rows) its label. */
export function strategyKeyOf(family: string | null | undefined, label: string | null | undefined): string {
  if (family) return family;
  const l = label ?? '';
  if (l.startsWith('Indicator')) return 'INDICATOR';
  if (l.startsWith('Structure')) return 'S1';
  if (l.startsWith('Momentum')) return 'MOMENTUM_BREAK';
  const m = /Paper research · ([A-Za-z0-9_]+)/.exec(l);
  if (m) return m[1];
  if (l.startsWith('Order Block')) return 'OB1';
  if (l.startsWith('Order Flow')) return 'OF1';
  return 'UNKNOWN';
}

export interface ScoreRow {
  strategy: string;
  /** IST trading day of the mint (the resampling cluster). */
  day: string;
  netR: number;
  grossR: number | null;
  state: 'WIN' | 'LOSS' | 'EXPIRED';
}

export type ScorecardAction = 'PROTECTED_BENCHMARK' | 'PROMOTE_ELIGIBLE' | 'DEMOTE_CANDIDATE' | 'KEEP_MEASURING';

export interface ScorecardEntry {
  strategy: string;
  n: number;
  days: number;
  wins: number;
  losses: number;
  expired: number;
  /** wins ÷ (wins + losses): EXPIRED excluded. */
  winRateClosedOnly: number | null;
  /** wins ÷ every trade. */
  winRateAllTrades: number | null;
  netR: ClusterStat;
  /** The same mean with the interval widened for every strategy that reached the promotion size (Bonferroni). */
  netRCorrected: { lo: number | null; hi: number | null; comparisons: number };
  grossR: number | null;
  avgNetWin: number | null;
  avgNetLoss: number | null;
  firstHalfNetR: number | null;
  secondHalfNetR: number | null;
  action: ScorecardAction;
  reason: string;
}

/** Pure: the written promote / demote rule applied to every strategy's closed paper trades. */
export function scorecard(rows: readonly ScoreRow[], opts: { seed?: number; resamples?: number } = {}): ScorecardEntry[] {
  const R = EVIDENCE_RULES;
  const by = groupBy(rows.filter((r) => Number.isFinite(r.netR)), (r) => r.strategy);
  const comparisons = Math.max(1, [...by.values()].filter((g) => g.length >= R.MIN_N_PROMOTE).length);
  const out: ScorecardEntry[] = [];
  for (const [strategy, g] of by) {
    const days = [...new Set(g.map((r) => r.day))].sort();
    const wins = g.filter((r) => r.state === 'WIN');
    const losses = g.filter((r) => r.state === 'LOSS');
    const expired = g.filter((r) => r.state === 'EXPIRED');
    const vals = g.map((r) => r.netR);
    const cl = g.map((r) => r.day);
    const net = clusterBootstrapMean(vals, cl, { seed: opts.seed, resamples: opts.resamples });
    const corrected = clusterBootstrapMean(vals, cl, { seed: opts.seed, resamples: opts.resamples, alpha: R.ALPHA / comparisons });
    const mid = days[Math.floor(days.length / 2)];
    const first = g.filter((r) => days.length > 1 && r.day < mid).map((r) => r.netR);
    const second = g.filter((r) => days.length > 1 && r.day >= mid).map((r) => r.netR);
    const firstHalf = meanOf(first);
    const secondHalf = meanOf(second);
    const grossVals = g.map((r) => r.grossR).filter((v): v is number => v != null && Number.isFinite(v));

    let action: ScorecardAction;
    let reason: string;
    if (R.PROTECTED.includes(strategy)) {
      action = 'PROTECTED_BENCHMARK';
      reason = 'The Old Indicator is the benchmark and keeps trading by user decision; it is measured, never proposed for removal.';
    } else if (g.length >= R.MIN_N_DEMOTE && net.hi != null && net.hi < 0) {
      action = 'DEMOTE_CANDIDATE';
      reason = `Net R per trade is below zero with 95% confidence over ${g.length} trades (upper bound ${net.hi}).`;
    } else if (
      g.length >= R.MIN_N_PROMOTE &&
      days.length >= R.MIN_DAYS_PROMOTE &&
      corrected.lo != null &&
      corrected.lo > 0 &&
      (firstHalf ?? 0) > 0 &&
      (secondHalf ?? 0) > 0
    ) {
      action = 'PROMOTE_ELIGIBLE';
      reason = `Lower bound ${corrected.lo} > 0 after correcting for ${comparisons} strategies, over ${g.length} trades and ${days.length} days, positive in both halves.`;
    } else {
      action = 'KEEP_MEASURING';
      const need: string[] = [];
      if (g.length < R.MIN_N_PROMOTE) need.push(`${R.MIN_N_PROMOTE - g.length} more trades`);
      if (days.length < R.MIN_DAYS_PROMOTE) need.push(`${R.MIN_DAYS_PROMOTE - days.length} more trading days`);
      if (need.length === 0) need.push('a lower bound above zero in both halves');
      reason = `No edge shown yet; a decision needs ${need.join(' and ')}.`;
    }
    out.push({
      strategy,
      n: g.length,
      days: days.length,
      wins: wins.length,
      losses: losses.length,
      expired: expired.length,
      winRateClosedOnly: wins.length + losses.length > 0 ? r4((wins.length / (wins.length + losses.length)) * 100) : null,
      winRateAllTrades: r4((wins.length / g.length) * 100),
      netR: net,
      netRCorrected: { lo: corrected.lo, hi: corrected.hi, comparisons },
      grossR: r4(meanOf(grossVals)),
      avgNetWin: r4(meanOf(wins.map((r) => r.netR))),
      avgNetLoss: r4(meanOf(losses.map((r) => r.netR))),
      firstHalfNetR: r4(firstHalf),
      secondHalfNetR: r4(secondHalf),
      action,
      reason,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

// ---------------- signal quality ----------------

export interface DecisionPoint {
  symbol: string;
  exchange: string;
  /** Epoch ms of the decision. */
  t: number;
  /** IST trading day. */
  day: string;
  /** Underlying price and ATR at the decision. */
  px: number;
  atr: number;
  /** +1 BULLISH, −1 BEARISH, 0 NEUTRAL. */
  sign: 1 | -1 | 0;
  confidence: number | null;
  /** Recorded vote dimensions (0-100 scores), by name. */
  votes: Record<string, number | null>;
  /** 'TAKE' or the refusal code. */
  decision: string;
  /** The missed-winner audit's graded outcome on its default ATR levels (null when not graded). */
  outcomeR: number | null;
}

export interface ForwardMove {
  point: DecisionPoint;
  /** Signed move in ATR at each horizon (null when no observation within tolerance the same day). */
  byHorizon: Record<number, number | null>;
  /** Signed move to the symbol's last observation of the day. */
  toDayEnd: number | null;
  /** The trivial baseline: direction of the last 60 minutes (sign only). */
  momentumSign: 1 | -1 | 0 | null;
}

/** Pure: forward moves for every decision from the same symbol's later decisions (prices are the snapshots' own). */
export function forwardMoves(points: readonly DecisionPoint[], horizons: readonly number[] = EVIDENCE_RULES.HORIZONS_MIN, toleranceMin = EVIDENCE_RULES.HORIZON_TOLERANCE_MIN): ForwardMove[] {
  const bySymbol = groupBy(points.filter((p) => p.px > 0 && p.atr > 0), (p) => `${p.exchange}:${p.symbol}`);
  const out: ForwardMove[] = [];
  const tol = toleranceMin * 60_000;
  for (const series of bySymbol.values()) {
    series.sort((a, b) => a.t - b.t);
    const lastOfDay = new Map<string, DecisionPoint>();
    for (const p of series) lastOfDay.set(p.day, p);
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      const byHorizon: Record<number, number | null> = {};
      for (const h of horizons) {
        const target = p.t + h * 60_000;
        let j = i + 1;
        while (j < series.length && series[j].t < target) j++;
        const f = series[j];
        byHorizon[h] = f && f.day === p.day && f.t - target <= tol && p.sign !== 0 ? ((f.px - p.px) / p.atr) * p.sign : null;
      }
      const end = lastOfDay.get(p.day)!;
      const toDayEnd = end.t > p.t && p.sign !== 0 ? ((end.px - p.px) / p.atr) * p.sign : null;
      // Baseline: the price 60 minutes earlier (same day, within tolerance).
      const back = p.t - 60 * 60_000;
      let k = i - 1;
      while (k >= 0 && series[k].t > back) k--;
      const b = k >= 0 ? series[k] : null;
      const momentumSign = b && b.day === p.day && back - b.t <= tol ? (Math.sign(p.px - b.px) as 1 | -1 | 0) : null;
      out.push({ point: p, byHorizon, toDayEnd, momentumSign });
    }
  }
  return out;
}

const hitRate = (xs: readonly number[]): number | null => {
  const nz = xs.filter((v) => v !== 0);
  return nz.length ? r4((nz.filter((v) => v > 0).length / nz.length) * 100) : null;
};

export function signalQuality(points: readonly DecisionPoint[], opts: { seed?: number; resamples?: number } = {}) {
  const moves = forwardMoves(points).filter((m) => m.point.sign !== 0);
  const stat = (ms: readonly ForwardMove[], pick: (m: ForwardMove) => number | null) => {
    const v: number[] = [];
    const c: string[] = [];
    for (const m of ms) {
      const x = pick(m);
      if (x != null && Number.isFinite(x)) { v.push(x); c.push(m.point.day); }
    }
    const s = clusterBootstrapMean(v, c, opts);
    return { ...s, hitRate: hitRate(v) };
  };
  const horizons = EVIDENCE_RULES.HORIZONS_MIN.map((h) => ({ minutes: h, ...stat(moves, (m) => m.byHorizon[h]) }));
  const toDayEnd = stat(moves, (m) => m.toDayEnd);
  // The trivial baseline at +60: trade the last hour's direction instead of the engine's call.
  const baseline60 = stat(moves, (m) => (m.momentumSign && m.byHorizon[60] != null ? m.byHorizon[60]! * m.point.sign * m.momentumSign : null));
  const withMom = moves.filter((m) => m.momentumSign != null && m.momentumSign !== 0);
  const agreesWithMomentum = withMom.length ? r4((withMom.filter((m) => m.momentumSign === m.point.sign).length / withMom.length) * 100) : null;
  const group = (key: (m: ForwardMove) => string) => {
    const g = groupBy(moves, key);
    return [...g.entries()].map(([k, ms]) => ({ key: k, ...stat(ms, (m) => m.byHorizon[60]) })).sort((a, b) => b.n - a.n);
  };
  const confBand = (c: number | null) => (c == null ? 'unknown' : c < 50 ? '<50' : c < 65 ? '50-65' : c < 75 ? '65-75' : c < 85 ? '75-85' : '85+');
  const dims = [...new Set(moves.flatMap((m) => Object.keys(m.point.votes)))].sort();
  const dimensions = dims.map((d) => {
    const x: number[] = [];
    const y: number[] = [];
    const days: string[] = [];
    for (const m of moves) {
      const v = m.point.votes[d];
      const f = m.byHorizon[60];
      if (v != null && Number.isFinite(v) && f != null) { x.push(v); y.push(f); days.push(m.point.day); }
    }
    return { dimension: d, ...spearmanByDay(x, y, days, { seed: opts.seed }) };
  });
  return {
    decisions: moves.length,
    days: new Set(moves.map((m) => m.point.day)).size,
    symbols: new Set(moves.map((m) => m.point.symbol)).size,
    horizons,
    toDayEnd,
    baseline60,
    agreesWithMomentumPct: agreesWithMomentum,
    byExchange: group((m) => m.point.exchange),
    byConfidence: group((m) => confBand(m.point.confidence)),
    dimensions,
  };
}

// ---------------- gate validation ----------------

export type GateVerdict = 'FILTERS_WORSE' | 'REFUSES_NO_WORSE' | 'INCONCLUSIVE';

/** Pure: per refusal code, the graded outcome of what it refused against what was taken. */
export function gateValidation(points: readonly DecisionPoint[], opts: { seed?: number; resamples?: number; minRows?: number } = {}) {
  const graded = points.filter((p) => p.outcomeR != null && Number.isFinite(p.outcomeR));
  const taken = graded.filter((p) => p.decision === 'TAKE').map((p) => ({ v: p.outcomeR!, c: p.day }));
  const takenStat = clusterBootstrapMean(taken.map((t) => t.v), taken.map((t) => t.c), opts);
  const codes = [...new Set(graded.map((p) => p.decision).filter((d) => d !== 'TAKE'))];
  const rows = codes
    .map((code) => {
      const refused = graded.filter((p) => p.decision === code).map((p) => ({ v: p.outcomeR!, c: p.day }));
      const s = clusterBootstrapMean(refused.map((r) => r.v), refused.map((r) => r.c), opts);
      const d = clusterBootstrapDiff(refused, taken, opts);
      const verdict: GateVerdict = d.hi != null && d.hi < 0 ? 'FILTERS_WORSE' : d.lo != null && d.lo >= 0 ? 'REFUSES_NO_WORSE' : 'INCONCLUSIVE';
      return { code, refused: s, diffVsTaken: d, verdict };
    })
    .filter((r) => r.refused.n >= (opts.minRows ?? 40))
    .sort((a, b) => b.refused.n - a.refused.n);
  return { taken: takenStat, gates: rows };
}

// ---------------- portfolio limits replay ----------------

export interface ReplayTrade {
  id: string;
  mintedAt: number;
  /** When the trade really ended (session-end exits: the session close, not the rollover stamp). */
  exitAt: number;
  symbol: string;
  direction: string;
  netR: number;
  outcome: 'WIN' | 'LOSS' | 'EXPIRED';
  day: string;
}

export interface CapLimits {
  maxOpenPositions: number | null;
  maxSameDirection: number | null;
  maxDailyLossR: number | null;
  maxTradesPerDay: number | null;
  maxConsecutiveStops: number | null;
}

export interface BookStats {
  trades: number;
  totalNetR: number;
  meanNetR: number | null;
  winRateAllTrades: number | null;
  worstDayR: number | null;
  bestDayR: number | null;
  maxDrawdownR: number;
  maxOpen: number;
  maxSameDirection: number;
}

/** Pure: arithmetic over a set of trades taken as given. */
export function bookStats(trades: readonly ReplayTrade[]): BookStats {
  const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) { eq += t.netR; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.netR);
  const dayVals = [...byDay.values()];
  let maxOpen = 0, maxSame = 0;
  for (const t of trades) {
    const open = trades.filter((o) => o.mintedAt <= t.mintedAt && o.exitAt > t.mintedAt);
    maxOpen = Math.max(maxOpen, open.length);
    maxSame = Math.max(maxSame, open.filter((o) => o.direction === t.direction).length);
  }
  const total = trades.reduce((a, t) => a + t.netR, 0);
  return {
    trades: trades.length,
    totalNetR: r4(total) ?? 0,
    meanNetR: r4(trades.length ? total / trades.length : null),
    winRateAllTrades: r4(trades.length ? (trades.filter((t) => t.outcome === 'WIN').length / trades.length) * 100 : null),
    worstDayR: r4(dayVals.length ? Math.min(...dayVals) : null),
    bestDayR: r4(dayVals.length ? Math.max(...dayVals) : null),
    maxDrawdownR: r4(dd) ?? 0,
    maxOpen,
    maxSameDirection: maxSame,
  };
}

/**
 * Pure: replay the book in mint order, skipping a trade whenever a limit would have refused it. Trades the system
 * actually made are taken as given; a skipped trade does not free a slot for one the engine never minted, so this
 * reads what the limits would REMOVE, not what they might have added.
 */
export function replayCaps(trades: readonly ReplayTrade[], limits: CapLimits) {
  const sorted = [...trades].sort((a, b) => a.mintedAt - b.mintedAt);
  const taken: ReplayTrade[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const t of sorted) {
    const open = taken.filter((o) => o.mintedAt <= t.mintedAt && o.exitAt > t.mintedAt);
    const closedToday = taken.filter((o) => o.day === t.day && o.exitAt <= t.mintedAt).sort((a, b) => a.exitAt - b.exitAt);
    const realisedToday = closedToday.reduce((a, o) => a + o.netR, 0);
    let streak = 0;
    for (let i = closedToday.length - 1; i >= 0 && closedToday[i].outcome === 'LOSS'; i--) streak++;
    if (limits.maxOpenPositions != null && open.length >= limits.maxOpenPositions) { skip('MAX_OPEN_POSITIONS'); continue; }
    if (limits.maxSameDirection != null && open.filter((o) => o.direction === t.direction).length >= limits.maxSameDirection) { skip('MAX_SAME_DIRECTION'); continue; }
    if (limits.maxDailyLossR != null && realisedToday <= -limits.maxDailyLossR) { skip('DAILY_LOSS_LIMIT'); continue; }
    if (limits.maxTradesPerDay != null && taken.filter((o) => o.day === t.day).length >= limits.maxTradesPerDay) { skip('MAX_TRADES_PER_DAY'); continue; }
    if (limits.maxConsecutiveStops != null && streak >= limits.maxConsecutiveStops) { skip('CONSECUTIVE_STOPS'); continue; }
    taken.push(t);
  }
  return { stats: bookStats(taken), skipped, skippedTotal: sorted.length - taken.length };
}
