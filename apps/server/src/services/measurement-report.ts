// ============================================================
// MEASUREMENT REPORT — read-only (2026-10-09)
// ============================================================
// GET /api/diagnostics/measurement. One SELECT per source; every figure is
// computed by the pure functions in measurement-core.ts. Nothing here writes,
// grades or changes a trade.
//
// What it separates, and why:
//   * cohorts PRE / POST_A / POST_B by MINT time — never pooled
//   * voided, TRACKING_LOST, off-session, open, spread and geometry-less rows are
//     counted per group and kept out of every performance figure
//   * EXPIRED is its own category beside WIN and LOSS; both win rates are given
//     with their denominators (closed-only and all-trades)
//   * baseline vs conservative-fill results side by side, by family and
//     instrument, on the SAME trades
//   * modelled costs (basis ESTIMATED_MODEL) are never mixed with anything actual
// ============================================================

import { minutesSinceSessionOpen } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { COST_RECORD_VERSION, TRADE_MEASUREMENT_MIGRATION } from './trade-costs.js';
import { POST_EXIT_VERSION } from './post-exit-tracker.js';
import { PAYOFF_GRADER_VERSION, DENSE_MAX_GAP_MS } from './payoff-grader-v2.js';
import {
  BASELINE_CHANGE_AT,
  CONSERVATIVE_FILL,
  MEASUREMENT_RELIABLE_FROM,
  TRACKING_FIX_DEPLOYED_AT,
  eligibilityOf,
  groupTallies,
  summariseCostRecords,
  summarisePayoffV2,
  summarisePostExit,
  type MeasuredTrade,
} from './measurement-core.js';

export interface MeasurementQuery {
  since: Date | null;
  until: Date | null;
  instrument: string | null;
}

const ROW_LIMIT = 20_000;

interface SignalRow {
  id: string;
  time: Date;
  symbol: string;
  inputs: any;
  cost: any | null;
}

/** Pure: a signals row (with its cost record, if any) as a MeasuredTrade. */
export function measuredTradeOf(r: SignalRow): MeasuredTrade {
  const i = r.inputs ?? {};
  const exchange = String(i.exchange ?? 'NSE');
  const mintedAt = new Date(r.time).getTime();
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    id: r.id,
    symbol: r.symbol,
    exchange,
    family: String(i.source ?? 'UNKNOWN'),
    mintedAt,
    mode: String(i.mode ?? 'INTRADAY'),
    structureType: String(i.structureType ?? 'NAKED_LONG'),
    outcome: i.outcome ?? null,
    closeReason: i.closeReason ?? null,
    voided: i.voided === true,
    generatedOffSession: minutesSinceSessionOpen(exchange as Exchange, mintedAt) == null,
    entry: num(i.entry),
    initialStop: num(i.stopLoss),
    target: num(i.target),
    exitPrice: num(i.exitPrice),
    estimatedCostPct: num(i.estimatedCostPct),
    cost:
      r.cost && num(r.cost?.spread?.perUnit) != null && num(r.cost?.total?.perUnit) != null
        ? { spreadPerUnit: Number(r.cost.spread.perUnit), spreadSource: r.cost.spread.source === 'QUOTE' ? 'QUOTE' : 'FALLBACK_ASSUMED', totalPerUnit: Number(r.cost.total.perUnit) }
        : null,
  };
}

export async function measurementReport(q: MeasurementQuery) {
  const ready = schemaFileReady(TRADE_MEASUREMENT_MIGRATION);
  const rows = await sql<SignalRow[]>`
    SELECT s.id, s.time, s.symbol, s.inputs, ${ready ? sql`c.cost` : sql`NULL::jsonb`} AS cost
    FROM signals s ${ready ? sql`LEFT JOIN trade_cost_records c ON c.signal_id = s.id` : sql``}
    WHERE s.signal_type = 'TRADE_SETUP'
      AND (${q.since}::timestamptz IS NULL OR s.time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR s.time < ${q.until})
      AND (${q.instrument}::text IS NULL OR s.symbol = ${q.instrument})
    ORDER BY s.time DESC LIMIT ${ROW_LIMIT}
  `;
  const all = rows.map(measuredTradeOf);
  // Two populations, never mixed: trades from before the measurements existed, and the measurement-reliable sample.
  const trades = all.filter((t) => t.mintedAt < MEASUREMENT_RELIABLE_FROM);
  const reliable = all.filter((t) => t.mintedAt >= MEASUREMENT_RELIABLE_FROM);
  const grouped = groupTallies(trades);
  const reliableGrouped = groupTallies(reliable);

  const sinceReliable = reliable;
  const eligibleSinceReliable = sinceReliable.filter((t) => eligibilityOf(t) === 'ELIGIBLE' || eligibilityOf(t) === 'OPEN');
  const withCost = eligibleSinceReliable.filter((t) => t.cost != null).length;

  let costs: ReturnType<typeof summariseCostRecords> | null = null;
  let postExit: ReturnType<typeof summarisePostExit> | null = null;
  let payoff: ReturnType<typeof summarisePayoffV2> | null = null;
  if (ready) {
    const costRows = await sql<{ cost: any }[]>`
      SELECT cost FROM trade_cost_records
      WHERE (${q.since}::timestamptz IS NULL OR minted_at >= ${q.since}) AND (${q.until}::timestamptz IS NULL OR minted_at < ${q.until})
        AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
      ORDER BY minted_at DESC LIMIT ${ROW_LIMIT}`;
    costs = summariseCostRecords(costRows.map((r) => r.cost));
    const peRows = await sql<{ status: string; outcome: string; record: any }[]>`
      SELECT status, outcome, record FROM trade_post_exit
      WHERE (${q.since}::timestamptz IS NULL OR exit_at >= ${q.since}) AND (${q.until}::timestamptz IS NULL OR exit_at < ${q.until})
        AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
      ORDER BY exit_at DESC LIMIT ${ROW_LIMIT}`;
    postExit = summarisePostExit(peRows);
  }
  if (schemaFileReady('037_replay_tapes_forward_validation.sql')) {
    const v2 = await sql<{ actual: any }[]>`
      SELECT actual FROM forward_outcomes
      WHERE kind = 'OPTION_PAYOFF_V2'
        AND (${q.since}::timestamptz IS NULL OR decided_at >= ${q.since}) AND (${q.until}::timestamptz IS NULL OR decided_at < ${q.until})
        AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
      ORDER BY decided_at DESC LIMIT ${ROW_LIMIT}`;
    payoff = summarisePayoffV2(v2);
  }

  return {
    note:
      'Measurement only. Paper trades: every cost is a MODEL (basis ESTIMATED_MODEL), never an actual fill. Cohorts are by mint time and never pooled; voided, TRACKING_LOST, off-session, open, spread and geometry-less rows are counted in `excluded` and kept out of every figure; EXPIRED is a separate outcome. Baseline and conservative-fill results are computed on the same trades.',
    versions: { cost: COST_RECORD_VERSION, postExit: POST_EXIT_VERSION, payoffGrader: PAYOFF_GRADER_VERSION, conservativeFill: CONSERVATIVE_FILL.id },
    schemaReady: ready,
    cohortBoundaries: {
      baselineChangeAt: new Date(BASELINE_CHANGE_AT).toISOString(),
      trackingFixDeployedAt: new Date(TRACKING_FIX_DEPLOYED_AT).toISOString(),
      PRE: 'minted before the baseline change',
      POST_A: 'minted after the baseline change, before the tracking fixes',
      POST_B: 'minted after the tracking fixes',
    },
    reliability: {
      measurementsReliableFrom: new Date(MEASUREMENT_RELIABLE_FROM).toISOString(),
      note: 'Cost records and post-exit watches exist only for trades minted / closed after the release; earlier trades are never back-filled, and the conservative-fill scenario uses the cost model\'s fallback spread for them (spreadBasis FALLBACK_ASSUMED).',
      tradesSinceReliable: sinceReliable.length,
      withCostRecord: withCost,
      costRecordCoveragePct: eligibleSinceReliable.length ? Math.round((withCost / eligibleSinceReliable.length) * 1000) / 10 : null,
    },
    conservativeFillMethod: {
      id: CONSERVATIVE_FILL.id,
      label: 'MODELLED SENSITIVITY TEST — a what-if applied to paper fills. It is NOT actual execution performance and no real order was ever placed.',
      rule: 'Target exits only: exit = recorded exit − max(1 tick, 0.5 × the contract\'s quoted bid-ask spread at the mint). Stops, expiries and all other exits unchanged. The same modelled cost is deducted in both scenarios.',
      params: { halfSpreadFraction: CONSERVATIVE_FILL.HALF_SPREAD_FRACTION, minTick: CONSERVATIVE_FILL.MIN_TICK, fallbackSpreadPct: CONSERVATIVE_FILL.FALLBACK_SPREAD_PCT },
      limitation: 'The modelled cost already contains a full spread, so this partly double-counts it: read the conservative result as a lower bound on net R. Parameters were fixed before any result was computed and are not tuned.',
    },
    payoffGraderV2: { denseGapSeconds: DENSE_MAX_GAP_MS / 1000 },
    populations: {
      historical: 'Trades minted before the measurement release (no cost record, no post-exit row). byCohort / byFamily / byInstrument below.',
      measurementReliable: 'Trades minted from measurementsReliableFrom. Reported separately in reliableSample; never merged with the historical groups.',
      netR: 'Net R covers only trades with a recorded cost %. Compare it with grossRSameTradesAsNet, never with grossR of a different set. The denominator of each metric is in denominators.',
      historicalRows: trades.length,
      measurementReliableRows: reliable.length,
    },
    byCohort: grouped.byCohort,
    byFamily: grouped.byFamily,
    byInstrument: grouped.byInstrument,
    reliableSample: { byCohort: reliableGrouped.byCohort, byFamily: reliableGrouped.byFamily, byInstrument: reliableGrouped.byInstrument },
    costs,
    postExit,
    payoff,
  };
}
