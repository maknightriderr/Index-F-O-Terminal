// ============================================================
// POSITIONAL STOCK SCAN
// ============================================================
// F&O stocks stopped producing setups entirely after 10 Sep, and the reason
// is geometry, not a fault: stock options are MONTHLY only, so one session's
// move is worth about a quarter of the premium, while the tightest tradeable
// stop (15%) plus a stock's round-trip cost (median 6.5% of premium — wide
// bid-ask) needs roughly a third of it. Measured across all 209 F&O stocks on
// 17 Sep at 11 DTE: ZERO could clear the 1.5 reward:risk minimum intraday
// (median 0.93, best 1.36), while 94% clear it over the contract's remaining
// life (median 3.79). NIFTY's weekly clears it at 2.52 — that's what a small
// premium against a one-day move buys you.
//
// So the intraday scanner correctly refuses every stock, and positional was
// never scanned at all: the Market Scanner only ever ran INTRADAY, so a
// positional stock setup could only appear if someone opened that stock's tab
// and switched mode by hand. This job closes that gap.
//
// It is deliberately small and slow. Each symbol runs the full signal engine,
// and the intraday scanner already sits near Angel One's rate limit, so this
// takes a handful of the best-scoring stocks every half hour — and stops
// entirely while MAX_OPEN_POSITIONAL_STOCKS are already open, so a 94%
// pass-rate can't turn into an alert flood.
// ============================================================

import { LIQUID_SPREAD_MAX_PCT, minutesSinceSessionOpen } from '@fno/shared';
import type { FnoScannerRow } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildMarketBias } from './market-bias.js';
import { getFnoScan } from './fno-scanner.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 4 * 60 * 1000;
// Positional reads are day-scale; the opening minutes are noise either way.
const MIN_MINUTES_INTO_SESSION = 30;
/** How many positional stock setups may be live at once. Each one is a Telegram alert and a monitored position. */
const MAX_OPEN_POSITIONAL_STOCKS = 3;
/** Symbols evaluated in one pass, best score first. Each is a full multi-call signal engine run. */
const MAX_EVALUATED_PER_PASS = 4;
const MIN_CONFIDENCE = 60;
const MIN_VOLUME = 50_000;
const STAGGER_MS = 2500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let started = false;
let running = false;

export function startPositionalStockScan(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    if (running) return;
    running = true;
    runScan(provider)
      .catch((err: any) => logger.warn({ error: err.message }, 'Positional stock scan failed'))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS, maxOpen: MAX_OPEN_POSITIONAL_STOCKS }, 'Positional stock scan started');
}

/** Open (unresolved) POSITIONAL setups on non-index underlyings. */
async function countOpenPositionalStocks(): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM signals
    WHERE signal_type = 'TRADE_SETUP'
      AND inputs->>'mode' = 'POSITIONAL'
      AND inputs->>'outcome' IS NULL
      AND time > NOW() - INTERVAL '45 days'
      AND symbol NOT IN ('NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER', 'ZINC')
  `;
  return Number(rows[0]?.n ?? 0);
}

function shortlist(rows: FnoScannerRow[]): FnoScannerRow[] {
  return rows
    .filter(
      (r) =>
        r.direction !== 'NEUTRAL' &&
        r.confidence >= MIN_CONFIDENCE &&
        r.volume >= MIN_VOLUME &&
        // A spread this wide eats the edge whatever the projection says.
        (r.atmSpreadPct == null || r.atmSpreadPct <= LIQUID_SPREAD_MAX_PCT)
    )
    .sort((a, b) => b.score - a.score);
}

async function runScan(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;
  const minutes = minutesSinceSessionOpen('NSE');
  if (minutes == null || minutes < MIN_MINUTES_INTO_SESSION) return;

  const open = await countOpenPositionalStocks();
  if (open >= MAX_OPEN_POSITIONAL_STOCKS) {
    logger.info({ open }, 'Positional stock scan: at the open-position cap, skipping this pass');
    return;
  }

  const rows = await getFnoScan(provider, 'NSE');
  const candidates = shortlist(rows).slice(0, MAX_EVALUATED_PER_PASS);
  if (candidates.length === 0) return;

  let generated = 0;
  const room = MAX_OPEN_POSITIONAL_STOCKS - open;
  const refusals: string[] = [];

  for (const row of candidates) {
    if (generated >= room) break;
    try {
      // The engine records and alerts on its own when a setup passes; when it
      // doesn't, the reason is what's worth logging.
      const { tradeSetup } = await buildMarketBias(provider, row.symbol, 'NSE', 'POSITIONAL');
      if (tradeSetup.available) generated++;
      else refusals.push(`${row.symbol}: ${tradeSetup.reason ?? 'no setup'}`);
    } catch (err: any) {
      logger.warn({ error: err.message, symbol: row.symbol }, 'Positional stock scan: bias failed for candidate');
    }
    await sleep(STAGGER_MS);
  }

  logger.info(
    { evaluated: candidates.length, generated, openBefore: open, refusals: refusals.slice(0, 4) },
    'Positional stock scan complete'
  );
}
