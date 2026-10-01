// ============================================================
// RESEARCH COST INPUTS — volatility and chain calibration for option-cost.ts
// ============================================================
// Shared by every research report that prices a historical setup as an
// option trade (sweep-close-report, multipath-report). Read-only: it loads
// what fetch-india-vix.ts and fetch-option-chain-calibration.ts cached in
// backtest-data/ and never fetches anything.
//
// Volatility: India VIX (× 1.0 NIFTY, × 1.25 BANKNIFTY) for NSE indices;
// HV20 × 1.1 for SENSEX and MCX. SENSEX's spread falls back to NIFTY's when
// its chain had no two-sided quotes at calibration (stated in each report).
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MomentumSeries } from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { computeOptionCost, hv20, type ChainCalibration, type OptionCostResult } from './option-cost.js';

export function loadVix(dir: string = BACKTEST_DATA_DIR): Map<string, number> {
  const file = join(dir, 'INDIAVIX.json');
  if (!existsSync(file)) return new Map();
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map<string, number>();
  for (const b of data.bars ?? []) map.set(String(b.timestamp).slice(0, 10), b.close);
  return map;
}

export function nearestOnOrBefore(map: Map<string, number>, date: string): number | null {
  if (map.has(date)) return map.get(date)!;
  const keys = [...map.keys()].filter((k) => k <= date).sort();
  return keys.length ? map.get(keys[keys.length - 1])! : null;
}

export function loadChainCalibration(dir: string = BACKTEST_DATA_DIR): Record<string, ChainCalibration & { note?: string }> {
  const file = join(dir, 'option-chain-calibration.json');
  if (!existsSync(file)) return {};
  const cal = JSON.parse(readFileSync(file, 'utf8'));
  if (cal.SENSEX && (cal.SENSEX.spreadPct == null || Number.isNaN(cal.SENSEX.spreadPct)) && cal.NIFTY) {
    cal.SENSEX = { ...cal.SENSEX, spreadPct: cal.NIFTY.spreadPct, note: 'ASSUMPTION: BSE/SENSEX chain had no live bid/ask at calibration time; using NIFTY spread% as the nearest liquidity-tier proxy' };
  }
  return cal;
}

/** Prices one historical setup as an option trade, or null when volatility or calibration is missing for it. */
export function makeOptionCoster(symbol: string, series: MomentumSeries, vix: Map<string, number>, chain: (ChainCalibration & { note?: string }) | undefined) {
  const dailyCloses: number[] = [];
  const n = series.sessionStarts.length;
  for (let s = 0; s < n; s++) dailyCloses.push(series.bars[(s + 1 < n ? series.sessionStarts[s + 1] : series.bars.length) - 1].close);
  const ordinal = new Map(series.sessionDates.map((d, i) => [d, i]));
  return (args: { session: string; entry: number; atr: number; stopPoints: number; direction: 'BULLISH' | 'BEARISH' }): OptionCostResult | null => {
    let sigma: number | null = null;
    if (symbol === 'NIFTY' || symbol === 'BANKNIFTY') {
      const v = nearestOnOrBefore(vix, args.session);
      if (v != null) sigma = (v / 100) * (symbol === 'NIFTY' ? 1.0 : 1.25);
    } else {
      const idx = ordinal.get(args.session);
      const h = idx != null ? hv20(dailyCloses, idx) : null;
      if (h != null) sigma = h * 1.1;
    }
    if (sigma == null || !chain || !Number.isFinite(chain.spreadPct)) return null;
    return computeOptionCost({ symbol, session: args.session, spot: args.entry, atr: args.atr, stopPoints: args.stopPoints, direction: args.direction, sigma, chain });
  };
}
