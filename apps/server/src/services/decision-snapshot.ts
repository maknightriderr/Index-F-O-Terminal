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

import { randomUUID } from 'node:crypto';
import type { Exchange, TradingMode, NoTradeCode, BiasDirection, MarketRegime, TradeSetup } from '@fno/shared';
import { classifyDteBucket } from '@fno/shared';
import type { ShadowStrikeSelection, ExecutionQualityResult, TargetEstimateResult } from '@fno/analytics';
import type { ExposureSnapshot } from './exposure-tracker.js';
import type { InvalidationReason } from './invalidation-reason.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { decisionNow } from './decision-clock.js';
import { classifyRefusal } from './research-contract.js';
import type { GateDiagnostic } from './gate-diagnostics.js';
import { signalAgeSeconds, validUntil, type InputTimestamps, type StalenessAssessment } from './signal-freshness.js';
import type { StrategyLabelResult } from './strategy-label.js';
import { provisionalExecutionScore, type VoteContributions } from './confidence-dimensions.js';
import type { ExitReason } from './exit-reason.js';
import { logicStamp } from '../config/trading-flags.js';

export interface DecisionSnapshotInput {
  /**
   * Generated here when absent. Supplied by the caller when it needs to link
   * something else (a sticky setup, a later stale/dead flag) to this row.
   */
  decisionId?: string;
  /** The Backtesting `signals` row a TAKE minted, when there is one. */
  signalId?: string | null;

  /** Phase 1 — input timestamps the decision was made from (measured, not enforced). */
  freshness?: {
    timestamps: InputTimestamps;
    underlyingPriceAtGeneration: number | null;
  } | null;
  /** Phase 1 — strategy taxonomy over readings the engine already computed. */
  strategy?: StrategyLabelResult | null;
  /** Phase 1 — the ten vote contributions and the rollups. Persistence only. */
  confidenceDimensions?: {
    voteContributions: VoteContributions | null;
    directionScore: number | null;
    setupQualityScore: number | null;
  } | null;
  /**
   * Phase 1 — every gate evaluated independently, written to gate_diagnostics
   * after (and only after) the snapshot row exists. Lazy so the reads behind
   * it happen only for decisions that are actually recorded. Observation
   * only: nothing reads these rows back into a decision.
   */
  gateDiagnostics?: (() => Promise<GateDiagnostic[]>) | null;

  /**
   * Phase 2 — SHADOW models computed beside the live setup from the same
   * chain. Recorded for the shadow-vs-live comparison; never read back into
   * a decision. The live strike/entry/target/stop are the `setup` fields.
   */
  shadowModels?: {
    strikeSelection?: ShadowStrikeSelection | null;
    execution?: ExecutionQualityResult | null;
    targetV2?: TargetEstimateResult | null;
  } | null;
  /**
   * Phase 2 — simulated-portfolio exposure at creation. Lazy for the same
   * reason as gateDiagnostics: the Redis read happens after the row exists
   * and can never delay or fail the decision. Observational only.
   */
  exposure?: (() => Promise<ExposureSnapshot | null>) | null;

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

  /**
   * Phase 3 (spec §5) — the live ATM contract's mechanical tradeability
   * result, when known ahead of `setup` existing (a buildTradeSetup-level
   * refusal, where `setup.available` is false). On a TAKE this is read from
   * `setup.contractValidation` instead and this field can be left unset.
   */
  contractValidation?: { tradeable: boolean; refusalReason: string | null; checks: unknown } | null;
  /** Phase 3 (spec §15) — opening-classifier.ts's label, only non-null inside the opening window. Set on refusals too (an OPENING_HOUR refusal still gets classified). */
  openingEnvironment?: string | null;
  /** Phase 3 (spec §16) — minutes since the most recent stop-loss recoverable from the cooldown gate's own Redis TTLs. Null when not recoverable (see market-bias.ts). */
  minutesSinceLastLoss?: number | null;
  /** Phase 3 (spec §20) — age in seconds of the chain-fetch OI data roomToTarget() filtered candidates by, at the moment it ran. */
  roomCheckOiAgeSeconds?: number | null;
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
 * Returns the decision_id so a caller can link later observations to it.
 */
export function recordDecisionSnapshot(input: DecisionSnapshotInput): string {
  const decisionId = input.decisionId ?? randomUUID();
  const at = new Date(decisionNow());
  const setup = input.setup ?? null;
  const available = setup?.available === true ? setup : null;
  const oq = available?.optionQuality ?? null;

  // What KIND of "no" this was, layered on top of the reason code rather
  // than replacing it. A setup rejected for being weak and a good setup
  // blocked by a cooldown are both refusals today, and when grading matures
  // they would produce identical MISSED_WINNER rows demanding opposite
  // responses. Only recorded on a refusal; a taken trade has no refusal class.
  const refusalClass = input.decision === 'REFUSE' ? classifyRefusal(input.reasonCode) : null;

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

  // --- Phase 1 instrumentation: freshness, strategy, confidence dimensions ---
  const ts = input.freshness?.timestamps ?? null;
  const toDate = (v: number | null | undefined) => (v != null ? new Date(v) : null);
  const ageSeconds = ts ? signalAgeSeconds(at.getTime(), ts) : null;
  const quoteAgeSeconds = ts?.optionQuote != null ? Math.max(0, (at.getTime() - ts.optionQuote) / 1000) : null;
  const execution = provisionalExecutionScore(spreadPct, quoteAgeSeconds);
  const strategyLabels = input.strategy?.labels ?? [];
  const dims = input.confidenceDimensions ?? null;

  // --- Phase 2: shadow models (recorded, never consulted) + DTE bucket label ---
  const strikeSel = input.shadowModels?.strikeSelection ?? null;
  const exec = input.shadowModels?.execution ?? null;
  const tv2 = input.shadowModels?.targetV2 ?? null;
  const dteValue = available?.dte ?? (input.option?.dte as number | null | undefined) ?? null;
  const dteBucket = classifyDteBucket(dteValue);

  // --- Phase 3: contract validation, reused from `setup` when it already
  // carries it (a taken trade), or passed explicitly for a buildTradeSetup-
  // level refusal where no `setup.available === true` object exists. ---
  const contractValidation = input.contractValidation ?? available?.contractValidation ?? null;

  // --- Validation review: which rules and flags this decision was made under.
  // Stamped on every decision, TAKE and REFUSE, so pre- and post-review
  // results are never pooled. NULL on rows written before 026. ---
  const logic = logicStamp();

  void sql`
    INSERT INTO decision_snapshots (
      decision_id, signal_id,
      signal_age_seconds, valid_until,
      underlying_quote_timestamp, option_quote_timestamp, oi_timestamp, pcr_timestamp,
      iv_timestamp, greeks_timestamp, volume_timestamp, underlying_price_at_generation,
      strategy_labels, primary_strategy_label,
      vote_contributions, direction_score, setup_quality_score, tradeability_score,
      execution_score, execution_score_basis,
      shadow_selected_strike, shadow_selection_score, shadow_selection_reason, shadow_rejected_alternatives,
      shadow_entry_price, shadow_execution_quality, shadow_net_r, live_net_r,
      shadow_target_v2, shadow_expected_net_r_v2, shadow_target_detail,
      dte_bucket,
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
      refusal_class,
      contract_tradeable, contract_refusal_reason, contract_validation_checks,
      opening_environment, minutes_since_last_loss, room_check_oi_age_seconds,
      logic_version, logic_flags,
      underlying, market, futures, option, location, room, risk
    ) VALUES (
      ${decisionId}, ${input.signalId ?? null},
      ${ageSeconds}, ${ts ? new Date(validUntil(at.getTime())) : null},
      ${toDate(ts?.underlyingQuote)}, ${toDate(ts?.optionQuote)}, ${toDate(ts?.oi)}, ${toDate(ts?.pcr)},
      ${toDate(ts?.iv)}, ${toDate(ts?.greeks)}, ${toDate(ts?.volume)},
      ${input.freshness?.underlyingPriceAtGeneration ?? null},
      ${sql.json(strategyLabels as never)}, ${input.strategy?.primary ?? null},
      ${sql.json((dims?.voteContributions ?? {}) as never)},
      ${dims?.directionScore ?? null}, ${dims?.setupQualityScore ?? null},
      ${oq?.score ?? null},
      ${execution.score}, ${sql.json(execution.basis as never)},
      ${strikeSel?.selectedStrike ?? null}, ${strikeSel?.selectionScore ?? null}, ${strikeSel?.selectionReason ?? null},
      ${sql.json((strikeSel?.rejectedAlternatives ?? []) as never)},
      ${exec?.shadowEntryPrice ?? null}, ${exec?.executionQuality ?? null}, ${exec?.shadowNetR ?? null}, ${exec?.liveNetR ?? null},
      ${tv2?.shadowTargetV2 ?? null}, ${tv2?.shadowExpectedNetRV2 ?? null},
      ${sql.json((tv2 ? { deltaMove: tv2.deltaMove, gammaTerm: tv2.gammaTerm, thetaDecay: tv2.thetaDecay, targetDivergence: tv2.targetDivergence, missing: tv2.missing } : {}) as never)},
      ${dteBucket},
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
      ${refusalClass},
      ${contractValidation?.tradeable ?? null}, ${contractValidation?.refusalReason ?? null},
      ${sql.json((contractValidation?.checks ?? {}) as never)},
      ${input.openingEnvironment ?? null}, ${input.minutesSinceLastLoss ?? null}, ${input.roomCheckOiAgeSeconds ?? null},
      ${logic.logicVersion}, ${sql.json({ flags: logic.flags, params: logic.params, coverageLag: logic.coverageLag ?? null } as never)},
      ${sql.json((input.underlying ?? {}) as never)},
      ${sql.json((input.market ?? {}) as never)},
      ${sql.json((input.futures ?? {}) as never)},
      ${sql.json((input.option ?? {}) as never)},
      ${sql.json((input.location ?? {}) as never)},
      ${sql.json((input.room ?? {}) as never)},
      ${sql.json((input.risk ?? {}) as never)}
    )
  `
    .then(async () => {
      // Diagnostics reference the snapshot row, so they are written only
      // once it exists. A diagnostics failure is logged and swallowed — it
      // can never reach, delay or alter the decision it describes.
      if (input.gateDiagnostics) {
        const rows = await input.gateDiagnostics();
        await recordGateDiagnostics(decisionId, rows);
      }
      // Phase 2 exposure: same after-the-row, never-throws pattern.
      if (input.exposure) {
        await recordExposure(decisionId, await input.exposure());
      }
    })
    .catch((err: any) =>
      logger.warn({ error: err.message, symbol: input.symbol, decision: input.decision }, 'Decision snapshot: write failed')
    );
  return decisionId;
}

/**
 * Writes gate-diagnostic rows for a recorded decision. Observation only —
 * the engine never reads gate_diagnostics. Never throws.
 */
export async function recordGateDiagnostics(decisionId: string, rows: readonly GateDiagnostic[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const values = rows.map((r) => ({
      gate: r.gate,
      status: r.status,
      reason: r.reason,
      threshold: r.threshold,
      input_values: r.input_values ?? {},
      was_deciding_gate: r.was_deciding_gate,
      evaluated_at: new Date(r.timestamp).toISOString(),
    }));
    // One round trip for all rows, with the JSON columns typed by Postgres
    // rather than double-encoded on the way in.
    await sql`
      INSERT INTO gate_diagnostics (decision_id, gate, status, reason, threshold, input_values, was_deciding_gate, evaluated_at)
      SELECT ${decisionId}::uuid, x.gate, x.status, x.reason, x.threshold, COALESCE(x.input_values, '{}'::jsonb), x.was_deciding_gate, x.evaluated_at
      FROM jsonb_to_recordset(${sql.json(values as never)}) AS x(
        gate text, status text, reason text, threshold jsonb, input_values jsonb, was_deciding_gate boolean, evaluated_at timestamptz
      )
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, decisionId }, 'Gate diagnostics: write failed');
  }
}

/**
 * Flags a TAKE decision's sticky setup as having been re-surfaced stale.
 * Written once (the first stale sighting) and never cleared. Measurement
 * only: the live setup is not invalidated. Never throws.
 */
export async function markDecisionStale(decisionId: string, assessment: StalenessAssessment): Promise<void> {
  try {
    await sql`
      UPDATE decision_snapshots
      SET stale = TRUE, stale_flagged_at = ${new Date(decisionNow())}, stale_move_atr = ${assessment.moveAtr}
      WHERE decision_id = ${decisionId} AND stale_flagged_at IS NULL
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, decisionId }, 'Signal staleness: flag write failed');
  }
}

/**
 * The first instant trade-health's existing DEAD rule fired for a taken
 * paper trade, with the underlying excursion at that instant in ATR.
 * Write-once. Reporting only — nothing closes the position. Never throws.
 */
export async function markDecisionDead(decisionId: string, deadAt: number, mfeAtr: number | null, maeAtr: number | null): Promise<void> {
  try {
    await sql`
      UPDATE decision_snapshots
      SET dead_at = ${new Date(deadAt)}, mfe_at_dead = ${mfeAtr}, mae_at_dead = ${maeAtr}
      WHERE decision_id = ${decisionId} AND dead_at IS NULL
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, decisionId }, 'Dead-trade flag: write failed');
  }
}

/**
 * How a taken paper trade eventually closed, backfilled onto the TAKE row
 * that minted it. `r` is the same gross premium R the close notifier
 * reports — not a new formula. Never throws.
 */
export async function recordEventualOutcome(
  link: { decisionId?: string | null; signalId?: string | null },
  exitReason: ExitReason,
  closeReason: string,
  r: number | null
): Promise<void> {
  if (!link.decisionId && !link.signalId) return;
  try {
    if (link.decisionId) {
      await sql`
        UPDATE decision_snapshots
        SET eventual_exit_reason = ${exitReason}, eventual_close_reason = ${closeReason}, eventual_r = ${r}
        WHERE decision_id = ${link.decisionId} AND eventual_exit_reason IS NULL
      `;
    } else {
      await sql`
        UPDATE decision_snapshots
        SET eventual_exit_reason = ${exitReason}, eventual_close_reason = ${closeReason}, eventual_r = ${r}
        WHERE signal_id = ${link.signalId!} AND decision = 'TAKE' AND eventual_exit_reason IS NULL
      `;
    }
  } catch (err: any) {
    logger.warn({ error: err.message, ...link }, 'Eventual outcome: write failed');
  }
}

/**
 * Phase 2 — simulated-portfolio exposure at the moment a paper setup was
 * minted. Observational only; nothing reads it back. Never throws.
 */
export async function recordExposure(decisionId: string, exposure: ExposureSnapshot | null): Promise<void> {
  if (!exposure) return;
  try {
    await sql`
      UPDATE decision_snapshots
      SET open_simulated_risk = ${exposure.openSimulatedRisk},
          open_setup_count = ${exposure.openSetupCount},
          same_symbol_exposure = ${exposure.sameSymbolExposure},
          same_underlying_exposure = ${exposure.sameUnderlyingExposure},
          same_direction_exposure = ${exposure.sameDirectionExposure},
          correlated_exposure = ${exposure.correlatedExposure},
          exposure_detail = ${sql.json(exposure.detail as never)}
      WHERE decision_id = ${decisionId}
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, decisionId }, 'Exposure: write failed');
  }
}

/**
 * Phase 2 — which of the two existing close branches fired for a taken paper
 * trade (premium stop/target first, bias reversal second). Labelling only;
 * write-once. Never throws.
 */
export async function recordInvalidationReason(
  link: { decisionId?: string | null; signalId?: string | null },
  reason: InvalidationReason | null
): Promise<void> {
  if (!reason || (!link.decisionId && !link.signalId)) return;
  try {
    if (link.decisionId) {
      await sql`
        UPDATE decision_snapshots SET invalidation_reason = ${reason}
        WHERE decision_id = ${link.decisionId} AND invalidation_reason IS NULL
      `;
    } else {
      await sql`
        UPDATE decision_snapshots SET invalidation_reason = ${reason}
        WHERE signal_id = ${link.signalId!} AND decision = 'TAKE' AND invalidation_reason IS NULL
      `;
    }
  } catch (err: any) {
    logger.warn({ error: err.message, ...link }, 'Invalidation reason: write failed');
  }
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
