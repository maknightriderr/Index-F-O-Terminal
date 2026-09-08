// ============================================================
// BACKTESTING — TRADE SETUP OUTCOME ANALYTICS
// ============================================================
// Reads the trade-setup history market-bias.ts's resolveStickyTradeSetup
// persists into the `signals` table (signal_type='TRADE_SETUP') and
// buckets it into win-rate stats by day/week/month/year and by symbol.
// This can only reflect what the system genuinely generated — setups are
// only created for symbols someone actually viewed or a scanner covered,
// so coverage grows over time rather than being backfillable.
// ============================================================

import type {
  Exchange,
  BiasDirection,
  MarketRegime,
  OptionType,
  TradeSetupRecord,
  TradeSetupOutcome,
  WinRateBucket,
  SymbolWinRate,
  WinRateAnalytics,
  RiskMetrics,
  TradingMode,
  SpreadLeg,
} from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const HISTORY_LIMIT = 5000; // generous — trade setups are at most a handful per symbol per day

// ============================================================
// ABANDONED-SETUP SWEEP
// ============================================================
// A setup is resolved by the price-level monitor, which works off the
// LOCKED setup in Redis. If that key goes away without an outcome ever
// being written — Redis eviction, a TTL expiring over a weekend, or a
// deliberate cache clear after a scoring change — the DB row has no path
// back to a terminal state and sits as "open" forever, inflating the open
// count and never contributing to any statistic.
//
// Two days is deliberately well past any legitimate resolution window:
// an INTRADAY setup closes at the day's rollover and a POSITIONAL one is
// still actively monitored while its Redis key lives, so anything still
// open after two full days has definitively lost its monitor. Closed as
// EXPIRED with NO exit price and NO return, because the honest answer is
// "we stopped tracking this" — inventing an exit price to make the row
// look resolved would put fabricated P&L into the win-rate stats, which
// is far worse than an unresolved row.
const ABANDONED_AFTER_DAYS = 2;

const ABANDONED_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 4x/day — this is housekeeping, not a live signal
const ABANDONED_SWEEP_INITIAL_DELAY_MS = 60_000; // let boot settle (DB pool, auth) before touching the table

let abandonedSweepStarted = false;

/** Periodically retires trade-setup rows whose price-level monitor is gone. See ABANDONED_AFTER_DAYS. */
export function startAbandonedSetupSweep(): void {
  if (abandonedSweepStarted) return;
  abandonedSweepStarted = true;
  const tick = () => {
    closeAbandonedTradeSetups().catch((err: any) =>
      logger.error({ error: err.message }, 'Backtesting: abandoned-setup sweep tick failed')
    );
  };
  setTimeout(tick, ABANDONED_SWEEP_INITIAL_DELAY_MS);
  setInterval(tick, ABANDONED_SWEEP_INTERVAL_MS);
  logger.info({ intervalMs: ABANDONED_SWEEP_INTERVAL_MS, afterDays: ABANDONED_AFTER_DAYS }, 'Abandoned trade-setup sweep started');
}

export async function closeAbandonedTradeSetups(): Promise<number> {
  try {
    const rows = await sql<{ id: string }[]>`
      UPDATE signals
      SET inputs = inputs || ${sql.json({ outcome: 'EXPIRED', exitPrice: null, exitTime: null, abandoned: true })}
      WHERE signal_type = 'TRADE_SETUP'
        AND inputs->>'outcome' IS NULL
        AND time < NOW() - ${`${ABANDONED_AFTER_DAYS} days`}::interval
      RETURNING id
    `;
    if (rows.length > 0) {
      logger.info({ count: rows.length }, 'Backtesting: closed abandoned trade setups that lost their price-level monitor');
    }
    return rows.length;
  } catch (err: any) {
    logger.error({ error: err.message }, 'Backtesting: abandoned-setup sweep failed');
    return 0;
  }
}

interface SignalRow {
  id: string;
  time: Date;
  symbol: string;
  direction: BiasDirection;
  confidence: string;
  inputs: any;
  reasoning: string | null;
  market_regime: string | null;
  intelligence_score: number | null;
  fwd_1d_return: string | null;
}

function toTradeSetupRecord(row: SignalRow): TradeSetupRecord {
  const inputs = row.inputs ?? {};
  return {
    id: row.id,
    symbol: row.symbol,
    exchange: (inputs.exchange ?? 'NSE') as Exchange,
    // Absent on records from before the mode toggle shipped — those were
    // all generated under what's now called INTRADAY, so that's the
    // correct read for them, not "unknown".
    mode: (inputs.mode as TradingMode) ?? 'INTRADAY',
    generatedAt: new Date(row.time).getTime(),
    direction: row.direction,
    confidence: Number(row.confidence),
    // Absent on records from before the multi-leg spread builder shipped —
    // those were all naked longs, so that's the correct default, not
    // "unknown".
    structureType: (inputs.structureType as 'NAKED_LONG' | 'SPREAD') ?? 'NAKED_LONG',
    strategy: inputs.strategy ?? null,
    legs: (inputs.legs as SpreadLeg[]) ?? null,
    netPremium: inputs.netPremium ?? null,
    maxProfit: inputs.maxProfit ?? null,
    maxLoss: inputs.maxLoss ?? null,
    breakeven: inputs.breakeven ?? null,
    breakevenLower: inputs.breakevenLower ?? null,
    breakevenUpper: inputs.breakevenUpper ?? null,
    side: (inputs.side as OptionType) ?? null,
    strike: inputs.strike != null ? Number(inputs.strike) : null,
    entry: inputs.entry != null ? Number(inputs.entry) : null,
    stopLoss: inputs.stopLoss != null ? Number(inputs.stopLoss) : null,
    target: inputs.target != null ? Number(inputs.target) : null,
    riskReward: Number(inputs.riskReward ?? 0),
    reason: row.reasoning ?? '',
    regime: (row.market_regime as MarketRegime) ?? null,
    intelligenceScore: row.intelligence_score,
    outcome: (inputs.outcome as TradeSetupOutcome) ?? null,
    exitPrice: inputs.exitPrice ?? null,
    exitTime: inputs.exitTime ?? null,
    returnPercent: row.fwd_1d_return != null ? Number(row.fwd_1d_return) : null,
  };
}

export async function getTradeSetupHistory(limit = HISTORY_LIMIT): Promise<TradeSetupRecord[]> {
  try {
    const rows = await sql<SignalRow[]>`
      SELECT id, time, symbol, direction, confidence, inputs, reasoning, market_regime, intelligence_score, fwd_1d_return
      FROM signals
      WHERE signal_type = 'TRADE_SETUP'
      ORDER BY time DESC
      LIMIT ${limit}
    `;
    return rows.map(toTradeSetupRecord);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Backtesting: trade setup history fetch failed');
    return [];
  }
}

function bucketStats(records: TradeSetupRecord[]): Omit<WinRateBucket, 'period'> {
  const wins = records.filter((r) => r.outcome === 'WIN').length;
  const losses = records.filter((r) => r.outcome === 'LOSS').length;
  const expired = records.filter((r) => r.outcome === 'EXPIRED').length;
  const open = records.filter((r) => r.outcome === null).length;
  const decisive = wins + losses;
  const returns = records.filter((r) => r.returnPercent != null).map((r) => r.returnPercent!);
  // Expectancy in R — the unit that's actually comparable across trades
  // priced at wildly different premiums. See avgRMultiple's doc comment.
  const rMultiples = records.map(toRMultiple).filter((r): r is number => r != null);

  // An EXPIRED close (bias reversed before the fixed target was reached)
  // still has a real P&L at the moment it closed — see the WinRateBucket
  // doc comment. Blend those into a second "did this actually make money"
  // view rather than letting a profitable early exit vanish from both the
  // win and loss buckets.
  const profitableCloses = wins + records.filter((r) => r.outcome === 'EXPIRED' && r.returnPercent != null && r.returnPercent > 0).length;
  const unprofitableCloses = losses + records.filter((r) => r.outcome === 'EXPIRED' && r.returnPercent != null && r.returnPercent < 0).length;
  const profitableDecisive = profitableCloses + unprofitableCloses;

  return {
    total: records.length,
    wins,
    losses,
    expired,
    open,
    winRatePercent: decisive > 0 ? Math.round((wins / decisive) * 1000) / 10 : null,
    avgReturnPercent: returns.length > 0 ? Math.round((returns.reduce((a, b) => a + b, 0) / returns.length) * 100) / 100 : null,
    avgRMultiple: rMultiples.length > 0 ? Math.round((rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length) * 100) / 100 : null,
    profitableCloses,
    unprofitableCloses,
    profitableCloseRatePercent: profitableDecisive > 0 ? Math.round((profitableCloses / profitableDecisive) * 1000) / 10 : null,
  };
}

// Win-rate alone can be misleading — a 60%-win-rate system where the
// average loss is twice the average win is still a losing system. These
// walk the resolved trades in the order they actually happened (unlike
// bucketStats above, order genuinely matters here) to answer "how bad
// did it get" and "gross wins vs. gross losses", not just "how often did
// it work."
function computeRiskMetrics(records: TradeSetupRecord[]): RiskMetrics {
  const resolved = records
    .filter((r) => r.returnPercent != null)
    .slice()
    .sort((a, b) => a.generatedAt - b.generatedAt);

  if (resolved.length === 0) {
    return { maxDrawdownR: null, maxConsecutiveLosses: 0, maxConsecutiveWins: 0, profitFactor: null };
  }

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  for (const r of resolved) {
    // Drawdown and profit factor are measured in R — multiples of the
    // trade's OWN risk — not raw returnPercent. Summing returnPercent
    // produced a "maxDrawdownPercent" of 555%, which is not a drawdown at
    // all: a drawdown can't exceed 100%, and adding up percentages each
    // struck against a different premium basis gives a number that isn't
    // proportional to money either. Every trade risks the same fraction of
    // capital by construction (position sizing targets maxRiskPerTrade), so
    // R is the unit where trades ARE comparable.
    const rMultiple = toRMultiple(r);
    if (rMultiple != null) {
      cumulative += rMultiple;
      peak = Math.max(peak, cumulative);
      maxDrawdown = Math.max(maxDrawdown, peak - cumulative);

      if (rMultiple > 0) grossProfit += rMultiple;
      else if (rMultiple < 0) grossLoss += Math.abs(rMultiple);
    }

    // Streaks walk EVERY resolved trade, using the sign of returnPercent —
    // which exists for all of them, including legacy spread rows that have
    // no stop leg to normalise into R. Counting streaks off the R-subset
    // instead silently spliced those rows out of the sequence and merged
    // the losing runs either side of them into one, inflating the reported
    // "max consecutive losses" from 7 to 11 purely as an artefact.
    const ret = r.returnPercent!;
    if (ret > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else if (ret < 0) {
      lossStreak += 1;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    maxWinStreak = Math.max(maxWinStreak, winStreak);
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  }

  return {
    maxDrawdownR: Math.round(maxDrawdown * 100) / 100,
    maxConsecutiveLosses: maxLossStreak,
    maxConsecutiveWins: maxWinStreak,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : null,
  };
}

/**
 * A trade's result as a multiple of the risk it was taken with: its
 * return as a % of entry, divided by the stop's own distance as a % of
 * entry. A trade that hit its stop is -1R; one that made half its risk
 * back is +0.5R. Null when the record has no usable stop leg (legacy
 * spread rows), which the caller skips rather than mixing units.
 */
function toRMultiple(r: TradeSetupRecord): number | null {
  if (r.returnPercent == null || r.entry == null || r.stopLoss == null || r.entry <= 0) return null;
  const riskPct = ((r.entry - r.stopLoss) / r.entry) * 100;
  if (!(riskPct > 0)) return null;
  return r.returnPercent / riskPct;
}

function bucketBy(records: TradeSetupRecord[], keyFn: (r: TradeSetupRecord) => string): WinRateBucket[] {
  const groups = new Map<string, TradeSetupRecord[]>();
  for (const r of records) {
    const key = keyFn(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return Array.from(groups.entries())
    .map(([period, recs]) => ({ period, ...bucketStats(recs) }))
    .sort((a, b) => (a.period < b.period ? 1 : -1)); // newest period first
}

// Intraday and Positional setups have fundamentally different risk
// profiles (30% vs 40% SL, session-length vs weeks-long holds) — blending
// them into one set of win-rate stats muddies both once Positional trades
// accumulate. `modeFilter` scopes the whole computation to one mode;
// omitted (or 'ALL') keeps the original combined view.
export async function getWinRateAnalytics(modeFilter?: TradingMode | 'ALL'): Promise<WinRateAnalytics> {
  const everything = await getTradeSetupHistory();
  const all = !modeFilter || modeFilter === 'ALL' ? everything : everything.filter((r) => r.mode === modeFilter);

  const bySymbolMap = new Map<string, TradeSetupRecord[]>();
  for (const r of all) {
    if (!bySymbolMap.has(r.symbol)) bySymbolMap.set(r.symbol, []);
    bySymbolMap.get(r.symbol)!.push(r);
  }
  const bySymbol: SymbolWinRate[] = Array.from(bySymbolMap.entries())
    .map(([symbol, recs]) => ({ symbol, period: symbol, ...bucketStats(recs) }))
    .sort((a, b) => b.total - a.total);

  return {
    overall: { period: 'ALL', ...bucketStats(all) },
    riskMetrics: computeRiskMetrics(all),
    daily: bucketBy(all, (r) => istDateString(r.generatedAt)),
    weekly: bucketBy(all, (r) => istWeekString(r.generatedAt)),
    monthly: bucketBy(all, (r) => istDateString(r.generatedAt).slice(0, 7)),
    yearly: bucketBy(all, (r) => istDateString(r.generatedAt).slice(0, 4)),
    bySymbol,
    intradayCount: everything.filter((r) => r.mode === 'INTRADAY').length,
    positionalCount: everything.filter((r) => r.mode === 'POSITIONAL').length,
  };
}

function istDateString(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** ISO-8601 week string (YYYY-Www), computed on the IST calendar date. */
function istWeekString(ts: number): string {
  const istDate = istDateString(ts); // YYYY-MM-DD
  const [y, m, d] = istDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // move to this ISO week's Thursday
  const isoYearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - isoYearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
