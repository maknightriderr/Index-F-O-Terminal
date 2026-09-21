// ============================================================
// MISSED-WINNER AUDIT
// ============================================================
// Every refusal, graded against what the market actually did afterwards.
//
// This exists because of a question the engine could not answer about
// itself. The gates took the recorded book from -4.9R to +7.9R, but they
// did it by refusing 70% of the trades, and that figure is computed only
// over trades that were TAKEN. A filter that refuses everything scores
// perfectly on that measure. Without grading the refusals there is no way
// to tell capital protection from simply not trading, and the difference is
// the entire question.
//
// HOW A REFUSAL IS GRADED
//
// A refused setup has a hypothetical entry, stop and target — the engine
// built them before deciding not to take it. Replaying the underlying
// candles from the decision instant forward answers what would have
// happened: whether the stop or the target came first, how far it ran in
// favour, how far against.
//
// The grading is done on the UNDERLYING, not on the option, and that is a
// real limitation rather than a shortcut. Reconstructing the option's path
// needs a historical chain, which is only now being captured. So this
// reports what the thesis would have done, and says so. A thesis that
// worked can still have lost money in a decaying contract — which is
// precisely what three of the recorded stops turned out to be.
//
// LOOK-AHEAD
//
// This deliberately uses future data: that is what grading an outcome
// means. The protection is structural — it writes only to outcome_*
// columns, nothing in the decision path reads those columns, and a row is
// graded only once enough time has passed that the answer is settled.
// ============================================================

import { isMarketOpen, getSessionWindow } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken } from './option-chain.js';
import { classifyOutcome, NEUTRAL_BAND_R, type OutcomeClass } from './outcome-classifier.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export type { OutcomeClass };

const TICK_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * A decision is graded once its horizon has passed. Intraday theses are
 * settled by the end of their own session; a positional one needs longer.
 * Grading earlier would mark a trade that had not finished developing.
 */
const INTRADAY_HORIZON_MS = 8 * 60 * 60 * 1000;
const POSITIONAL_HORIZON_MS = 5 * 24 * 60 * 60 * 1000;

/** Rows per pass. Each one costs a historical-candle fetch, which is rate-limited. */
const MAX_PER_PASS = 25;
const STAGGER_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let started = false;

export function startMissedWinnerAudit(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runAuditPass(provider).catch((err: any) =>
      logger.warn({ error: err.message }, 'Missed-winner audit: pass failed')
    );
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, INITIAL_DELAY_MS);
  logger.info({ intervalMinutes: TICK_MS / 60000 }, 'Missed-winner audit started');
}

interface PendingRow {
  decision_id: string;
  time: Date;
  symbol: string;
  exchange: string;
  mode: string;
  decision: string;
  reason_code: string | null;
  bias: string | null;
  underlying_price: string | null;
  atr: string | null;
  stop_loss: string | null;
  target: string | null;
  risk: Record<string, unknown> | null;
}

async function runAuditPass(provider: MarketDataProvider): Promise<void> {
  const now = Date.now();
  const rows = await sql<PendingRow[]>`
    SELECT decision_id, time, symbol, exchange, mode, decision, reason_code, bias,
           underlying_price, atr, stop_loss, target, risk
    FROM decision_snapshots
    WHERE outcome_evaluated_at IS NULL
      AND time < ${new Date(now - INTRADAY_HORIZON_MS)}
    ORDER BY time ASC
    LIMIT ${MAX_PER_PASS}
  `;
  if (rows.length === 0) return;

  let graded = 0;
  for (const row of rows) {
    const horizon = row.mode === 'POSITIONAL' ? POSITIONAL_HORIZON_MS : INTRADAY_HORIZON_MS;
    if (now - new Date(row.time).getTime() < horizon) continue;

    try {
      await gradeDecision(provider, row);
      graded++;
      await sleep(STAGGER_MS);
    } catch (err: any) {
      // A row that cannot be graded must still be marked, or the sweep
      // retries it forever and never reaches the rows behind it.
      await markUngradeable(row.decision_id, err.message);
      logger.debug({ error: err.message, symbol: row.symbol }, 'Missed-winner audit: could not grade');
    }
  }
  if (graded > 0) logger.info({ graded, pending: rows.length }, 'Missed-winner audit: graded decisions');
}

async function gradeDecision(provider: MarketDataProvider, row: PendingRow): Promise<void> {
  const entry = num(row.underlying_price);
  const atr = num(row.atr);
  const direction = row.bias === 'BULLISH' ? 1 : row.bias === 'BEARISH' ? -1 : 0;

  if (entry == null || direction === 0) {
    await markUngradeable(row.decision_id, 'no underlying price or no directional bias to grade');
    return;
  }

  // The underlying levels the setup's premium stop and target corresponded
  // to. Stored on the risk block where the setup got that far; otherwise
  // derived from ATR, which is the same scale the engine sizes on.
  const stopAtr = num((row.risk as Record<string, unknown>)?.stopInAtr as string) ?? 2;
  const targetAtr = num((row.risk as Record<string, unknown>)?.targetInAtr as string) ?? 3;
  if (atr == null || atr <= 0) {
    await markUngradeable(row.decision_id, 'no ATR recorded, so the thesis has no scale to grade against');
    return;
  }

  const stopLevel = entry - direction * stopAtr * atr;
  const targetLevel = entry + direction * targetAtr * atr;

  const decidedAt = new Date(row.time).getTime();
  const candles = await fetchCandlesAfter(provider, row.symbol, row.exchange as Exchange, decidedAt, row.mode);
  if (candles.length === 0) {
    await markUngradeable(row.decision_id, 'no candles available after the decision instant');
    return;
  }

  let mfe = 0;
  let mae = 0;
  let hitTarget = false;
  let hitStop = false;
  let settledR: number | null = null;

  for (const c of candles) {
    const favourable = direction > 0 ? c.high - entry : entry - c.low;
    const adverse = direction > 0 ? entry - c.low : c.high - entry;
    if (favourable > mfe) mfe = favourable;
    if (adverse > mae) mae = adverse;

    // Within a single bar there is no way to know which side printed first,
    // so a bar that spans both levels is scored as the stop. That is the
    // conservative reading, and it biases this audit AGAINST finding missed
    // winners — which is the right direction for a measurement whose purpose
    // is to challenge the filters.
    const stopped = direction > 0 ? c.low <= stopLevel : c.high >= stopLevel;
    const targeted = direction > 0 ? c.high >= targetLevel : c.low <= targetLevel;
    if (stopped) { hitStop = true; settledR = -1; break; }
    if (targeted) { hitTarget = true; settledR = targetAtr / stopAtr; break; }
  }

  const mfeAtr = mfe / atr;
  const maeAtr = mae / atr;
  const riskPoints = stopAtr * atr;
  const mfeR = riskPoints > 0 ? mfe / riskPoints : 0;

  if (settledR == null) {
    // Neither level was reached inside the horizon. The thesis went as far
    // as it went; score it at its final mark rather than pretending it was
    // flat, because "did not resolve" is itself an outcome.
    const last = candles[candles.length - 1];
    const finalMove = direction > 0 ? last.close - entry : entry - last.close;
    settledR = riskPoints > 0 ? finalMove / riskPoints : 0;
  }

  const outcomeClass = classifyOutcome(row.decision, settledR, mfeR);

  await sql`
    UPDATE decision_snapshots SET
      outcome_evaluated_at = ${new Date()},
      outcome_class = ${outcomeClass},
      outcome_mfe_atr = ${round(mfeAtr)},
      outcome_mae_atr = ${round(maeAtr)},
      outcome_hit_target = ${hitTarget},
      outcome_hit_stop = ${hitStop},
      outcome_reached_025r = ${mfeR >= 0.25},
      outcome_reached_05r = ${mfeR >= 0.5},
      outcome_reached_1r = ${mfeR >= 1},
      outcome_r = ${round(settledR)},
      outcome_note = ${`graded on the underlying over ${candles.length} bars; the option's own path needs a historical chain`}
    WHERE decision_id = ${row.decision_id}
  `;
}


async function fetchCandlesAfter(
  provider: MarketDataProvider,
  symbol: string,
  exchange: Exchange,
  from: number,
  mode: string
): Promise<{ high: number; low: number; close: number }[]> {
  const interval = mode === 'POSITIONAL' ? 'ONE_HOUR' : 'FIFTEEN_MINUTE';
  const horizon = mode === 'POSITIONAL' ? POSITIONAL_HORIZON_MS : INTRADAY_HORIZON_MS;
  // resolveSpotToken, not a bare instrument lookup: on MCX there is no cash
  // instrument and the nearest future stands in as the reference, which is
  // the same substitution the bias engine makes when it loads its candles.
  // Grading against a different series than the decision was made from would
  // quietly produce a different answer.
  const token = await resolveSpotToken(provider, symbol, exchange).catch(() => null);
  if (!token) return [];

  const fmt = (d: Date) => {
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`;
  };

  const candles = await provider.getHistoricalData({
    exchange,
    token,
    interval,
    fromDate: fmt(new Date(from)),
    toDate: fmt(new Date(from + horizon)),
  });

  // Strictly AFTER the decision instant. The bar the decision was made
  // inside is already partly spent, and counting it would credit the
  // refusal with movement that had already happened when it refused.
  return candles
    .filter((c) => Date.parse(c.timestamp) > from)
    .map((c) => ({ high: c.high, low: c.low, close: c.close }));
}

async function markUngradeable(decisionId: string, note: string): Promise<void> {
  await sql`
    UPDATE decision_snapshots
    SET outcome_evaluated_at = ${new Date()}, outcome_class = 'UNKNOWN', outcome_note = ${note}
    WHERE decision_id = ${decisionId}
  `.catch(() => undefined);
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * What each filter gave up, and what it saved.
 *
 * The central table of the whole exercise: for every reason code, how many
 * refusals would have won, how many would have lost, and the net R of having
 * refused them. A filter with a strongly positive net saved capital. One
 * with a negative net has been preventing trades.
 */
export async function missedWinnerReport(since: Date): Promise<
  {
    code: string;
    total: number;
    missedWinners: number;
    goodRejections: number;
    neutral: number;
    ungraded: number;
    rSaved: number;
    rMissed: number;
    netR: number;
  }[]
> {
  const rows = await sql<
    {
      reason_code: string | null;
      outcome_class: string | null;
      n: string;
      total_r: string | null;
    }[]
  >`
    SELECT reason_code, outcome_class, COUNT(*) AS n, SUM(outcome_r) AS total_r
    FROM decision_snapshots
    WHERE time >= ${since} AND decision = 'REFUSE' AND outcome_evaluated_at IS NOT NULL
    GROUP BY reason_code, outcome_class
  `;

  const byCode = new Map<string, ReturnType<typeof emptyRow>>();
  for (const r of rows) {
    const code = r.reason_code ?? 'UNSPECIFIED';
    const entry = byCode.get(code) ?? emptyRow(code);
    const n = Number(r.n);
    const totalR = Number(r.total_r ?? 0);
    entry.total += n;
    if (r.outcome_class === 'MISSED_WINNER') {
      entry.missedWinners += n;
      entry.rMissed += totalR;
    } else if (r.outcome_class === 'GOOD_REJECTION') {
      entry.goodRejections += n;
      entry.rSaved += -totalR;
    } else if (r.outcome_class === 'UNKNOWN') {
      entry.ungraded += n;
    } else {
      entry.neutral += n;
    }
    byCode.set(code, entry);
  }

  return [...byCode.values()]
    .map((e) => ({ ...e, netR: round(e.rSaved - e.rMissed) }))
    .sort((a, b) => b.total - a.total);
}

function emptyRow(code: string) {
  return {
    code,
    total: 0,
    missedWinners: 0,
    goodRejections: 0,
    neutral: 0,
    ungraded: 0,
    rSaved: 0,
    rMissed: 0,
  };
}

export { NEUTRAL_BAND_R, INTRADAY_HORIZON_MS, POSITIONAL_HORIZON_MS, classifyOutcome, isMarketOpen, getSessionWindow };
