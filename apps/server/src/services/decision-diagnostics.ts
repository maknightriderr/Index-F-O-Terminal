// ============================================================
// DECISION RECORD — research view (Phase 8)
// ============================================================
// GET /api/diagnostics/decisions            recent snapshotted decisions
// GET /api/diagnostics/decision/:snapshotId one decision, end to end:
//   the input snapshot (summary), per-input data quality, market state, the
//   events, trigger candidates (parentId), common metrics, option candidates
//   (+ rejected: the record's, and every strike of each persisted option
//   plan), the arbitration result (pre-build ranking + the live slot rows
//   with the criterion each loser lost on), the final status, the outcome
//   (setup_events grading of the rows this snapshot produced) and every
//   version field. ?replay=1 also re-derives it offline and compares.
// Read-only.
// ============================================================

import type { DecisionDiagnosticsView, DecisionListRow, SignalDecisionSnapshot } from '@fno/shared';
import { sql } from '../lib/db.js';
import { loadDecisionRecord, loadSnapshot, replay } from './decision-record-store.js';
import { schemaFileReady } from './ensure-capture-schema.js';

/** Pure: what the snapshot held, without the bulky inputs. */
export function summarizeSnapshot(s: SignalDecisionSnapshot): DecisionDiagnosticsView['snapshot'] {
  const bars = s.inputs.ohlcv15m;
  const chain = s.inputs.optionChain as any;
  const futures = s.inputs.futures as any;
  const current = futures?.contracts?.find((c: any) => c.expiryLabel === 'current') ?? null;
  return {
    snapshotId: s.snapshotId,
    schemaVersion: s.schemaVersion,
    symbol: s.symbol,
    exchange: s.exchange,
    mode: s.mode,
    decisionBarTime: s.decisionBarTime,
    polledAt: s.polledAt,
    captureReason: s.captureReason,
    inputs: {
      ohlcv15m: { bars: bars.length, firstBarTime: bars[0]?.time ?? null, lastBarTime: bars[bars.length - 1]?.time ?? null, lastClose: bars[bars.length - 1]?.close ?? null },
      ohlcv5m: s.inputs.ohlcv5m ? { bars: s.inputs.ohlcv5m.length, lastBarTime: s.inputs.ohlcv5m[s.inputs.ohlcv5m.length - 1]?.time ?? null } : null,
      spot: s.inputs.spot,
      optionChain: chain ? { expiry: chain.expiry ?? null, atmStrike: chain.atmStrike ?? null, strikes: chain.strikes?.length ?? 0, timestamp: chain.timestamp ?? null } : null,
      futures: current ? { price: current.futuresPrice ?? null, oi: current.oi ?? null, changeOi: current.changeOi ?? null, interpretation: current.interpretation ?? null } : null,
      optionMetrics: s.inputs.optionMetrics,
      marketRegime: s.inputs.marketRegime,
      liquidityPools: s.inputs.liquidityMap.length,
      corporateActions: s.inputs.corporateActions,
      slotTradedKeys: s.inputs.slotTradedKeys.length,
    },
    dataQuality: s.dataQuality,
    versions: s.versions,
    config: { ...s.config, params: s.config.params },
  };
}

export async function listDecisions(args: { symbol?: string; limit?: number }): Promise<DecisionListRow[]> {
  if (!schemaFileReady('034_decision_records.sql')) return [];
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const rows = await sql<any[]>`
    SELECT s.snapshot_id, s.symbol, s.exchange, s.mode, s.decision_bar_time, s.polled_at, s.capture_reason,
           (s.data_quality->>'degraded')::boolean AS degraded, r.final_status, r.selected_candidate_id, (r.outcome IS NOT NULL) AS has_outcome
    FROM signal_decision_snapshots s LEFT JOIN decision_records r ON r.snapshot_id = s.snapshot_id
    WHERE ${args.symbol ? sql`s.symbol = ${args.symbol}` : sql`TRUE`}
    ORDER BY s.polled_at DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({
    snapshotId: r.snapshot_id,
    symbol: r.symbol,
    exchange: r.exchange,
    mode: r.mode,
    decisionBarTime: new Date(r.decision_bar_time).getTime(),
    polledAt: new Date(r.polled_at).getTime(),
    captureReason: r.capture_reason,
    degraded: r.degraded === true,
    finalStatus: r.final_status ?? null,
    selectedCandidateId: r.selected_candidate_id ?? null,
    hasOutcome: r.has_outcome === true,
  }));
}

export async function decisionDiagnostics(snapshotId: string, opts: { replay?: boolean } = {}): Promise<DecisionDiagnosticsView | null> {
  const snap = await loadSnapshot(snapshotId);
  if (!snap) return null;
  const stored = await loadDecisionRecord(snapshotId);
  const [arbitration, outcomes, optionPlans] = await Promise.all([
    sql<any[]>`
      SELECT lifecycle_id, trigger_type, direction, time, rejection_reason, context->'slotArbitration' AS a
      FROM setup_events WHERE snapshot_id = ${snapshotId} AND event_type = 'ARBITRATION' ORDER BY time, lifecycle_id
    `,
    sql<any[]>`
      SELECT lifecycle_id, event_type, trigger_type, direction, decision, result_r, mfe_r, mae_r, exit_reason, graded_at
      FROM setup_events WHERE snapshot_id = ${snapshotId} AND event_type <> 'ARBITRATION' ORDER BY time, lifecycle_id
    `,
    schemaFileReady('035_option_plans.sql')
      ? sql<any[]>`
          SELECT plan_id, signal_id, source, candidate_id, option_side, option_strike, option_expiry, option_entry, option_sl, option_tsl, option_t1, option_t2,
                 underlying_entry, underlying_stop, underlying_t1, underlying_t2, selected_strike, candidates, option_selection_version
          FROM option_plans WHERE snapshot_id = ${snapshotId}
        `
      : Promise.resolve([] as any[]),
  ]);
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    snapshot: summarizeSnapshot(snap),
    record: stored?.record ?? null,
    recordHash: stored?.hash ?? null,
    storedOutcome: stored?.outcome ?? null,
    arbitration: arbitration.map((r) => ({
      candidateId: r.lifecycle_id,
      source: r.trigger_type,
      direction: r.direction,
      parentId: r.a?.parentId ?? null,
      role: r.a?.role ?? null,
      rank: r.a?.rank ?? null,
      preBuildRank: r.a?.preBuildRank ?? null,
      refusalCode: r.a?.refusalCode ?? null,
      reason: r.rejection_reason ?? null,
      optionBuildFailure: r.a?.optionBuildFailure ?? null,
      slotDecision: r.a?.slotDecision ?? null,
      criteriaUsed: r.a?.criteriaUsed ?? [],
      inputs: r.a?.inputs ?? null,
    })),
    optionPlans: optionPlans.map((p) => ({
      planId: p.plan_id,
      signalId: p.signal_id,
      source: p.source,
      candidateId: p.candidate_id,
      option: { side: p.option_side, strike: num(p.option_strike), expiry: p.option_expiry, entry: num(p.option_entry), sl: num(p.option_sl), tsl: num(p.option_tsl), t1: num(p.option_t1), t2: num(p.option_t2) },
      underlying: { entry: num(p.underlying_entry), stop: num(p.underlying_stop), t1: num(p.underlying_t1), t2: num(p.underlying_t2) },
      selectedStrike: num(p.selected_strike),
      candidates: p.candidates ?? [],
      optionSelectionVersion: p.option_selection_version,
    })),
    outcomes: outcomes.map((o) => ({
      candidateId: o.lifecycle_id,
      eventType: o.event_type,
      source: o.trigger_type,
      decision: o.decision,
      resultR: num(o.result_r),
      mfeR: num(o.mfe_r),
      maeR: num(o.mae_r),
      exitReason: o.exit_reason ?? null,
      gradedAt: o.graded_at ? new Date(o.graded_at).getTime() : null,
    })),
    replay: opts.replay ? await replayView(snapshotId) : null,
  };
}

async function replayView(snapshotId: string): Promise<DecisionDiagnosticsView['replay']> {
  const r = await replay(snapshotId);
  if (r.status === 'NOT_FOUND') return { status: 'NOT_FOUND', diff: [], hash: null };
  if (r.status === 'CONFIG_MISMATCH') return { status: 'CONFIG_MISMATCH', diff: [], hash: null };
  return { status: r.status, diff: r.diff, hash: r.hash };
}
