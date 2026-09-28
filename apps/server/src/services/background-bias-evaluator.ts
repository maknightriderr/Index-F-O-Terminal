// ============================================================
// BACKGROUND BIAS EVALUATOR (flag BACKGROUND_BIAS)
// ============================================================
// MCX and BSE symbols were only ever evaluated while a browser requested
// /api/market/bias/:symbol. The market scanner covers NSE indices and stocks
// only (and returns early unless NSE is open), the cache warmer never computes
// a bias, and the trade-setup monitor only rechecks symbols that already hold
// a setup. So on 28 Sep, from 17:03 to 17:59 IST — the sharpest part of
// CRUDEOIL's 270-point fall — there were zero CRUDEOIL decisions, because the
// terminal was showing GOLD.
//
// This runs buildMarketBias for BACKGROUND_BIAS_SYMBOLS (default SENSEX on BSE,
// CRUDEOIL and GOLD on MCX) every BACKGROUND_BIAS_INTERVAL_MS, exactly as an
// on-screen poll would: same gates, same mint path, same notifications. With
// MCX_POSITIONAL_BACKGROUND on it also runs POSITIONAL mode for MCX symbols,
// whose 15-30 DTE contracts pass reward:risk on a multi-day move where a
// same-session target cannot (intraday risk rules are unchanged).
//
// Per symbol and mode, a read is skipped when:
//   - the exchange is not in session (a bias off frozen quotes is not a read);
//   - anyone computed it within BACKGROUND_BIAS_RECENT_READ_MS (a browser is
//     already on it, and the broker budget is better left to that);
//   - a read for it is still in flight (a slow tick never overlaps itself).
// Symbols run one after another, outside runInteractive, so every broker call
// lands in the rate limiter's `normal` lane and a person's request keeps `high`.
//
// Concurrent minting against a browser or scanner read of the same slot is
// handled where the setup is minted — the Redis mint lock in market-bias.ts.
// ============================================================

import { isMarketOpen } from '@fno/shared';
import type { Exchange, TradingMode } from '@fno/shared';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildMarketBias, lastBiasComputedAt, type MarketBiasResult } from './market-bias.js';
import {
  BACKGROUND_BIAS_SYMBOLS,
  BACKGROUND_BIAS_SYMBOLS_REJECTED,
  COVERAGE_LAG_FLAGS,
  COVERAGE_LAG_PARAMS,
  type BackgroundSymbol,
  type CoverageLagFlags,
} from '../config/trading-flags.js';

export interface BackgroundTarget {
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
}

export type BackgroundSkipReason = 'MARKET_CLOSED' | 'RECENT_READ' | 'IN_FLIGHT';

export const targetId = (t: BackgroundTarget): string => `${t.exchange}:${t.symbol}:${t.mode}`;

/** INTRADAY for every symbol; POSITIONAL too for MCX symbols when MCX_POSITIONAL_BACKGROUND is on. */
export function backgroundTargets(
  symbols: readonly BackgroundSymbol[],
  flags: Pick<CoverageLagFlags, 'MCX_POSITIONAL_BACKGROUND'>
): BackgroundTarget[] {
  const out: BackgroundTarget[] = [];
  for (const s of symbols) {
    out.push({ symbol: s.symbol, exchange: s.exchange, mode: 'INTRADAY' });
    if (flags.MCX_POSITIONAL_BACKGROUND && s.exchange === 'MCX') out.push({ symbol: s.symbol, exchange: s.exchange, mode: 'POSITIONAL' });
  }
  return out;
}

export interface EvaluatorDeps {
  isMarketOpen: (exchange: Exchange, at: number) => boolean;
  lastComputedAt: (exchange: Exchange, symbol: string, mode: TradingMode) => number | undefined;
  buildBias: (symbol: string, exchange: Exchange, mode: TradingMode) => Promise<MarketBiasResult>;
  now: () => number;
  recentReadMs: number;
  inFlight: Set<string>;
  log?: Pick<typeof logger, 'info' | 'warn'>;
}

/** Why a target is skipped this tick, or null to evaluate it. */
export function skipReason(target: BackgroundTarget, deps: Pick<EvaluatorDeps, 'isMarketOpen' | 'lastComputedAt' | 'now' | 'recentReadMs' | 'inFlight'>): BackgroundSkipReason | null {
  const now = deps.now();
  if (!deps.isMarketOpen(target.exchange, now)) return 'MARKET_CLOSED';
  if (deps.inFlight.has(targetId(target))) return 'IN_FLIGHT';
  const last = deps.lastComputedAt(target.exchange, target.symbol, target.mode);
  if (last != null && now - last < deps.recentReadMs) return 'RECENT_READ';
  return null;
}

export interface TickReport {
  evaluated: string[];
  skipped: Record<string, BackgroundSkipReason>;
  failed: string[];
}

/** One pass over the targets, sequentially. Never throws: a failed symbol is logged and the pass moves on. */
export async function runBackgroundBiasTick(targets: BackgroundTarget[], deps: EvaluatorDeps): Promise<TickReport> {
  const log = deps.log ?? logger;
  const report: TickReport = { evaluated: [], skipped: {}, failed: [] };
  for (const target of targets) {
    const id = targetId(target);
    const skip = skipReason(target, deps);
    if (skip) {
      report.skipped[id] = skip;
      continue;
    }
    deps.inFlight.add(id);
    try {
      const { bias, tradeSetup } = await deps.buildBias(target.symbol, target.exchange, target.mode);
      report.evaluated.push(id);
      log.info(
        {
          underlying: target.symbol,
          exchange: target.exchange,
          mode: target.mode,
          bias: `${bias.direction} ${bias.confidence}`,
          regime: bias.regime,
          setup: tradeSetup.available ? `${tradeSetup.side} ${tradeSetup.strike}` : tradeSetup.noTradeCode ?? 'none',
        },
        'Background bias: evaluated'
      );
    } catch (err: any) {
      report.failed.push(id);
      log.warn({ error: err?.message ?? String(err), underlying: target.symbol, exchange: target.exchange, mode: target.mode }, 'Background bias: evaluation failed — will retry next tick');
    } finally {
      deps.inFlight.delete(id);
    }
  }
  return report;
}

let started = false;
let tickRunning = false;
const inFlight = new Set<string>();
const INITIAL_DELAY_MS = 60_000;

export function startBackgroundBiasEvaluator(provider: MarketDataProvider): void {
  if (started) return;
  started = true;

  if (!COVERAGE_LAG_FLAGS.BACKGROUND_BIAS) {
    logger.info('Background bias evaluator disabled (BACKGROUND_BIAS=off)');
    return;
  }
  if (BACKGROUND_BIAS_SYMBOLS_REJECTED.length > 0) {
    logger.warn({ rejected: BACKGROUND_BIAS_SYMBOLS_REJECTED }, 'Background bias: ignoring BACKGROUND_BIAS_SYMBOLS entries that are not SYMBOL:NSE|BSE|MCX');
  }
  const targets = backgroundTargets(BACKGROUND_BIAS_SYMBOLS, COVERAGE_LAG_FLAGS);
  const intervalMs = Math.max(30_000, COVERAGE_LAG_PARAMS.BACKGROUND_BIAS_INTERVAL_MS);

  const deps: EvaluatorDeps = {
    isMarketOpen: (exchange, at) => isMarketOpen(exchange, at),
    lastComputedAt: lastBiasComputedAt,
    buildBias: (symbol, exchange, mode) => buildMarketBias(provider, symbol, exchange, mode),
    now: () => Date.now(),
    recentReadMs: COVERAGE_LAG_PARAMS.BACKGROUND_BIAS_RECENT_READ_MS,
    inFlight,
  };

  const tick = () => {
    if (!provider.isAuthenticated()) return;
    // A pass over several symbols can outlast the interval — never overlap two.
    if (tickRunning) return;
    tickRunning = true;
    runBackgroundBiasTick(targets, deps)
      .catch((err: any) => logger.warn({ error: err?.message ?? String(err) }, 'Background bias: tick failed'))
      .finally(() => {
        tickRunning = false;
      });
  };

  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs);
  }, INITIAL_DELAY_MS);

  logger.info(
    { targets: targets.map(targetId), intervalMs, recentReadMs: deps.recentReadMs },
    'Background bias evaluator started'
  );
}
