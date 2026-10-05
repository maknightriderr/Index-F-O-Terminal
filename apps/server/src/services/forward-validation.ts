// ============================================================
// FORWARD VALIDATION — predicted vs actual paper outcomes (measurement only)
// ============================================================
// After a session has ended, three things the engine PREDICTED are graded
// against what the market then did — from stored data only (decision
// snapshots, option plans, closed paper signals, slot decisions), never the
// broker, never a decision input:
//
//   OPTION_PAYOFF     OPTION-2.0  the theta-adjusted target premium (and its
//                                 delta + gamma − theta projection) vs the
//                                 premium path actually seen until the exit
//   STRIKE_SELECTION  OPTSEL-2.0  every strike the plan ranked, marked to the
//                                 later chains at the trade's exit: was the
//                                 selected strike the best, and did the
//                                 ranking order the realised returns
//   EVIDENCE_RANK     ARB-2.0     every arbitrated candidate's own stop /
//                                 objective on the later closed 15m bars, by
//                                 its confirmation count and rank
//
// Grading reads bars and chains AFTER the decision — that is the point of a
// forward test — but only once the session is over, and nothing graded here
// feeds back into any decision, threshold or weight. Paper / simulated only.
// It runs on the opportunity census's post-session tick (no new service) and
// also removes I/O tapes older than DECISION_TAPE_RETENTION_DAYS.
// ============================================================

import { gunzipSync } from 'node:zlib';
import type { OptionCandidate, OptionChain } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { insertOnce } from '../lib/insert-once.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { DECISION_TAPE_RETENTION_DAYS } from './decision-record-store.js';
import { ARBITRATION_VERSION, OPTION_SELECTION_VERSION, OPTION_VERSION } from '../config/trading-flags.js';

export const FORWARD_VALIDATION_MIGRATION = '037_replay_tapes_forward_validation.sql';
const BAR_MS = 15 * 60 * 1000;
/** Subjects older than this are not graded (their snapshots may have aged out). */
const LOOKBACK_DAYS = 10;
const BATCH = 40;

// ---------------- pure helpers ----------------

/** A contract's mark in a chain: mid of a two-sided quote, else LTP; null when absent or on another expiry. */
export function markOf(chain: Pick<OptionChain, 'expiry' | 'strikes'> | null, side: 'CE' | 'PE', strike: number, expiry: string | null): number | null {
  if (!chain || (expiry != null && chain.expiry !== expiry)) return null;
  const row = chain.strikes?.find((s) => s.strike === strike);
  const leg = row ? (side === 'CE' ? row.call : row.put) : null;
  if (!leg) return null;
  const bid = Number(leg.bid);
  const ask = Number(leg.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) return (bid + ask) / 2;
  const ltp = Number(leg.ltp);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

export interface TimedChain {
  at: number;
  chain: Pick<OptionChain, 'expiry' | 'strikes'> | null;
}

/** The marks of one contract over the chains in (from, to], in time order. */
export function premiumPath(chains: readonly TimedChain[], side: 'CE' | 'PE', strike: number, expiry: string | null, from: number, to: number): Array<{ at: number; premium: number }> {
  return chains
    .filter((c) => c.at > from && c.at <= to)
    .sort((a, b) => a.at - b.at)
    .map((c) => ({ at: c.at, premium: markOf(c.chain, side, strike, expiry) }))
    .filter((p): p is { at: number; premium: number } => p.premium != null);
}

const round = (v: number | null, dp = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

export interface PayoffGradeInput {
  entry: number;
  target: number | null;
  stop: number | null;
  projectedPayoff: { netGain: number; deltaGain: number; gammaGain: number; thetaDecay: number; holdHours: number } | null;
  outcome: string | null;
  exitPrice: number | null;
  path: ReadonlyArray<{ at: number; premium: number }>;
}

/** OPTION_PAYOFF: what the build projected vs what the contract did until the exit. */
export function gradeOptionPayoff(g: PayoffGradeInput): { predicted: Record<string, unknown>; actual: Record<string, unknown> } {
  const projectedGain = g.target != null ? g.target - g.entry : null;
  const maxPremium = g.path.length ? Math.max(...g.path.map((p) => p.premium)) : null;
  const minPremium = g.path.length ? Math.min(...g.path.map((p) => p.premium)) : null;
  const maxGain = maxPremium != null ? maxPremium - g.entry : null;
  return {
    predicted: {
      entry: g.entry,
      target: g.target,
      stop: g.stop,
      projectedGainPct: round(projectedGain != null && g.entry > 0 ? projectedGain / g.entry : null),
      projectedPayoff: g.projectedPayoff,
    },
    actual: {
      outcome: g.outcome,
      exitPrice: g.exitPrice,
      realisedPct: round(g.exitPrice != null && g.entry > 0 ? (g.exitPrice - g.entry) / g.entry : null),
      // Marks of the recorded chains between entry and exit (one per snapshotted bar): the best and worst seen.
      marks: g.path.length,
      maxPremium,
      minPremium,
      maxGainPct: round(maxGain != null && g.entry > 0 ? maxGain / g.entry : null),
      targetReached: maxPremium != null && g.target != null ? maxPremium >= g.target : null,
      // Share of the projected gain the contract actually offered at its best (1 = the projection was reached).
      projectionCaptured: round(maxGain != null && projectedGain != null && projectedGain > 0 ? maxGain / projectedGain : null),
    },
  };
}

/** Spearman rank correlation (no ties expected; ties take the average rank). Null below 3 pairs. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const ranks = (v: readonly number[]) => {
    const order = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const r = new Array<number>(n);
    for (let k = 0; k < n; ) {
      let j = k;
      while (j + 1 < n && order[j + 1].x === order[k].x) j++;
      for (let m = k; m <= j; m++) r[order[m].i] = (k + j) / 2 + 1;
      k = j + 1;
    }
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (n + 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mean) * (ry[i] - mean);
    dx += (rx[i] - mean) ** 2;
    dy += (ry[i] - mean) ** 2;
  }
  return dx > 0 && dy > 0 ? round(num / Math.sqrt(dx * dy)) : null;
}

/** STRIKE_SELECTION: every strike the plan held a premium for, marked at the trade's exit. */
export function gradeStrikeSelection(
  candidates: readonly OptionCandidate[],
  markAtExit: (c: OptionCandidate) => number | null
): { predicted: Record<string, unknown>; actual: Record<string, unknown> } {
  const priced = candidates.filter((c) => c.premium != null && c.premium > 0);
  const byStrike = priced.map((c) => {
    const exit = markAtExit(c);
    const ret = exit != null ? (exit - c.premium!) / c.premium! : null;
    return {
      strike: c.strike,
      side: c.side,
      status: c.status,
      rank: c.rank,
      rejectedAt: c.rejectedAt,
      entry: c.premium,
      exit,
      returnPct: round(ret),
      returnR: round(exit != null && c.premiumRisk != null && c.premiumRisk > 0 ? (exit - c.premium!) / c.premiumRisk : null),
    };
  });
  const selected = byStrike.find((s) => s.status === 'SELECTED') ?? null;
  const graded = byStrike.filter((s) => s.returnR != null);
  const best = graded.length ? graded.reduce((a, b) => (b.returnR! > a.returnR! ? b : a)) : null;
  const ranked = graded.filter((s) => s.rank != null);
  return {
    predicted: {
      selectedStrike: selected?.strike ?? null,
      ranking: priced.map((c) => ({ strike: c.strike, status: c.status, rank: c.rank, netRR: c.netRR, comparableRR: c.comparableRR ?? null, rejectedAt: c.rejectedAt })),
    },
    actual: {
      byStrike,
      selectedReturnR: selected?.returnR ?? null,
      bestStrike: best?.strike ?? null,
      bestReturnR: best?.returnR ?? null,
      selectedWasBest: selected && best ? selected.strike === best.strike : null,
      // Rank 1 = best predicted, so a ranking that orders realised R well correlates NEGATIVELY with rank; reported as −ρ.
      rankVsRealised: (() => {
        const rho = spearman(ranked.map((s) => s.rank!), ranked.map((s) => s.returnR!));
        return rho == null ? null : round(-rho);
      })(),
      // How the strikes the plan rejected (with a premium) did, beside the ones it ranked.
      rejectedAvgReturnR: (() => {
        const rej = graded.filter((s) => s.status === 'REJECTED');
        return rej.length ? round(rej.reduce((a, s) => a + s.returnR!, 0) / rej.length) : null;
      })(),
    },
  };
}

export interface GradeBar {
  time: number;
  high: number;
  low: number;
  close: number;
}
export type LevelOutcome = 'TARGET' | 'STOP' | 'OPEN' | 'NO_GEOMETRY' | 'NO_BARS';

/**
 * One candidate's underlying outcome on the closed bars that OPEN at or after
 * its decision (the decision bar's close): the first of its stop / objective
 * touched; a bar touching both counts the stop. Unresolved at the last bar of
 * the session = OPEN, marked at its close. R = in units of its own risk.
 */
export function gradeLevels(c: { direction: string; entry: number | null; stop: number | null; objective: number | null; decisionTime: number }, bars: readonly GradeBar[]): { outcome: LevelOutcome; r: number | null; barsToResolve: number | null } {
  if (c.entry == null || c.stop == null || c.objective == null) return { outcome: 'NO_GEOMETRY', r: null, barsToResolve: null };
  const sg = c.direction === 'BULLISH' ? 1 : c.direction === 'BEARISH' ? -1 : 0;
  const risk = sg * (c.entry - c.stop);
  const reward = sg * (c.objective - c.entry);
  if (sg === 0 || !(risk > 0) || !(reward > 0)) return { outcome: 'NO_GEOMETRY', r: null, barsToResolve: null };
  const after = bars.filter((b) => b.time >= c.decisionTime).sort((a, b) => a.time - b.time);
  if (after.length === 0) return { outcome: 'NO_BARS', r: null, barsToResolve: null };
  for (let k = 0; k < after.length; k++) {
    const b = after[k];
    const stopHit = sg > 0 ? b.low <= c.stop : b.high >= c.stop;
    const targetHit = sg > 0 ? b.high >= c.objective : b.low <= c.objective;
    if (stopHit) return { outcome: 'STOP', r: -1, barsToResolve: k + 1 };
    if (targetHit) return { outcome: 'TARGET', r: round(reward / risk), barsToResolve: k + 1 };
  }
  return { outcome: 'OPEN', r: round((sg * (after[after.length - 1].close - c.entry)) / risk), barsToResolve: null };
}

export interface EvidenceCandidate {
  source: string;
  candidateId: string;
  direction: string;
  role: string;
  rank: number | null;
  preBuildRank: number;
  confirmations: number | null;
  decisionTime: number;
  entry: number | null;
  stop: number | null;
  objective: number | null;
}

/** EVIDENCE_RANK: one slot decision's candidates, each graded on its own levels. */
export function gradeEvidenceRank(cands: readonly EvidenceCandidate[], bars: readonly GradeBar[]): { predicted: Record<string, unknown>; actual: Record<string, unknown> } {
  const graded = cands.map((c) => ({ c, g: gradeLevels(c, bars) }));
  const withR = graded.filter((x) => x.g.r != null);
  const byConf: Record<string, { n: number; avgR: number | null; targets: number; stops: number }> = {};
  for (const x of withR) {
    const k = String(x.c.confirmations ?? 'NOT_MEASURED');
    const b = (byConf[k] ??= { n: 0, avgR: 0, targets: 0, stops: 0 });
    b.avgR = (b.avgR! * b.n + x.g.r!) / (b.n + 1);
    b.n += 1;
    if (x.g.outcome === 'TARGET') b.targets += 1;
    if (x.g.outcome === 'STOP') b.stops += 1;
  }
  for (const b of Object.values(byConf)) b.avgR = round(b.avgR);
  const pre = withR.filter((x) => Number.isFinite(x.c.preBuildRank));
  const best = withR.length ? withR.reduce((a, b) => (b.g.r! > a.g.r! ? b : a)) : null;
  const top = withR.find((x) => x.c.role === 'SELECTED') ?? [...withR].sort((a, b) => a.c.preBuildRank - b.c.preBuildRank)[0] ?? null;
  return {
    predicted: {
      candidates: cands.map((c) => ({ source: c.source, candidateId: c.candidateId, role: c.role, rank: c.rank, preBuildRank: c.preBuildRank, confirmations: c.confirmations })),
    },
    actual: {
      candidates: graded.map((x) => ({ candidateId: x.c.candidateId, confirmations: x.c.confirmations, outcome: x.g.outcome, r: x.g.r, barsToResolve: x.g.barsToResolve })),
      byConfirmations: byConf,
      // The top-ranked (selected, else best pre-build) candidate vs the best realised one.
      topCandidateId: top?.c.candidateId ?? null,
      topR: top?.g.r ?? null,
      bestCandidateId: best?.c.candidateId ?? null,
      topWasBest: top && best ? top.c.candidateId === best.c.candidateId : null,
      rankVsRealised: (() => {
        const rho = spearman(pre.map((x) => x.c.preBuildRank), pre.map((x) => x.g.r!));
        return rho == null ? null : round(-rho);
      })(),
      confirmationsVsRealised: (() => {
        const c = withR.filter((x) => x.c.confirmations != null);
        return spearman(c.map((x) => x.c.confirmations!), c.map((x) => x.g.r!));
      })(),
    },
  };
}

/** Midnight IST (epoch ms) of the day `t` falls on. */
export function istDayStart(t: number): number {
  const d = new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return Date.parse(`${d}T00:00:00+05:30`);
}

// ---------------- the job ----------------

const VERSIONS = () => ({ option: OPTION_VERSION, arbitration: ARBITRATION_VERSION, optionSelection: OPTION_SELECTION_VERSION });

async function store(kind: string, subjectId: string, row: { snapshotId: string | null; signalId: string | null; symbol: string; exchange: string; decidedAt: Date; versions: unknown; predicted: unknown; actual: unknown }): Promise<void> {
  await insertOnce(sql`
    INSERT INTO forward_outcomes (kind, subject_id, snapshot_id, signal_id, symbol, exchange, decided_at, versions, predicted, actual)
    VALUES (${kind}, ${subjectId}, ${row.snapshotId}, ${row.signalId}, ${row.symbol}, ${row.exchange}, ${row.decidedAt},
      ${sql.json(row.versions as any)}, ${sql.json(row.predicted as any)}, ${sql.json(row.actual as any)})
  `);
}

/** The recorded chains of one symbol between two instants (from its decision snapshots). */
async function chainsBetween(symbol: string, exchange: string, mode: string, from: Date, to: Date): Promise<TimedChain[]> {
  const rows = await sql<{ polled_at: Date; gz: string | null }[]>`
    SELECT polled_at, inputs->>'optionChainGz' AS gz FROM signal_decision_snapshots
    WHERE symbol = ${symbol} AND exchange = ${exchange} AND mode = ${mode} AND polled_at > ${from} AND polled_at <= ${to}
    ORDER BY polled_at
  `;
  return rows.map((r) => {
    let chain: OptionChain | null = null;
    try {
      chain = r.gz ? (JSON.parse(gunzipSync(Buffer.from(r.gz, 'base64')).toString('utf8')) as OptionChain) : null;
    } catch {
      chain = null;
    }
    return { at: new Date(r.polled_at).getTime(), chain };
  });
}

/** Closed paper trades with an option plan: OPTION_PAYOFF and STRIKE_SELECTION. */
async function gradeClosedTrades(now: number): Promise<number> {
  const today = new Date(istDayStart(now));
  const rows = await sql<any[]>`
    SELECT s.id, s.time, s.symbol, s.inputs, p.snapshot_id, p.exchange, p.mode, p.option_side, p.option_strike, p.option_expiry,
      p.option_entry, p.option_sl, p.option_t1, p.candidates, p.option_selection_version
    FROM signals s JOIN option_plans p ON p.signal_id = s.id
    WHERE s.signal_type = 'TRADE_SETUP' AND s.inputs->>'outcome' IS NOT NULL AND s.inputs->>'voided' IS NULL
      AND s.time >= ${new Date(now - LOOKBACK_DAYS * 86_400_000)} AND s.time < ${today}
      AND NOT EXISTS (SELECT 1 FROM forward_outcomes f WHERE f.kind = 'OPTION_PAYOFF' AND f.subject_id = s.id::text)
    ORDER BY s.time
    LIMIT ${BATCH}
  `;
  for (const r of rows) {
    try {
      const inputs = r.inputs ?? {};
      const start = new Date(r.time);
      const exitAt = Number(inputs.exitTime) > 0 ? new Date(Number(inputs.exitTime)) : new Date(istDayStart(start.getTime()) + 86_400_000);
      const chains = await chainsBetween(r.symbol, r.exchange, r.mode, start, exitAt);
      const side = r.option_side as 'CE' | 'PE';
      const entry = Number(r.option_entry);
      const path = premiumPath(chains, side, Number(r.option_strike), r.option_expiry, start.getTime(), exitAt.getTime());
      const common = { snapshotId: r.snapshot_id ?? null, signalId: r.id, symbol: r.symbol, exchange: r.exchange, decidedAt: start, versions: { ...VERSIONS(), plan: r.option_selection_version } };
      // STRIKE_SELECTION first: OPTION_PAYOFF is the "done" marker for the pair.
      const last = (c: OptionCandidate) => {
        const p = premiumPath(chains, c.side as 'CE' | 'PE', c.strike, c.expiry, start.getTime(), exitAt.getTime());
        return p.length ? p[p.length - 1].premium : null;
      };
      const cands = (Array.isArray(r.candidates) ? r.candidates : []) as OptionCandidate[];
      if (cands.length) await store('STRIKE_SELECTION', String(r.id), { ...common, ...gradeStrikeSelection(cands, last) });
      await store('OPTION_PAYOFF', String(r.id), {
        ...common,
        ...gradeOptionPayoff({
          entry,
          target: r.option_t1 != null ? Number(r.option_t1) : null,
          stop: r.option_sl != null ? Number(r.option_sl) : null,
          projectedPayoff: inputs.projectedPayoff ?? null,
          outcome: inputs.outcome ?? null,
          exitPrice: inputs.exitPrice != null ? Number(inputs.exitPrice) : null,
          path,
        }),
      });
    } catch (err: any) {
      logger.warn({ error: err.message, signalId: r.id }, 'Forward validation: trade grading failed');
    }
  }
  return rows.length;
}

/** Slot decisions of ended sessions: EVIDENCE_RANK, on the day's last snapshotted bars. */
async function gradeSlotDecisions(now: number): Promise<number> {
  const today = new Date(istDayStart(now));
  const rows = await sql<any[]>`
    SELECT d.id, d.time, d.symbol, d.exchange, d.mode, d.diagnostics FROM slot_decisions d
    WHERE d.candidates > 0 AND d.time >= ${new Date(now - LOOKBACK_DAYS * 86_400_000)} AND d.time < ${today}
      AND NOT EXISTS (SELECT 1 FROM forward_outcomes f WHERE f.kind = 'EVIDENCE_RANK' AND f.subject_id = d.id::text)
    ORDER BY d.time
    LIMIT ${BATCH}
  `;
  const barsCache = new Map<string, GradeBar[]>();
  for (const r of rows) {
    try {
      const t = new Date(r.time).getTime();
      const dayStart = istDayStart(t);
      const key = `${r.exchange}:${r.symbol}:${r.mode}:${dayStart}`;
      let bars = barsCache.get(key);
      if (!bars) {
        const snap = await sql<{ bars: GradeBar[] | null }[]>`
          SELECT inputs->'ohlcv15m' AS bars FROM signal_decision_snapshots
          WHERE symbol = ${r.symbol} AND exchange = ${r.exchange} AND mode = ${r.mode}
            AND decision_bar_time >= ${new Date(dayStart)} AND decision_bar_time < ${new Date(dayStart + 86_400_000)}
          ORDER BY decision_bar_time DESC LIMIT 1
        `;
        bars = (snap[0]?.bars ?? []).filter((b) => b.time >= dayStart && b.time + BAR_MS <= dayStart + 86_400_000);
        barsCache.set(key, bars);
      }
      const cands = ((r.diagnostics?.candidates ?? []) as EvidenceCandidate[]).filter((c) => c.direction === 'BULLISH' || c.direction === 'BEARISH');
      await store('EVIDENCE_RANK', String(r.id), {
        snapshotId: null,
        signalId: null,
        symbol: r.symbol,
        exchange: r.exchange,
        decidedAt: new Date(r.time),
        versions: VERSIONS(),
        ...gradeEvidenceRank(cands, bars),
      });
    } catch (err: any) {
      logger.warn({ error: err.message, slotDecisionId: r.id }, 'Forward validation: evidence grading failed');
    }
  }
  return rows.length;
}

/** Tapes are bulky: kept DECISION_TAPE_RETENTION_DAYS; the snapshot and its record stay. */
async function pruneTapes(now: number): Promise<void> {
  await sql`DELETE FROM decision_tapes WHERE created_at < ${new Date(now - DECISION_TAPE_RETENTION_DAYS * 86_400_000)}`;
}

export async function runForwardValidation(now = Date.now()): Promise<{ trades: number; slots: number }> {
  if (!schemaFileReady(FORWARD_VALIDATION_MIGRATION)) return { trades: 0, slots: 0 };
  const trades = await gradeClosedTrades(now).catch((err: any) => (logger.warn({ error: err.message }, 'Forward validation: trades pass failed'), 0));
  const slots = await gradeSlotDecisions(now).catch((err: any) => (logger.warn({ error: err.message }, 'Forward validation: slots pass failed'), 0));
  await pruneTapes(now).catch((err: any) => logger.warn({ error: err.message }, 'Forward validation: tape prune failed'));
  if (trades || slots) logger.info({ trades, slots }, 'Forward validation: graded');
  return { trades, slots };
}
