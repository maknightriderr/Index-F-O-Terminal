// ============================================================
// ORDER BLOCK / ORDER FLOW / OF1 — shadow measurement report (read-only)
// ============================================================

import { sql } from '../lib/db.js';
import type { DiagnosticsQuery } from './signal-diagnostics.js';
import { orderFlowFeedStatus } from './dhan-feed.js';
import { ORDER_BLOCK_MODE, OF1_ENABLED, OF1_TRADING, ORDER_FLOW_SYMBOLS } from '../config/order-flow-flags.js';

const n = (v: unknown) => (v == null ? 0 : Number(v));
const avg = (v: unknown) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);

export async function orderFlowReport(q: DiagnosticsQuery) {
  const since = q.since;
  const until = q.until;
  const inst = q.instrument;
  const flow = await sql<{ delta_mode: string; unavailable_reason: string | null; bars: string }[]>`
    SELECT delta_mode, unavailable_reason, COUNT(*)::text AS bars FROM order_flow_bars
    WHERE (${since}::timestamptz IS NULL OR bar_time >= ${since}) AND (${until}::timestamptz IS NULL OR bar_time < ${until}) AND (${inst}::text IS NULL OR symbol = ${inst})
    GROUP BY 1, 2 ORDER BY 1, 2
  `;
  const of1 = await sql<any[]>`
    SELECT COUNT(*)::text AS candidates,
      COUNT(*) FILTER (WHERE direction = 'BULLISH')::text AS bullish,
      COUNT(*) FILTER (WHERE direction = 'BEARISH')::text AS bearish,
      COUNT(*) FILTER (WHERE delta_mode = 'EXACT')::text AS exact,
      COUNT(*) FILTER (WHERE delta_mode = 'INFERRED')::text AS inferred,
      COUNT(*) FILTER (WHERE would_trade_if_live)::text AS would_trade,
      COUNT(*) FILTER (WHERE graded_at IS NOT NULL)::text AS graded,
      COUNT(*) FILTER (WHERE outcome = 'TARGET')::text AS targets,
      COUNT(*) FILTER (WHERE outcome = 'STOP')::text AS stops,
      COUNT(*) FILTER (WHERE outcome = 'OPEN')::text AS open_at_close,
      AVG(outcome_r) AS avg_r, AVG(mfe_r) AS avg_mfe_r, AVG(mae_r) AS avg_mae_r,
      COUNT(*) FILTER (WHERE graded_at IS NOT NULL AND existing_source_that_won IS NOT NULL)::text AS existing_traded_same_bar
    FROM of1_candidates
    WHERE (${since}::timestamptz IS NULL OR decision_bar_time >= ${since}) AND (${until}::timestamptz IS NULL OR decision_bar_time < ${until}) AND (${inst}::text IS NULL OR symbol = ${inst})
  `;
  const subtypes = await sql<{ subtype: string; n: string; avg_r: string | null }[]>`
    SELECT subtype, COUNT(*)::text AS n, AVG(outcome_r) AS avg_r FROM of1_candidates
    WHERE (${since}::timestamptz IS NULL OR decision_bar_time >= ${since}) AND (${until}::timestamptz IS NULL OR decision_bar_time < ${until}) AND (${inst}::text IS NULL OR symbol = ${inst})
    GROUP BY 1 ORDER BY 2 DESC LIMIT 20
  `;
  const winners = await sql<{ source: string; n: string }[]>`
    SELECT existing_source_that_won AS source, COUNT(*)::text AS n FROM of1_candidates
    WHERE existing_source_that_won IS NOT NULL AND (${since}::timestamptz IS NULL OR decision_bar_time >= ${since}) AND (${until}::timestamptz IS NULL OR decision_bar_time < ${until}) AND (${inst}::text IS NULL OR symbol = ${inst})
    GROUP BY 1 ORDER BY 2 DESC
  `;
  const blocks = await sql<{ state: string; n: string; held: string; failed: string; avg_mfe: string | null; avg_mae: string | null }[]>`
    SELECT state, COUNT(*)::text AS n, COUNT(*) FILTER (WHERE held)::text AS held, COUNT(*) FILTER (WHERE held = false)::text AS failed, AVG(mfe_atr) AS avg_mfe, AVG(mae_atr) AS avg_mae
    FROM order_blocks
    WHERE (${since}::timestamptz IS NULL OR block_time >= ${since}) AND (${until}::timestamptz IS NULL OR block_time < ${until}) AND (${inst}::text IS NULL OR symbol = ${inst})
    GROUP BY 1 ORDER BY 1
  `;
  const shadow = await sql<{ decisions: string; legacy_signals: string; v2_signals: string; changed: string }[]>`
    SELECT COUNT(*)::text AS decisions, COUNT(*) FILTER (WHERE legacy_vote <> 0)::text AS legacy_signals, COUNT(*) FILTER (WHERE v2_vote <> 0)::text AS v2_signals,
      COUNT(*) FILTER (WHERE changed_direction)::text AS changed
    FROM order_block_shadow
    WHERE (${since}::timestamptz IS NULL OR decision_bar_time >= ${since}) AND (${until}::timestamptz IS NULL OR decision_bar_time < ${until}) AND (${inst}::text IS NULL OR symbol = ${inst})
  `;
  const o = of1[0] ?? {};
  const sh = shadow[0] ?? { decisions: '0', legacy_signals: '0', v2_signals: '0', changed: '0' };
  return {
    settings: { orderBlockMode: ORDER_BLOCK_MODE, of1Enabled: OF1_ENABLED, of1Trading: OF1_TRADING, orderFlowSymbols: ORDER_FLOW_SYMBOLS },
    feed: orderFlowFeedStatus(),
    flowBars: flow.map((r) => ({ deltaMode: r.delta_mode, unavailableReason: r.unavailable_reason, bars: n(r.bars) })),
    of1: {
      candidates: n(o.candidates), bullish: n(o.bullish), bearish: n(o.bearish), exact: n(o.exact), inferred: n(o.inferred), wouldTradeIfLive: n(o.would_trade),
      graded: n(o.graded), targets: n(o.targets), stops: n(o.stops), openAtClose: n(o.open_at_close), avgR: avg(o.avg_r), avgMfeR: avg(o.avg_mfe_r), avgMaeR: avg(o.avg_mae_r),
      existingTradedSameBar: n(o.existing_traded_same_bar),
      bySubtype: subtypes.map((r) => ({ subtype: r.subtype, n: n(r.n), avgR: avg(r.avg_r) })),
      existingWinners: winners.map((r) => ({ source: r.source, n: n(r.n) })),
    },
    orderBlocks: {
      byState: blocks.map((r) => ({ state: r.state, n: n(r.n), held: n(r.held), failed: n(r.failed), avgMfeAtr: avg(r.avg_mfe), avgMaeAtr: avg(r.avg_mae) })),
      decisions: n(sh.decisions), legacySignals: n(sh.legacy_signals), v2Signals: n(sh.v2_signals), wouldChangeIndicatorDirection: n(sh.changed),
    },
  };
}
