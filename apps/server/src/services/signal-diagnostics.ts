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

export interface DiagnosticsQuery {
  since: Date | null;
  until: Date | null;
  instrument: string | null;
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

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
