// ============================================================
// DECISION SNAPSHOTS
// ============================================================
// One row every time the engine evaluates a potential trade, whether it
// took it or refused it.
//
// The refusals are the whole point. The engine has been getting steadily
// stricter — an opening-hour guard, a confidence floor, a post-loss bar, a
// same-symbol block, a direction lock, a risk circuit breaker, option
// tradeability floors — and the historical comparison says that took the
// book from -4.9R to +7.9R by refusing 70% of it. But that comparison can
// only see the trades that were TAKEN. It cannot see what the refusals
// gave up, because until now a refused setup returned a sentence to the UI
// and vanished.
//
// So the honest question — is this system protecting capital, or has it
// simply stopped trading? — has never had the data to answer it. These
// rows are that data. Each one records the complete state the decision was
// made from, and the missed-winner audit later grades what the market
// actually did, so every filter can be judged on the winners it gave up as
// well as the losers it avoided.
//
// NOTHING IN THE DECISION PATH EVER READS THIS TABLE. The outcome columns
// are written after the fact by the audit, and a decision that read them
// would be reading the future. The write is fire-and-forget for the same
// reason: research instrumentation must never be able to fail a trade.
// ============================================================

import type { Exchange, TradingMode, NoTradeCode, BiasDirection, MarketRegime, TradeSetup } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decisionNow } from './decision-clock.js';

export interface DecisionSnapshotInput {
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  expiry?: string | null;
  /** The market data's own timestamp, where the feed supplies one. */
  marketTime?: number | null;

  decision: 'TAKE' | 'REFUSE';
  reasonCode?: NoTradeCode | null;
  reason: string;

  regime?: MarketRegime | null;
  bias?: BiasDirection | null;
  confidence?: number | null;
  vix?: number | null;
  pcr?: number | null;

  underlyingPrice?: number | null;
  atr?: number | null;
  vwap?: number | null;

  /** The setup, when one was built. Absent on a refusal that never got that far. */
  setup?: TradeSetup | null;

  /**
  * What the engine had already detected, named. Instrumentation only — no
  * rule reads any of this, and a test asserts that tagging cannot change a
  * decision.
  */
  setupTag?: {
    setupType: string;
    setupFamily: string;
    primaryTrigger: string;
    detail: Record<string, unknown>;
  } | null;
  /** Position within the session, from the exchange calendar, immutable once written. */
  minutesFromSessionOpen?: number | null;
  sessionBucket?: string | null;
  /** Target and stop distance in ATR, promoted out of the risk block for grouping. */
  targetAtr?: number | null;
  stopAtr?: number | null;
  /** What the not-yet-live layers together would have said. Recorded, compared, never consulted. */
  shadow?: {
    wouldRefuse: boolean | null;
    reasons: string[];
  } | null;

  /** Raw blocks, recorded verbatim so later research is not limited to today's questions. */
  underlying?: Record<string, unknown>;
  market?: Record<string, unknown>;
  futures?: Record<string, unknown>;
  option?: Record<string, unknown>;
  location?: Record<string, unknown>;
  room?: Record<string, unknown>;
  risk?: Record<string, unknown>;
}

/**
 * Records one decision. Never throws, never awaits into the caller's path.
 */
export function recordDecisionSnapshot(input: DecisionSnapshotInput): void {
  const at = new Date(decisionNow());
  const setup = input.setup ?? null;
  const available = setup?.available === true ? setup : null;
  const oq = available?.optionQuality ?? null;

  // Agreement is only meaningful when the shadow layers actually produced a
  // reading. A null here means "not comparable", which is a different fact
  // from "they disagreed" and is stored as one.
  const shadowAgreement =
    input.shadow?.wouldRefuse == null
      ? null
      : input.shadow.wouldRefuse === (input.decision === 'REFUSE');

  const spreadPct =
    available && (available.entry ?? 0) > 0 && input.option?.bid != null && input.option?.ask != null
      ? ((Number(input.option.ask) - Number(input.option.bid)) /
          ((Number(input.option.ask) + Number(input.option.bid)) / 2)) *
        100
      : null;

  void sql`
    INSERT INTO decision_snapshots (
      time, market_time, symbol, exchange, mode, expiry,
      decision, reason_code, reason,
      regime, bias, confidence, vix, pcr,
      underlying_price, atr, vwap,
      option_symbol, strike, option_type, premium, bid, ask, spread_pct,
      iv, delta, gamma, theta, vega, option_volume, option_oi,
      option_quality_score, option_quality_grade,
      location_score, room_available_atr, room_required_atr, room_ratio,
      stop_loss, target, risk_reward, position_lots,
      setup_type, setup_family, primary_trigger, setup_timeframe, setup_detail,
      minutes_from_session_open, session_bucket, target_atr, stop_atr,
      shadow_would_refuse, shadow_refuse_reasons, shadow_agrees_with_live,
      underlying, market, futures, option, location, room, risk
    ) VALUES (
      ${at},
      ${input.marketTime != null ? new Date(input.marketTime) : null},
      ${input.symbol}, ${input.exchange}, ${input.mode}, ${input.expiry ?? null},
      ${input.decision}, ${input.reasonCode ?? null}, ${input.reason},
      ${input.regime ?? null}, ${input.bias ?? null}, ${input.confidence ?? null},
      ${input.vix ?? null}, ${input.pcr ?? null},
      ${input.underlyingPrice ?? null}, ${input.atr ?? null}, ${input.vwap ?? null},
      ${(input.option?.symbol as string) ?? null},
      ${available?.strike ?? (input.option?.strike as number) ?? null},
      ${available?.side ?? (input.option?.side as string) ?? null},
      ${available?.entry ?? null},
      ${(input.option?.bid as number) ?? null},
      ${(input.option?.ask as number) ?? null},
      ${spreadPct},
      ${(input.option?.iv as number) ?? null},
      ${(input.option?.delta as number) ?? null},
      ${(input.option?.gamma as number) ?? null},
      ${(input.option?.theta as number) ?? null},
      ${(input.option?.vega as number) ?? null},
      ${(input.option?.volume as number) ?? null},
      ${(input.option?.oi as number) ?? null},
      ${oq?.score ?? null}, ${oq?.grade ?? null},
      ${(input.location?.score as number) ?? null},
      ${(input.room?.availableAtr as number) ?? null},
      ${(input.room?.requiredAtr as number) ?? null},
      ${(input.room?.ratio as number) ?? null},
      ${available?.stopLoss ?? null}, ${available?.target ?? null},
      ${available?.riskReward ?? null}, ${available?.positionSize?.lots ?? null},
      ${input.setupTag?.setupType ?? null}, ${input.setupTag?.setupFamily ?? null},
      ${input.setupTag?.primaryTrigger ?? null}, ${(input.market?.timeframe as string) ?? input.mode ?? null},
      ${sql.json((input.setupTag?.detail ?? {}) as never)},
      ${input.minutesFromSessionOpen ?? null}, ${input.sessionBucket ?? null},
      ${input.targetAtr ?? null}, ${input.stopAtr ?? null},
      ${input.shadow?.wouldRefuse ?? null},
      ${input.shadow?.reasons?.length ? input.shadow.reasons.join(',').slice(0, 200) : null},
      ${shadowAgreement},
      ${sql.json((input.underlying ?? {}) as never)},
      ${sql.json((input.market ?? {}) as never)},
      ${sql.json((input.futures ?? {}) as never)},
      ${sql.json((input.option ?? {}) as never)},
      ${sql.json((input.location ?? {}) as never)},
      ${sql.json((input.room ?? {}) as never)},
      ${sql.json((input.risk ?? {}) as never)}
    )
  `.catch((err: any) =>
    logger.warn({ error: err.message, symbol: input.symbol, decision: input.decision }, 'Decision snapshot: write failed')
  );
}

/** Rejection counts by reason code since a given time, for the daily report. */
export async function rejectionBreakdown(since: Date): Promise<{ code: string; n: number }[]> {
  const rows = await sql<{ reason_code: string | null; n: string }[]>`
    SELECT reason_code, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time >= ${since} AND decision = 'REFUSE'
    GROUP BY reason_code
    ORDER BY COUNT(*) DESC
  `;
  return rows.map((r) => ({ code: r.reason_code ?? 'UNSPECIFIED', n: Number(r.n) }));
}

/** How many decisions of each kind have been recorded, for the coverage report. */
export async function decisionCoverage(): Promise<{ decision: string; n: number; oldest: string | null }[]> {
  const rows = await sql<{ decision: string; n: string; oldest: Date | null }[]>`
    SELECT decision, COUNT(*) AS n, MIN(time) AS oldest
    FROM decision_snapshots
    GROUP BY decision
  `;
  return rows.map((r) => ({
    decision: r.decision,
    n: Number(r.n),
    oldest: r.oldest ? new Date(r.oldest).toISOString() : null,
  }));
}
