// ============================================================
// SIGNAL DIAGNOSTICS (Stage 2: signal-diagnostics measurement infrastructure)
// ============================================================
// Read-only queries over setup_events / opportunity_census(_daily), for the
// Signal Diagnostics API and page. Answers: "are we missing good trades
// because of our architecture?" Instruments are always reported separately —
// never pooled into one headline (index vs MCX especially).
//
// Every figure here is a SIMULATED paper-trade outcome from recorded
// decisions, never a broker fill or account P&L.
// ============================================================

import { sql } from '../lib/db.js';
import { costStats, opportunityStats, performanceStats, segmentOf, type GradedEventRow, type Segment } from './diagnostics-metrics.js';

export interface DiagnosticsQuery {
  since: Date | null;
  until: Date | null;
  instrument: string | null;
  /** setup_events.strategy_version (and the census windows' own); null = every version. */
  strategyVersion: string | null;
  /** setup_events.cost_version; null = every version. */
  costVersion: string | null;
}

/** Detection + decision summary, by instrument. */
export async function diagnosticsSummary(q: DiagnosticsQuery) {
  const rows = await sql<
    {
      instrument: string;
      exchange: string;
      decision: string;
      event_type: string;
      n: string;
    }[]
  >`
    SELECT instrument, exchange, decision, event_type, COUNT(*)::text AS n
    FROM setup_events
    WHERE (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
      AND (${q.costVersion}::text IS NULL OR cost_version = ${q.costVersion})
    GROUP BY instrument, exchange, decision, event_type
  `;

  const byInstrument = new Map<
    string,
    { instrument: string; exchange: string; watch: number; detected: number; rejected: number; traded: number; byEventType: Record<string, number> }
  >();
  for (const r of rows) {
    const key = `${r.instrument}:${r.exchange}`;
    const entry = byInstrument.get(key) ?? { instrument: r.instrument, exchange: r.exchange, watch: 0, detected: 0, rejected: 0, traded: 0, byEventType: {} };
    const n = Number(r.n);
    entry.byEventType[r.event_type] = (entry.byEventType[r.event_type] ?? 0) + n;
    if (r.decision === 'WATCH') entry.watch += n;
    else if (r.decision === 'DETECTED') entry.detected += n;
    else if (r.decision === 'REJECTED') entry.rejected += n;
    else if (r.decision === 'TRADED') entry.traded += n;
    byInstrument.set(key, entry);
  }

  const census = await sql<{ instrument: string; exchange: string; opportunities: string; traded: string; rejected: string; late: string; never_detected: string; capture_rate: string | null }[]>`
    SELECT instrument, exchange,
      SUM(opportunities)::text AS opportunities, SUM(traded)::text AS traded, SUM(rejected)::text AS rejected,
      SUM(late)::text AS late, SUM(never_detected)::text AS never_detected,
      CASE WHEN SUM(opportunities) > 0 THEN (SUM(traded)::numeric / SUM(opportunities))::text ELSE NULL END AS capture_rate
    FROM opportunity_census_daily
    WHERE (${q.since}::timestamptz IS NULL OR session_date >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR session_date < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
    GROUP BY instrument, exchange
  `;
  const censusByKey = new Map(census.map((c) => [`${c.instrument}:${c.exchange}`, c]));

  return [...byInstrument.values()].map((e) => {
    const c = censusByKey.get(`${e.instrument}:${e.exchange}`);
    const opportunities = c ? Number(c.opportunities) : null;
    return {
      instrument: e.instrument,
      exchange: e.exchange,
      detection: {
        opportunitiesAvailable: opportunities,
        // Detected = seen at all (traded, rejected or late); only never_detected is a miss.
        detectionRate: opportunities && opportunities > 0 && c ? round4((opportunities - Number(c.never_detected)) / opportunities) : null,
        neverDetected: c ? Number(c.never_detected) : null,
      },
      decision: {
        watch: e.watch,
        detected: e.detected,
        rejected: e.rejected,
        traded: e.traded,
      },
      byEventType: e.byEventType,
    };
  });
}

/** Rejection-reason distribution and late-entry counts, by instrument. */
export async function diagnosticsRejections(q: DiagnosticsQuery) {
  const rows = await sql<{ instrument: string; exchange: string; event_type: string; rejection_reason: string | null; n: string }[]>`
    SELECT instrument, exchange, event_type, rejection_reason, COUNT(*)::text AS n
    FROM setup_events
    WHERE decision = 'REJECTED'
      AND (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
      AND (${q.costVersion}::text IS NULL OR cost_version = ${q.costVersion})
    GROUP BY instrument, exchange, event_type, rejection_reason
    ORDER BY n DESC
  `;
  return rows.map((r) => ({ instrument: r.instrument, exchange: r.exchange, eventType: r.event_type, reason: r.rejection_reason, count: Number(r.n) }));
}

/** The daily opportunity census, by instrument. */
export async function diagnosticsCensus(q: DiagnosticsQuery) {
  const rows = await sql<
    { session_date: string; instrument: string; exchange: string; opportunities: number; traded: number; rejected: number; late: number; never_detected: number; capture_rate: string | null; correctly_empty: boolean }[]
  >`
    SELECT session_date::text, instrument, exchange, opportunities, traded, rejected, late, never_detected, capture_rate::text, correctly_empty
    FROM opportunity_census_daily
    WHERE (${q.since}::timestamptz IS NULL OR session_date >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR session_date < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
    ORDER BY session_date DESC, instrument
  `;
  return rows.map((r) => ({ ...r, capture_rate: r.capture_rate != null ? Number(r.capture_rate) : null }));
}

/** Performance by grade / pool type / trigger / instrument, from graded setup_events. */
export async function diagnosticsGrades(q: DiagnosticsQuery) {
  const rows = await sql<
    {
      instrument: string;
      exchange: string;
      grade: string | null;
      pool_type: string | null;
      trigger_type: string | null;
      n: string;
      wins: string;
      avg_r: string | null;
      net_r: string | null;
      avg_mfe_r: string | null;
      avg_mae_r: string | null;
    }[]
  >`
    SELECT instrument, exchange, grade, pool_type, trigger_type,
      COUNT(*)::text AS n,
      COUNT(*) FILTER (WHERE result_r > 0)::text AS wins,
      AVG(result_r)::text AS avg_r,
      SUM(result_r)::text AS net_r,
      AVG(mfe_r)::text AS avg_mfe_r,
      AVG(mae_r)::text AS avg_mae_r
    FROM setup_events
    WHERE graded_at IS NOT NULL AND result_r IS NOT NULL
      AND (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
      AND (${q.costVersion}::text IS NULL OR cost_version = ${q.costVersion})
    GROUP BY instrument, exchange, grade, pool_type, trigger_type
  `;
  return rows.map((r) => {
    const n = Number(r.n);
    const wins = Number(r.wins);
    return {
      instrument: r.instrument,
      exchange: r.exchange,
      grade: r.grade,
      poolType: r.pool_type,
      triggerType: r.trigger_type,
      count: n,
      winRate: n > 0 ? round4(wins / n) : null,
      avgR: r.avg_r != null ? round4(Number(r.avg_r)) : null,
      netR: r.net_r != null ? round4(Number(r.net_r)) : null,
      avgMfeR: r.avg_mfe_r != null ? round4(Number(r.avg_mfe_r)) : null,
      avgMaeR: r.avg_mae_r != null ? round4(Number(r.avg_mae_r)) : null,
    };
  });
}

/** Architecture health: filter leakage (rejected setups that later hit 2R) and late-entry leakage, by instrument. */
export async function diagnosticsLeakage(q: DiagnosticsQuery) {
  const rows = await sql<
    { instrument: string; exchange: string; event_type: string; n: string; leaked: string }[]
  >`
    SELECT instrument, exchange, event_type,
      COUNT(*)::text AS n,
      COUNT(*) FILTER (WHERE result_r >= 2)::text AS leaked
    FROM setup_events
    WHERE decision = 'REJECTED' AND graded_at IS NOT NULL AND result_r IS NOT NULL
      AND (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
      AND (${q.costVersion}::text IS NULL OR cost_version = ${q.costVersion})
    GROUP BY instrument, exchange, event_type
  `;
  return rows.map((r) => ({
    instrument: r.instrument,
    exchange: r.exchange,
    eventType: r.event_type,
    rejectedGraded: Number(r.n),
    laterHit2R: Number(r.leaked),
    leakageRate: Number(r.n) > 0 ? round4(Number(r.leaked) / Number(r.n)) : null,
  }));
}

const numOrNull = (v: string | null) => (v == null ? null : Number(v));

/**
 * Performance and cost, per instrument, for two cohorts kept apart:
 * TRADED (paper entries the engine took) and REJECTED (setups it refused,
 * graded as if entered — only those whose entry price actually traded).
 * Segment totals sum instruments inside INDEX or inside MCX, never across.
 */
export async function diagnosticsPerformance(q: DiagnosticsQuery) {
  const rows = await sql<
    {
      instrument: string;
      exchange: string;
      time: Date;
      decision: string;
      result_r: string | null;
      net_result_r: string | null;
      mfe_r: string | null;
      mae_r: string | null;
      cost_r: string | null;
      spread_r: string | null;
      slippage_r: string | null;
      charges_r: string | null;
      cost_quality: string | null;
    }[]
  >`
    SELECT instrument, exchange, time, decision,
      result_r::text, net_result_r::text, mfe_r::text, mae_r::text,
      cost_r::text, spread_r::text, slippage_r::text, charges_r::text, cost_quality
    FROM setup_events
    WHERE graded_at IS NOT NULL AND result_r IS NOT NULL
      AND event_type IN ('TRADED', 'REJECTED', 'LOW_RR', 'LATE')
      AND (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
      AND (${q.costVersion}::text IS NULL OR cost_version = ${q.costVersion})
    ORDER BY time ASC
  `;
  type Cohort = 'TRADED' | 'REJECTED';
  const groups = new Map<string, { instrument: string; exchange: string; segment: Segment; cohort: Cohort; rows: GradedEventRow[] }>();
  const segments = new Map<string, { segment: Segment; cohort: Cohort; rows: GradedEventRow[] }>();
  for (const r of rows) {
    const cohort: Cohort = r.decision === 'TRADED' ? 'TRADED' : 'REJECTED';
    const segment = segmentOf(r.exchange);
    const row: GradedEventRow = {
      time: new Date(r.time).getTime(),
      resultR: numOrNull(r.result_r),
      netResultR: numOrNull(r.net_result_r),
      mfeR: numOrNull(r.mfe_r),
      maeR: numOrNull(r.mae_r),
      costR: numOrNull(r.cost_r),
      spreadR: numOrNull(r.spread_r),
      slippageR: numOrNull(r.slippage_r),
      chargesR: numOrNull(r.charges_r),
      costQuality: r.cost_quality,
    };
    const key = `${r.instrument}:${r.exchange}:${cohort}`;
    const g = groups.get(key) ?? { instrument: r.instrument, exchange: r.exchange, segment, cohort, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
    const sKey = `${segment}:${cohort}`;
    const s = segments.get(sKey) ?? { segment, cohort, rows: [] };
    s.rows.push(row);
    segments.set(sKey, s);
  }
  return {
    byInstrument: [...groups.values()].map((g) => ({ instrument: g.instrument, exchange: g.exchange, segment: g.segment, cohort: g.cohort, performance: performanceStats(g.rows), cost: costStats(g.rows) })),
    bySegment: [...segments.values()].map((s) => ({ segment: s.segment, cohort: s.cohort, performance: performanceStats(s.rows), cost: costStats(s.rows) })),
  };
}

/**
 * Objective opportunities and what the engine did with them, from the census
 * windows (which carry strategy_version, so the version filter applies).
 * Detection and capture rates carry their numerator and denominator.
 */
export async function diagnosticsOpportunity(q: DiagnosticsQuery) {
  const windows = await sql<{ instrument: string; exchange: string; classification: string; n: string }[]>`
    SELECT instrument, exchange, classification, COUNT(*)::text AS n
    FROM opportunity_census
    WHERE (${q.since}::timestamptz IS NULL OR session_date >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR session_date < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
    GROUP BY instrument, exchange, classification
  `;
  const days = await sql<{ instrument: string; exchange: string; days: string; empty_days: string }[]>`
    SELECT instrument, exchange, COUNT(*)::text AS days, COUNT(*) FILTER (WHERE correctly_empty)::text AS empty_days
    FROM opportunity_census_daily
    WHERE (${q.since}::timestamptz IS NULL OR session_date >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR session_date < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
    GROUP BY instrument, exchange
  `;
  const counts = new Map<string, { instrument: string; exchange: string; segment: Segment; c: Record<string, number> }>();
  const segCounts = new Map<Segment, Record<string, number>>();
  for (const d of days) {
    const key = `${d.instrument}:${d.exchange}`;
    if (!counts.has(key)) counts.set(key, { instrument: d.instrument, exchange: d.exchange, segment: segmentOf(d.exchange), c: {} });
  }
  for (const w of windows) {
    const key = `${w.instrument}:${w.exchange}`;
    const e = counts.get(key) ?? { instrument: w.instrument, exchange: w.exchange, segment: segmentOf(w.exchange), c: {} };
    e.c[w.classification] = (e.c[w.classification] ?? 0) + Number(w.n);
    counts.set(key, e);
    const s = segCounts.get(e.segment) ?? {};
    s[w.classification] = (s[w.classification] ?? 0) + Number(w.n);
    segCounts.set(e.segment, s);
  }
  // The setup-level funnel beside the opportunity counts: lifecycles created, CONFIRMED (trade-ready), and graded NO_FILL.
  const funnel = await sql<{ instrument: string; exchange: string; created: string; trade_ready: string; no_fill: string }[]>`
    SELECT instrument, exchange,
      COUNT(DISTINCT lifecycle_id) FILTER (WHERE event_type NOT IN ('WATCH', 'ARBITRATION') AND decision IS DISTINCT FROM 'LIFECYCLE')::text AS created,
      COUNT(*) FILTER (WHERE event_type = 'CONFIRMED')::text AS trade_ready,
      COUNT(*) FILTER (WHERE fill_status = 'NO_FILL')::text AS no_fill
    FROM setup_events
    WHERE (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
      AND (${q.strategyVersion}::text IS NULL OR strategy_version = ${q.strategyVersion})
    GROUP BY instrument, exchange
  `;
  const funnelBy = new Map(funnel.map((f) => [`${f.instrument}:${f.exchange}`, f]));
  const dayBy = new Map(days.map((d) => [`${d.instrument}:${d.exchange}`, d]));
  return {
    byInstrument: [...counts.entries()].map(([key, e]) => ({
      instrument: e.instrument,
      exchange: e.exchange,
      segment: e.segment,
      sessions: Number(dayBy.get(key)?.days ?? 0),
      correctlyEmptySessions: Number(dayBy.get(key)?.empty_days ?? 0),
      candidatesCreated: Number(funnelBy.get(key)?.created ?? 0),
      tradeReady: Number(funnelBy.get(key)?.trade_ready ?? 0),
      noFill: Number(funnelBy.get(key)?.no_fill ?? 0),
      ...opportunityStats(e.c),
    })),
    bySegment: [...segCounts.entries()].map(([segment, c]) => ({ segment, ...opportunityStats(c) })),
  };
}

/** Post-session major-move diagnoses: what started each large move, who recognised it, and why it was or wasn't traded. */
export async function diagnosticsMajorMoves(q: DiagnosticsQuery) {
  const rows = await sql<
    {
      session_date: string;
      instrument: string;
      exchange: string;
      direction: string;
      start_time: Date | null;
      end_time: Date | null;
      start_price: string | null;
      end_price: string | null;
      size_adr: string | null;
      classification: string;
      coverage: string | null;
      first_event_type: string | null;
      first_event_time: Date | null;
      families_recognized: string[] | null;
      first_actionable: Record<string, unknown> | null;
      traded: boolean | null;
      reason: string | null;
    }[]
  >`
    SELECT session_date::text, instrument, exchange, direction, start_time, end_time, start_price::text, end_price::text, size_adr::text,
      classification, coverage, first_event_type, first_event_time, families_recognized, first_actionable, traded, reason
    FROM major_move_diagnostics
    WHERE (${q.since}::timestamptz IS NULL OR session_date >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR session_date < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
    ORDER BY session_date DESC, instrument
  `;
  return rows.map((r) => ({
    sessionDate: r.session_date,
    instrument: r.instrument,
    exchange: r.exchange,
    segment: segmentOf(r.exchange),
    direction: r.direction,
    startTime: r.start_time ? new Date(r.start_time).getTime() : null,
    endTime: r.end_time ? new Date(r.end_time).getTime() : null,
    startPrice: numOrNull(r.start_price),
    endPrice: numOrNull(r.end_price),
    sizeAdr: numOrNull(r.size_adr),
    classification: r.classification,
    coverage: r.coverage,
    firstEventType: r.first_event_type,
    firstEventTime: r.first_event_time ? new Date(r.first_event_time).getTime() : null,
    familiesRecognized: r.families_recognized ?? [],
    firstActionable: r.first_actionable,
    traded: r.traded,
    reason: r.reason,
  }));
}

/** Forward trades a SHADOW family needs before it can be considered for PAPER. */
export const SHADOW_FORWARD_TRADES_REQUIRED = 30;

/**
 * The forward record of each trigger family running in SHADOW: candidates
 * seen live, how many passed risk and cost (would have traded), and how
 * those graded. Per trigger and per segment — INDEX and MCX never pooled.
 */
export async function diagnosticsShadow(q: DiagnosticsQuery) {
  const rows = await sql<{ trigger_type: string | null; exchange: string; time: Date; would_trade: string | null; role: string | null; result_r: string | null; net_result_r: string | null; fill_status: string | null }[]>`
    SELECT trigger_type, exchange, time, context->'risk'->>'wouldTrade' AS would_trade, context->'arbitration'->>'role' AS role, result_r::text, net_result_r::text, fill_status
    FROM setup_events
    WHERE decision = 'SHADOW'
      AND (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
    ORDER BY time ASC
  `;
  const groups = new Map<string, { triggerId: string; segment: Segment; candidates: number; wouldTrade: number; selected: number; noFill: number; graded: GradedEventRow[] }>();
  const add = (triggerId: string, segment: Segment, r: (typeof rows)[number], counts: boolean) => {
    const key = `${triggerId}:${segment}`;
    const g = groups.get(key) ?? { triggerId, segment, candidates: 0, wouldTrade: 0, selected: 0, noFill: 0, graded: [] };
    if (counts) g.candidates++;
    if (r.role === 'SELECTED') g.selected++;
    if (r.would_trade === 'true') {
      g.wouldTrade++;
      if (r.fill_status === 'NO_FILL') g.noFill++;
      if (r.result_r != null)
        g.graded.push({ time: new Date(r.time).getTime(), resultR: Number(r.result_r), netResultR: numOrNull(r.net_result_r), mfeR: null, maeR: null, costR: null, spreadR: null, slippageR: null, chargesR: null, costQuality: null });
    }
    groups.set(key, g);
  };
  for (const r of rows) {
    const segment = segmentOf(r.exchange);
    add(r.trigger_type ?? '—', segment, r, true);
    // The arbitrated book: only each parent move's selected setup — what trading one per parent would have done.
    if (r.role === 'SELECTED') add('ONE_PER_PARENT', segment, r, true);
  }
  return [...groups.values()].map((g) => {
    const p = performanceStats(g.graded);
    return {
      triggerId: g.triggerId,
      segment: g.segment,
      candidates: g.candidates,
      wouldTrade: g.wouldTrade,
      selected: g.selected,
      noFill: g.noFill,
      forwardTrades: p.count,
      forwardTradesRequired: SHADOW_FORWARD_TRADES_REQUIRED,
      avgGrossR: p.avgGrossR,
      avgNetR: p.avgNetR,
      profitFactor: p.profitFactor,
      winRate: p.winRate,
    };
  });
}

/** The versions present, for the dashboard's filter. */
export async function diagnosticsVersions() {
  const rows = await sql<{ strategy_version: string | null; cost_version: string | null }[]>`
    SELECT DISTINCT strategy_version, cost_version FROM setup_events
  `;
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  return { strategyVersions: uniq(rows.map((r) => r.strategy_version)), costVersions: uniq(rows.map((r) => r.cost_version)) };
}

/** Event types the post-session grading checks against the price path. */
const GRADED_EVENT_TYPES = new Set(['TRADED', 'REJECTED', 'LOW_RR', 'LATE']);

/**
 * The newest decision-level setup_events row per lifecycle, for the Trade
 * Setup card: net R, cost quality, rejection, would-be-valid-if, fill status
 * and graded outcome. Read-only.
 */
export async function diagnosticsSetupOutcomes(lifecycleIds: readonly string[]) {
  if (lifecycleIds.length === 0) return [];
  const rows = await sql<
    {
      lifecycle_id: string;
      event_type: string;
      decision: string | null;
      gross_rr: string | null;
      net_rr: string | null;
      cost_r: string | null;
      cost_quality: string | null;
      fill_status: string | null;
      result_r: string | null;
      net_result_r: string | null;
      exit_reason: string | null;
      rejection_reason: string | null;
      would_be_valid_if: string | null;
      grade: string | null;
      graded_at: Date | null;
    }[]
  >`
    SELECT DISTINCT ON (lifecycle_id)
      lifecycle_id, event_type, decision, gross_rr::text, net_rr::text, cost_r::text, cost_quality,
      fill_status, result_r::text, net_result_r::text, exit_reason, rejection_reason, would_be_valid_if, grade, graded_at
    FROM setup_events
    WHERE lifecycle_id IN ${sql(lifecycleIds as string[])}
      AND event_type IN ('TRADED', 'REJECTED', 'LOW_RR', 'LATE', 'MISSED', 'INVALIDATED')
    ORDER BY lifecycle_id, time DESC
  `;
  return rows.map((r) => ({
    lifecycleId: r.lifecycle_id,
    eventType: r.event_type,
    decision: r.decision,
    grossRr: numOrNull(r.gross_rr),
    netRr: numOrNull(r.net_rr),
    costR: numOrNull(r.cost_r),
    costQuality: r.cost_quality,
    // Grading only checks fills for some event types; the rest are NOT_GRADED rather than guessed.
    fillStatus: r.fill_status ?? (GRADED_EVENT_TYPES.has(r.event_type) ? null : 'NOT_GRADED'),
    resultR: numOrNull(r.result_r),
    netResultR: numOrNull(r.net_result_r),
    exitReason: r.exit_reason,
    rejectionReason: r.rejection_reason,
    wouldBeValidIf: r.would_be_valid_if,
    grade: r.grade,
    gradedAt: r.graded_at ? new Date(r.graded_at).getTime() : null,
  }));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
