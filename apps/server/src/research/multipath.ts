// ============================================================
// MULTI-PATH RESEARCH RUNNER (research only, read-only)
// ============================================================
// Runs the event engine (@fno/analytics event-engine) over one symbol's saved
// history: per session, the data-coverage check, the event log, every
// registered trigger at every allowed decision bar, the parent-setup
// grouping, and the major-move diagnosis. Grading uses the same rules as the
// SWEEP_CLOSE clean test: one trade at a time per trigger per symbol, stop
// first when stop and target share a bar (gradePath), forced exit at the
// session's last bar, LOW_RR / NO_TARGET graded as a separate rejected bucket
// that never occupies the symbol.
//
// Session guards (fixed, the live engine's own): no decision in the first 5
// minutes; no new entry in the last 60 minutes. Opening behaviour is not
// blanket-blocked — the F family is measured separately.
//
// Touches no live code path, flag or gate.
// ============================================================

import {
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  groupIntoParents,
  detectMajorMoves,
  diagnoseMajorMove,
  classifySessionCoverage,
  TRIGGER_REGISTRY,
  BAR_MS_15M,
  type SeriesContext,
  type SessionEventLog,
  type TriggerCandidate,
  type ParentSetup,
  type MajorMoveDiagnosis,
  type CoverageReport,
} from '@fno/analytics';
import { getSessionWindow, type Exchange } from '@fno/shared';
import type { LoadedSymbol } from '../backtest/harness.js';
import { gradePath } from '../services/grade-path.js';
import { round } from './stats.js';

export const MULTIPATH_SETTLE_MIN = 5;
export const MULTIPATH_CLOSING_GUARD_MIN = 60;

export interface MultiPathRun {
  symbol: string;
  exchange: Exchange;
  ctx: SeriesContext;
  logs: Map<string, SessionEventLog>;
  coverage: Map<string, CoverageReport & { masked: string | null }>;
  candidates: TriggerCandidate[];
  parents: ParentSetup[];
  majorMoves: MajorMoveDiagnosis[];
}

export function decisionAllowed(exchange: Exchange, session: string, barTime: number, barMs: number = BAR_MS_15M): boolean {
  const w = getSessionWindow(exchange, session);
  if (!w) return false;
  if (barTime - w.open < MULTIPATH_SETTLE_MIN * 60 * 1000) return false;
  return w.close - (barTime + barMs) >= MULTIPATH_CLOSING_GUARD_MIN * 60 * 1000;
}

export function runMultiPath(symbol: string, loaded: LoadedSymbol, exchange: Exchange, opts: { triggerIds?: string[] } = {}): MultiPathRun {
  const { series, masked } = loaded;
  const ctx = buildSeriesContext(series);
  const triggerIds = opts.triggerIds ?? TRIGGER_REGISTRY.map((t) => t.triggerId);
  const logs = new Map<string, SessionEventLog>();
  const coverage = new Map<string, CoverageReport & { masked: string | null }>();
  const candidates: TriggerCandidate[] = [];
  const majorMoves: MajorMoveDiagnosis[] = [];

  for (let s = 0; s < series.sessionStarts.length; s++) {
    const session = series.sessionDates[s];
    const w = getSessionWindow(exchange, session);
    if (!w) continue;
    const start = series.sessionStarts[s];
    const end = ctx.sessionEnd(s);
    const cov = classifySessionCoverage({ sessionOpen: w.open, sessionClose: w.close, barMs: ctx.barMs, bars: series.bars.slice(start, end + 1), boots: null });
    // A masked session (thin data, a futures roll) is a data problem by the harness's own rule.
    const mask = masked.get(session) ?? null;
    coverage.set(session, { ...cov, coverage: mask ? 'DATA_GAP' : cov.coverage, masked: mask });
    if (ctx.atrAt(start) == null) continue;

    const log = runSessionEvents(ctx, s);
    logs.set(session, log);
    const sessionCandidates: TriggerCandidate[] = [];
    if (!mask) {
      for (let i = start; i <= end; i++) {
        if (!decisionAllowed(exchange, session, series.bars[i].time, ctx.barMs)) continue;
        sessionCandidates.push(...evaluateTriggersAt(ctx, log, i, triggerIds));
      }
    }
    candidates.push(...sessionCandidates);
    for (const move of detectMajorMoves(series, s, end, ctx.adrAt(s))) {
      majorMoves.push(diagnoseMajorMove({ move, coverage: coverage.get(session)!.coverage, events: log.events, candidates: sessionCandidates, traded: null }));
    }
  }

  return { symbol, exchange, ctx, logs, coverage, candidates, parents: groupIntoParents(candidates, logs, { symbol }), majorMoves };
}

export interface GradedCandidate {
  candidate: TriggerCandidate;
  symbol: string;
  /** Settled R against the stop (−1 at the stop), before costs. */
  grossR: number;
  exitKind: 'STOP' | 'TARGET' | 'SESSION_END';
  mfeR: number;
  maeR: number;
  barsHeld: number;
}

/** Grades one candidate on the bars after its decision bar, to the session's last bar. */
export function gradeCandidate(run: MultiPathRun, c: TriggerCandidate): GradedCandidate | null {
  const s = run.ctx.series.sessionDates.indexOf(c.session);
  if (s < 0) return null;
  const end = run.ctx.sessionEnd(s);
  const after = run.ctx.series.bars.slice(c.decisionIndex + 1, end + 1);
  const dir: 1 | -1 = c.direction === 'BULLISH' ? 1 : -1;
  const risk = Math.abs(c.entry - c.stop);
  if (!(risk > 0)) return null;
  const target = c.t1 ? c.t1.price : dir > 0 ? Infinity : -Infinity;
  const path = gradePath(after, dir, c.entry, c.stop, target);
  return {
    candidate: c,
    symbol: run.symbol,
    grossR: round(path.settledR),
    exitKind: path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : 'SESSION_END',
    mfeR: round(path.mfe / risk, 3),
    maeR: round(path.mae / risk, 3),
    barsHeld: path.exitIndex != null ? path.exitIndex + 1 : after.length,
  };
}

/**
 * Per trigger: the TRADE-bucket candidates taken one at a time per symbol
 * (a trade blocks that trigger until it exits), plus every LOW_RR /
 * NO_TARGET candidate graded as a rejected bucket.
 */
export function gradeTrigger(run: MultiPathRun, triggerId: string): { trades: GradedCandidate[]; rejected: GradedCandidate[] } {
  const own = run.candidates.filter((c) => c.triggerId === triggerId).sort((a, b) => a.decisionIndex - b.decisionIndex);
  const trades: GradedCandidate[] = [];
  const rejected: GradedCandidate[] = [];
  let busyUntil = -1;
  for (const c of own) {
    if (c.bucket === 'INVALID_STOP') continue;
    if (c.bucket !== 'TRADE') {
      const g = gradeCandidate(run, c);
      if (g) rejected.push(g);
      continue;
    }
    if (c.decisionIndex <= busyUntil) continue;
    const g = gradeCandidate(run, c);
    if (!g) continue;
    trades.push(g);
    busyUntil = c.decisionIndex + g.barsHeld;
  }
  return { trades, rejected };
}
