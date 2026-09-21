// ============================================================
// STOP EVENTS
// ============================================================
// The full state at the instant a stop fires, classified there and then.
//
// Of the 17 stops in the recorded book, 6 could not be classified at all and
// the other 11 only by fetching candles weeks later and reconstructing
// excursions from them. The 6 are permanently unknown because the chain
// state that would have settled them was never stored and cannot be
// recovered — the IV, the delta, the spread at the moment the stop hit are
// gone.
//
// This module ends that for future stops. It does NOT rewrite the six.
// Historical unknowns stay unknown: inventing a classification for them
// would be worse than admitting the gap, because a fabricated label is
// indistinguishable downstream from a real one.
//
// CLASSIFICATION
//
// The question every stop has to answer is the one the user originally
// asked: was the thesis wrong, or was the instrument behaving badly? It is
// answered by comparing how far the UNDERLYING travelled against the stop
// with how far the stop sat in the underlying's own ATR. If the underlying
// reached the level the premium stop represented, the thesis was
// invalidated. If it did not, something else closed the trade — decay, a
// vol move, or a spread that widened under it.
//
// Every classification is made from state captured at fire time. Nothing
// here is reconstructed, and nothing here is guessed: when the inputs are
// missing the answer is UNKNOWN, recorded as such.
// ============================================================

import { classifyStop, STOP_THRESHOLDS, type StopEventInput, type StopClassification } from './stop-classifier.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decisionNow } from './decision-clock.js';

/**
 * Records a stop with its full state. Fire-and-forget: instrumentation must
 * never be able to fail a trade close.
 */
export function recordStopEvent(input: StopEventInput): void {
  const { classification, basis } = classifyStop(input);
  const at = new Date(decisionNow());

  const spreadPct =
    input.bid != null && input.ask != null && input.bid > 0 && input.ask > input.bid
      ? ((input.ask - input.bid) / ((input.ask + input.bid) / 2)) * 100
      : null;

  void sql`
    INSERT INTO stop_events (
      time, setup_id, symbol, exchange, mode, direction,
      underlying_price, underlying_at_entry, option_price, entry_price, stop_price, target_price,
      atr, underlying_invalidation_level, stop_in_atr, target_in_atr,
      mfe, mae, mfe_atr, mae_atr, hold_minutes,
      iv, iv_at_entry, delta, theta, bid, ask, spread_pct, oi, volume,
      market_regime, setup_type, trade_health,
      classification, classification_basis, context
    ) VALUES (
      ${at}, ${input.setupId ?? null}, ${input.symbol}, ${input.exchange},
      ${input.mode ?? null}, ${input.direction ?? null},
      ${input.underlyingPrice ?? null}, ${input.underlyingAtEntry ?? null},
      ${input.optionPrice ?? null}, ${input.entryPrice ?? null},
      ${input.stopPrice ?? null}, ${input.targetPrice ?? null},
      ${input.atr ?? null},
      ${
        input.underlyingAtEntry != null && input.atr != null && input.stopInAtr != null && input.direction
          ? input.direction === 'BULLISH'
            ? input.underlyingAtEntry - input.stopInAtr * input.atr
            : input.underlyingAtEntry + input.stopInAtr * input.atr
          : null
      },
      ${input.stopInAtr ?? null}, ${input.targetInAtr ?? null},
      ${input.mfe ?? null}, ${input.mae ?? null}, ${input.mfeAtr ?? null}, ${input.maeAtr ?? null},
      ${input.holdMinutes ?? null},
      ${input.iv ?? null}, ${input.ivAtEntry ?? null}, ${input.delta ?? null}, ${input.theta ?? null},
      ${input.bid ?? null}, ${input.ask ?? null}, ${spreadPct}, ${input.oi ?? null}, ${input.volume ?? null},
      ${input.marketRegime ?? null}, ${input.setupType ?? null}, ${input.tradeHealth ?? null},
      ${classification}, ${basis}, ${sql.json((input.context ?? {}) as never)}
    )
  `.catch((err: any) =>
    logger.warn({ error: err.message, symbol: input.symbol }, 'Stop event: write failed')
  );

  logger.info(
    { stopEvent: { symbol: input.symbol, classification, maeAtr: input.maeAtr, stopInAtr: input.stopInAtr } },
    `Stop classified: ${input.symbol} ${classification}`
  );
}

/** Stop classifications since a given time, for the daily report. */
export async function stopClassificationSummary(since: Date): Promise<{ classification: string; n: number }[]> {
  const rows = await sql<{ classification: string | null; n: string }[]>`
    SELECT classification, COUNT(*) AS n
    FROM stop_events
    WHERE time >= ${since}
    GROUP BY classification
    ORDER BY COUNT(*) DESC
  `.catch(() => []);
  return rows.map((r) => ({ classification: r.classification ?? 'NULL', n: Number(r.n) }));
}

export { classifyStop, STOP_THRESHOLDS };
export type { StopClassification, StopEventInput };
