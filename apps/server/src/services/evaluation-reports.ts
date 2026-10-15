// ============================================================
// EVALUATION REPORTS — read-only shells around evaluation-core (2026-10-15)
// ============================================================
// Four reports the audit asked for: the strategy scorecard, signal quality,
// gate validation and the portfolio-limits replay. Each only SELECTs records
// the system already keeps (signals via the paper-trades view, setup_events,
// decision_snapshots) and runs the pure core. Nothing is written; nothing in
// the decision path reads these. Results are cached in memory for a few
// minutes: they are heavy (tens of thousands of rows, bootstrap intervals) and
// move only when new trades close.
// ============================================================

import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { listPaperTrades } from './paper-trades.js';
import { BASELINE_CHANGE_AT } from './measurement-core.js';
import { DEFAULT_RISK_LIMITS } from './risk-circuit-breaker.js';
import { DEFAULT_RISK_CONFIG } from '@fno/shared';
import { TRADING_PARAMS, TRIGGER_DEMOTIONS } from '../config/trading-flags.js';
import { sessionEndExitTime } from './validation-gates.js';
import {
  EVIDENCE_RULES,
  gateValidation,
  replayCaps,
  bookStats,
  scorecard,
  signalQuality,
  strategyKeyOf,
  type CapLimits,
  type DecisionPoint,
  type ReplayTrade,
  type ScoreRow,
} from './evaluation-core.js';
import type { Exchange, PaperTradeView } from '@fno/shared';

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, build: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await build();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** For tests: forget cached reports. */
export function clearEvaluationCache(): void {
  cache.clear();
}

const istDay = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** The closed paper trades that count in performance, minted from `since`. */
async function countedTrades(since: number): Promise<PaperTradeView[]> {
  const { trades } = await listPaperTrades(2000);
  return trades.filter((t) => t.includedInPerformance && t.netR != null && t.state !== 'OPEN' && t.mintedAt >= since);
}

const scoreRowOf = (t: PaperTradeView): ScoreRow => ({
  strategy: strategyKeyOf(t.family, t.strategyLabel),
  day: istDay(t.mintedAt),
  netR: t.netR!,
  grossR: t.grossR,
  state: t.state as ScoreRow['state'],
});

/** Strategy scorecard: paper trades (net, after estimated costs) and graded candidates (underlying, before option cost). */
export function scorecardReport() {
  return cached('scorecard', async () => {
    const trades = await countedTrades(BASELINE_CHANGE_AT);
    // A strategy already taken off the paper slot in code says so, so its row is not read as a new proposal.
    const withStage = <E extends { strategy: string }>(rows: E[]) =>
      rows.map((e) => {
        const d = TRIGGER_DEMOTIONS[e.strategy];
        return { ...e, currentStage: d ? { stage: d.stage, since: d.approvedOn } : null };
      });
    const paper = withStage(scorecard(trades.map(scoreRowOf)));
    const reliable = withStage(scorecard(trades.filter((t) => t.measurementReliable).map(scoreRowOf)));

    const graded = await sql<{ trigger_type: string | null; time: Date; result_r: string; exit_reason: string | null }[]>`
      SELECT trigger_type, time, result_r::text, exit_reason
      FROM setup_events
      WHERE result_r IS NOT NULL AND time >= ${new Date(BASELINE_CHANGE_AT - 7 * 86_400_000)}
    `;
    const candidates = withStage(scorecard(
      graded.map((r) => ({
        strategy: r.trigger_type ?? 'UNKNOWN',
        day: istDay(new Date(r.time).getTime()),
        netR: Number(r.result_r),
        grossR: Number(r.result_r),
        state: r.exit_reason === 'TARGET' ? 'WIN' : r.exit_reason === 'STOP' ? 'LOSS' : 'EXPIRED',
      }))
    ));
    return {
      rules: EVIDENCE_RULES,
      note:
        'Paper trades: net R per trade after each trade’s estimated cost, from the 5 Oct architecture change. Candidates: every graded trigger-family ' +
        'candidate (taken, refused or shadow) on its own stop and objective, in the UNDERLYING’s R before any option cost — a family whose candidates ' +
        'are not positive here cannot be positive after costs. The Old Indicator is protected (never proposed for removal). Every action is a proposal ' +
        'for a human decision; nothing here changes what is traded.',
      paper,
      measurementReliable: reliable,
      candidates,
    };
  });
}

/** Direction-call quality and gate validation share one read of decision_snapshots (the last 60 days, INTRADAY). */
async function decisionPoints(): Promise<DecisionPoint[]> {
  const rows = await sql<{
    time: Date; symbol: string; exchange: string; decision: string; reason_code: string | null; bias: string | null; confidence: string | null;
    underlying_price: string | null; atr: string | null; vote_contributions: Record<string, unknown> | null; outcome_r: string | null;
  }[]>`
    SELECT time, symbol, exchange, decision, reason_code, bias, confidence::text, underlying_price::text, atr::text, vote_contributions, outcome_r::text
    FROM decision_snapshots
    WHERE mode = 'INTRADAY' AND time >= now() - interval '60 days'
  `;
  return rows.map((r) => {
    const t = new Date(r.time).getTime();
    const votes: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(r.vote_contributions ?? {})) votes[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      symbol: r.symbol,
      exchange: r.exchange,
      t,
      day: istDay(t),
      px: Number(r.underlying_price),
      atr: Number(r.atr),
      sign: r.bias === 'BULLISH' ? 1 : r.bias === 'BEARISH' ? -1 : 0,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      votes,
      decision: r.decision === 'TAKE' ? 'TAKE' : r.reason_code ?? 'REFUSE',
      outcomeR: r.outcome_r != null ? Number(r.outcome_r) : null,
    } satisfies DecisionPoint;
  });
}

export function signalQualityReport() {
  return cached('signal-quality', async () => ({
    rules: { horizonsMin: EVIDENCE_RULES.HORIZONS_MIN, toleranceMin: EVIDENCE_RULES.HORIZON_TOLERANCE_MIN, version: EVIDENCE_RULES.VERSION },
    note:
      'Does the indicator engine’s direction call predict the underlying? Each intraday decision (taken or refused) is followed to the same symbol’s ' +
      'later observation; the move is in ATR and signed by the call, so above zero means the call was right. 50% hit rate is a coin flip. Intervals ' +
      'resample whole trading days. Dimensions: rank correlation of each recorded vote score with the next hour’s signed move.',
    ...signalQuality(await decisionPoints()),
  }));
}

export function gateValidationReport() {
  return cached('gate-validation', async () => ({
    note:
      'For each refusal code, the decisions it refused against the decisions taken, graded by the missed-winner audit on its default ATR stop and target ' +
      '(the underlying, before option costs). FILTERS_WORSE: the refused decisions did worse with 95% confidence, the gate earns its keep. ' +
      'REFUSES_NO_WORSE: they did at least as well, the gate removes trades without removing losses. INCONCLUSIVE: not enough evidence either way.',
    ...gateValidation(await decisionPoints()),
  }));
}

/** The paper book replayed under the portfolio limits already written in the code. */
export function portfolioRiskReport() {
  return cached('portfolio-risk', async () => {
    const trades = await countedTrades(BASELINE_CHANGE_AT);
    const book: ReplayTrade[] = trades.map((t) => {
      const end = t.exitAt ?? t.mintedAt;
      // Rows written before 2026-10-15 stamp a session-end exit at the day rollover; the trade ended at the close.
      const exitAt = t.closeReason === 'SESSION_ENDED' && t.mode === 'INTRADAY' ? sessionEndExitTime(t.exchange as Exchange, t.mintedAt, end) : end;
      return { id: t.id, mintedAt: t.mintedAt, exitAt, symbol: t.symbol, direction: t.direction, netR: t.netR!, outcome: t.state as ReplayTrade['outcome'], day: istDay(t.mintedAt) };
    });
    const none: CapLimits = { maxOpenPositions: null, maxSameDirection: null, maxDailyLossR: null, maxTradesPerDay: null, maxConsecutiveStops: null };
    const variants: Array<{ id: string; label: string; source: string; limits: CapLimits }> = [
      { id: 'SAME_DIRECTION_CAP', label: `At most ${TRADING_PARAMS.MAX_CONCURRENT_SAME_DIRECTION} open trades in one direction`, source: 'MAX_CONCURRENT_SAME_DIRECTION (CONCURRENCY_CAP, off)', limits: { ...none, maxSameDirection: TRADING_PARAMS.MAX_CONCURRENT_SAME_DIRECTION } },
      { id: 'MAX_POSITIONS', label: `At most ${DEFAULT_RISK_CONFIG.maxPositions} open trades`, source: 'DEFAULT_RISK_CONFIG.maxPositions (not enforced)', limits: { ...none, maxOpenPositions: DEFAULT_RISK_CONFIG.maxPositions } },
      { id: 'DAILY_LOSS_STOP', label: `No new trades after a ${DEFAULT_RISK_LIMITS.maxDailyLossR}R realised loss in the day`, source: 'DEFAULT_RISK_LIMITS.maxDailyLossR (breaker compiled off)', limits: { ...none, maxDailyLossR: DEFAULT_RISK_LIMITS.maxDailyLossR } },
      {
        id: 'CIRCUIT_BREAKER',
        label: 'Every circuit-breaker rule in the code',
        source: 'DEFAULT_RISK_LIMITS (breaker compiled off)',
        limits: {
          maxOpenPositions: DEFAULT_RISK_LIMITS.maxOpenPositions,
          maxSameDirection: null,
          maxDailyLossR: DEFAULT_RISK_LIMITS.maxDailyLossR,
          maxTradesPerDay: DEFAULT_RISK_LIMITS.maxTradesPerDay,
          maxConsecutiveStops: DEFAULT_RISK_LIMITS.maxConsecutiveStops,
        },
      },
    ];
    return {
      note:
        'The paper book since the 5 Oct architecture change replayed under portfolio limits that already exist in the code but are switched off. Trades ' +
        'the engines made are taken as given and skipped when a limit would have refused them; a skipped trade does not free a slot for a trade that was ' +
        'never minted. So this reads what each limit would REMOVE. It is a replay of one short period, not evidence of future results, and nothing ' +
        'here changes what is traded.',
      baseline: bookStats(book),
      variants: variants.map((v) => ({ ...v, ...replayCaps(book, v.limits) })),
    };
  });
}

/** Logged once per report build failure; the route answers 500. */
export function logEvaluationFailure(report: string, err: unknown): void {
  logger.error({ error: err instanceof Error ? err.message : String(err), report }, 'Evaluation report failed');
}
