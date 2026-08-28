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
  TradingMode,
  SpreadLeg,
} from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const HISTORY_LIMIT = 5000; // generous — trade setups are at most a handful per symbol per day

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
    profitableCloses,
    unprofitableCloses,
    profitableCloseRatePercent: profitableDecisive > 0 ? Math.round((profitableCloses / profitableDecisive) * 1000) / 10 : null,
  };
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
