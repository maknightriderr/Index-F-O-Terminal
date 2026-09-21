// ============================================================
// DATA QUALITY MONITOR
// ============================================================
// The engine must not decide from stale or incomplete data, and until now
// nothing checked whether it was. A decision built on a quote that stopped
// updating twenty minutes ago is not a bad decision — it is not a decision
// at all, and it would be recorded in the research history as though the
// logic had chosen it.
//
// Two levels, and the difference matters:
//
//   WARN    Something is off but the read is still usable. Recorded, and
//           attached to any decision made in the same window, so a later
//           analysis can separate "the rule was wrong" from "the feed was
//           wrong". Does not stop anything.
//
//   SEVERE  The observation cannot support a decision: no price at all, a
//           quote stamped in the future, a spread so wide the mid is
//           fiction. This refuses new trades for that symbol until the feed
//           recovers, through the same no-trade taxonomy every other
//           refusal uses.
//
// The asymmetry is deliberate. A SEVERE block costs a missed opportunity;
// trading on a broken feed costs capital with no thesis behind it at all.
// But the bar for SEVERE is set where the data genuinely cannot be read,
// not merely where it looks unusual, because a monitor that blocks trading
// on ordinary market conditions is worse than no monitor.
// ============================================================

import type { Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decisionNow } from './decision-clock.js';

export type DataQualityIssue =
  | 'STALE_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'MISSING_LTP'
  | 'MISSING_OI'
  | 'MISSING_VOLUME'
  | 'MISSING_QUOTE'
  | 'MISSING_CHAIN'
  | 'ABNORMAL_SPREAD'
  | 'TIMESTAMP_JUMP'
  | 'DATA_GAP'
  | 'DUPLICATE_OBSERVATION';

export type DataQualitySeverity = 'WARN' | 'SEVERE';

export interface DataQualityEvent {
  symbol?: string;
  exchange?: Exchange;
  issue: DataQualityIssue;
  severity: DataQualitySeverity;
  detail: string;
  context?: Record<string, unknown>;
}

/**
 * A quote older than this has stopped updating. Set against the engine's own
 * cadence rather than a round number: the bias polls on minutes, so a quote
 * that has not moved in five of them is not a slow market, it is a dead feed.
 */
const STALE_WARN_MS = 5 * 60 * 1000;
const STALE_SEVERE_MS = 15 * 60 * 1000;

/**
 * A quote stamped ahead of the decision instant means a clock disagreement
 * somewhere. Small drift is ordinary; a minute is not.
 */
const FUTURE_WARN_MS = 5_000;
const FUTURE_SEVERE_MS = 60_000;

/**
 * Spread as a percentage of mid. The setup builder already refuses to size a
 * trade above 5% on the ATM leg; this is the separate question of whether
 * the quote is readable at all. At 40% of mid the two sides are not pricing
 * the same instrument.
 */
const SPREAD_WARN_PCT = 15;
const SPREAD_SEVERE_PCT = 40;

/** Symbols currently blocked, and why. Cleared as soon as a clean read arrives. */
const blocked = new Map<string, { until: number; issue: DataQualityIssue; detail: string }>();

/**
 * How long a SEVERE block holds without a clean read to clear it. Short on
 * purpose: this is a circuit breaker for a broken feed, not a penalty box,
 * and a feed that recovers should resume trading at the next poll.
 */
const BLOCK_TTL_MS = 3 * 60 * 1000;

const blockKey = (exchange: Exchange, symbol: string) => `${exchange}:${symbol}`;

/**
 * Records a data-quality problem. Fire-and-forget: this is instrumentation,
 * and a failure to write instrumentation must never fail a decision.
 */
export function recordDataQuality(event: DataQualityEvent): void {
  const at = decisionNow();

  if (event.severity === 'SEVERE' && event.symbol && event.exchange) {
    blocked.set(blockKey(event.exchange, event.symbol), {
      until: at + BLOCK_TTL_MS,
      issue: event.issue,
      detail: event.detail,
    });
  }

  logger[event.severity === 'SEVERE' ? 'warn' : 'debug'](
    { issue: event.issue, symbol: event.symbol, exchange: event.exchange, detail: event.detail },
    'Data quality event'
  );

  void sql`
    INSERT INTO data_quality_events (time, symbol, exchange, issue, severity, detail, context)
    VALUES (
      ${new Date(at)}, ${event.symbol ?? null}, ${event.exchange ?? null},
      ${event.issue}, ${event.severity}, ${event.detail},
      ${sql.json((event.context ?? {}) as never)}
    )
  `.catch((err: any) => logger.debug({ error: err.message }, 'Data quality: write failed'));
}

/**
 * The refusal reason for a symbol whose feed is currently unusable, or null.
 * Read by the setup gate, first alongside the other hard refusals.
 */
export function dataQualityBlock(exchange: Exchange, symbol: string): string | null {
  const entry = blocked.get(blockKey(exchange, symbol));
  if (!entry) return null;
  if (decisionNow() > entry.until) {
    blocked.delete(blockKey(exchange, symbol));
    return null;
  }
  return `${symbol}'s market data is not currently usable (${entry.issue.toLowerCase().replace(/_/g, ' ')}): ${entry.detail} No setup is built from a feed this engine cannot read.`;
}

/** Clears a block once a clean observation arrives. */
export function clearDataQualityBlock(exchange: Exchange, symbol: string): void {
  blocked.delete(blockKey(exchange, symbol));
}

/**
 * Checks one observation and records whatever is wrong with it.
 *
 * Returns true when the observation is usable. A WARN returns true — the
 * point of a warning is that the read still works.
 */
export function checkObservation(input: {
  symbol: string;
  exchange: Exchange;
  ltp: number | null | undefined;
  quoteTimestamp?: number | null;
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
  oi?: number | null;
}): boolean {
  const at = decisionNow();
  let usable = true;

  if (input.ltp == null || !Number.isFinite(input.ltp) || input.ltp <= 0) {
    recordDataQuality({
      symbol: input.symbol,
      exchange: input.exchange,
      issue: 'MISSING_LTP',
      severity: 'SEVERE',
      detail: `No usable last price (${input.ltp}).`,
      context: { ltp: input.ltp },
    });
    return false;
  }

  if (input.quoteTimestamp != null && Number.isFinite(input.quoteTimestamp)) {
    const age = at - input.quoteTimestamp;
    if (age > STALE_SEVERE_MS) {
      recordDataQuality({
        symbol: input.symbol,
        exchange: input.exchange,
        issue: 'STALE_TIMESTAMP',
        severity: 'SEVERE',
        detail: `The quote has not updated in ${Math.round(age / 60000)} minutes.`,
        context: { ageMs: age },
      });
      usable = false;
    } else if (age > STALE_WARN_MS) {
      recordDataQuality({
        symbol: input.symbol,
        exchange: input.exchange,
        issue: 'STALE_TIMESTAMP',
        severity: 'WARN',
        detail: `The quote is ${Math.round(age / 60000)} minutes old.`,
        context: { ageMs: age },
      });
    } else if (age < -FUTURE_SEVERE_MS) {
      recordDataQuality({
        symbol: input.symbol,
        exchange: input.exchange,
        issue: 'FUTURE_TIMESTAMP',
        severity: 'SEVERE',
        detail: `The quote is stamped ${Math.round(-age / 1000)}s in the future — the feed clock and ours disagree.`,
        context: { aheadMs: -age },
      });
      usable = false;
    } else if (age < -FUTURE_WARN_MS) {
      recordDataQuality({
        symbol: input.symbol,
        exchange: input.exchange,
        issue: 'FUTURE_TIMESTAMP',
        severity: 'WARN',
        detail: `The quote is stamped ${Math.round(-age / 1000)}s ahead of us.`,
        context: { aheadMs: -age },
      });
    }
  }

  if (input.bid != null && input.ask != null && input.bid > 0 && input.ask > input.bid) {
    const mid = (input.bid + input.ask) / 2;
    const spreadPct = ((input.ask - input.bid) / mid) * 100;
    if (spreadPct > SPREAD_SEVERE_PCT) {
      recordDataQuality({
        symbol: input.symbol,
        exchange: input.exchange,
        issue: 'ABNORMAL_SPREAD',
        severity: 'SEVERE',
        detail: `Bid and ask are ${spreadPct.toFixed(0)}% of mid apart — the two sides are not pricing the same instrument.`,
        context: { bid: input.bid, ask: input.ask, spreadPct },
      });
      usable = false;
    } else if (spreadPct > SPREAD_WARN_PCT) {
      recordDataQuality({
        symbol: input.symbol,
        exchange: input.exchange,
        issue: 'ABNORMAL_SPREAD',
        severity: 'WARN',
        detail: `Bid-ask is ${spreadPct.toFixed(0)}% of mid.`,
        context: { spreadPct },
      });
    }
  }

  if (usable) clearDataQualityBlock(input.exchange, input.symbol);
  return usable;
}

/** Today's data-quality events, for the daily report. */
export async function dataQualitySummary(since: Date): Promise<{ issue: string; severity: string; n: number }[]> {
  const rows = await sql<{ issue: string; severity: string; n: string }[]>`
    SELECT issue, severity, COUNT(*) AS n
    FROM data_quality_events
    WHERE time >= ${since}
    GROUP BY issue, severity
    ORDER BY COUNT(*) DESC
  `;
  return rows.map((r) => ({ issue: r.issue, severity: r.severity, n: Number(r.n) }));
}

export const DATA_QUALITY_THRESHOLDS = {
  STALE_WARN_MS,
  STALE_SEVERE_MS,
  FUTURE_WARN_MS,
  FUTURE_SEVERE_MS,
  SPREAD_WARN_PCT,
  SPREAD_SEVERE_PCT,
  BLOCK_TTL_MS,
};
