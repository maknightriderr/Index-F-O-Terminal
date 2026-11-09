// ============================================================
// FRESH-START 2.0 INTEL — stock-in-play inputs from the F&O universe scan
// ============================================================
// The F&O scanner (fno-scanner.ts, refreshed every 150 s while NSE trades by the cache warmer) already prices all
// ~200 F&O stocks: today's % change, relative strength vs NIFTY, futures OI change and its interpretation, ATM IV,
// IV rank and the ATM bid-ask spread. This module reads its last stored scan (read-only) and turns it into
//   - FreshStockIntel per stock (an evaluation input, point-in-time: never a scan newer than the decision), and
//   - the stocks-in-play selection: which stock references get history, evaluation and option books.
// Nothing here trades; NEW_RS_STOCK_V1 (packages/analytics) applies the rules.
// ============================================================

import { SECTOR_MAP, type FnoScannerRow } from '@fno/shared';
import { FRESH_INTEL_MAX_AGE_MS, FRESH_RS_MIN_PCT, FRESH_RS_MAX_SPREAD_PCT, FRESH_RS_MAX_IV_RANK, FRESH_RS_SECTOR_TOLERANCE_PCT, FRESH_IDX_OI_LOOKBACK_MS, type FreshStockIntel, type FreshIndexIntel, type FreshOiSample } from '@fno/analytics';
import type { FreshReference } from './markets.js';

/** The scanner's stored scan (read-only-views.ts fnoScanLastKey): when it was taken, and its rows. */
export interface FreshScan { at: number; rows: readonly FnoScannerRow[] }
export const FRESH_SCAN_KEY = 'fno-scanner:last:NSE';
const BULLISH_OI = new Set(['LONG_BUILDUP', 'SHORT_COVERING']), BEARISH_OI = new Set(['SHORT_BUILDUP', 'LONG_UNWINDING']);
const MIN_SECTOR_MEMBERS = 2;

/** The underlying ticker(s) a stock reference answers to in the scan (master name / underlying). */
export const freshRefSymbols = (r: FreshReference): string[] => [...new Set([r.name, r.signal.underlying, r.signal.name].filter((x): x is string => !!x))];

/** Pure: a parsed scan, or null when it is malformed. */
export function freshParseScan(raw: string | null): FreshScan | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as { at?: unknown; rows?: unknown };
    return typeof x.at === 'number' && Number.isFinite(x.at) && Array.isArray(x.rows) ? { at: x.at, rows: x.rows as FnoScannerRow[] } : null;
  } catch { return null; }
}

/** Pure: the mean relative strength of each sector's stocks in the scan (sectors with fewer than 2 members omitted). */
export function freshSectorStrength(rows: readonly FnoScannerRow[]): Map<string, number> {
  const bySymbol = new Map(rows.map((r) => [r.symbol, r])), out = new Map<string, number>();
  for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
    const xs = symbols.map((s) => bySymbol.get(s)?.relativeStrength).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (xs.length >= MIN_SECTOR_MEMBERS) out.set(sector, xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  return out;
}
const sectorOf = (symbol: string): string | null => {
  const hits = Object.entries(SECTOR_MAP).filter(([, xs]) => xs.includes(symbol)).map(([s]) => s);
  return hits.length === 1 ? hits[0] : null;
};

/**
 * Pure: a stock's intel from the scan as of `now`, or null when the scan has no usable row, is older than
 * FRESH_INTEL_MAX_AGE_MS, or is newer than `now` (an evaluation never reads a later scan).
 */
export function freshStockIntel(scan: FreshScan | null, ref: FreshReference, now: number, sectors?: ReadonlyMap<string, number>): FreshStockIntel | null {
  if (!scan || !Number.isFinite(scan.at) || scan.at > now || now - scan.at > FRESH_INTEL_MAX_AGE_MS) return null;
  const symbols = freshRefSymbols(ref), row = scan.rows.find((r) => symbols.includes(r.symbol));
  const at = row && Number.isFinite(row.timestamp) ? row.timestamp : scan.at;
  if (!row || !Number.isFinite(row.relativeStrength) || !(at <= scan.at) || now - at > FRESH_INTEL_MAX_AGE_MS) return null;
  const sector = sectorOf(row.symbol), sectorRs = sector ? (sectors ?? freshSectorStrength(scan.rows)).get(sector) ?? null : null;
  return {
    at,
    relativeStrength: row.relativeStrength,
    oiInterpretation: String(row.oiInterpretation),
    sectorRelativeStrength: sectorRs,
    atmSpreadPct: row.atmSpreadPct != null && Number.isFinite(row.atmSpreadPct) ? row.atmSpreadPct : null,
    ivRank: row.ivRank != null && Number.isFinite(row.ivRank) ? row.ivRank : null,
  };
}

/** Pure: +1 / -1 when the intel passes NEW_RS_STOCK_V1's scan gates in that direction, else 0. */
export function freshInPlayDirection(x: FreshStockIntel): 1 | -1 | 0 {
  const liquid = x.atmSpreadPct != null && x.atmSpreadPct <= FRESH_RS_MAX_SPREAD_PCT && (x.ivRank == null || x.ivRank < FRESH_RS_MAX_IV_RANK);
  if (!liquid) return 0;
  const sectorOk = (d: number) => x.sectorRelativeStrength == null || d * x.sectorRelativeStrength >= -FRESH_RS_SECTOR_TOLERANCE_PCT;
  if (x.relativeStrength >= FRESH_RS_MIN_PCT && BULLISH_OI.has(x.oiInterpretation) && sectorOk(1)) return 1;
  if (x.relativeStrength <= -FRESH_RS_MIN_PCT && BEARISH_OI.has(x.oiInterpretation) && sectorOk(-1)) return -1;
  return 0;
}

/**
 * Pure: up to `slots` stocks in play, alternating the strongest leader and the weakest laggard (by |RS|) so both
 * directions are covered. A stock already selected that still qualifies keeps its place (no history churn), and
 * only event-clear stocks are considered. Returns [] when the scan is unusable, so the caller keeps its fallback.
 */
export function freshStocksInPlay(scan: FreshScan | null, stocks: readonly FreshReference[], now: number, slots: number, previous: ReadonlySet<string>, isClear: (r: FreshReference) => boolean): FreshReference[] {
  if (!scan || slots <= 0) return [];
  const sectors = freshSectorStrength(scan.rows);
  const scored = stocks.filter(isClear).map((r) => { const x = freshStockIntel(scan, r, now, sectors); return x ? { r, x, d: freshInPlayDirection(x) } : null; })
    .filter((y): y is { r: FreshReference; x: FreshStockIntel; d: 1 | -1 | 0 } => y != null && y.d !== 0);
  const bulls = scored.filter((y) => y.d === 1).sort((a, b) => b.x.relativeStrength - a.x.relativeStrength).map((y) => y.r);
  const bears = scored.filter((y) => y.d === -1).sort((a, b) => a.x.relativeStrength - b.x.relativeStrength).map((y) => y.r);
  const out: FreshReference[] = scored.filter((y) => previous.has(y.r.id)).map((y) => y.r).slice(0, slots);
  for (let i = 0; out.length < slots && (i < bulls.length || i < bears.length); i++)
    for (const r of [bulls[i], bears[i]]) if (r && out.length < slots && !out.includes(r)) out.push(r);
  return out;
}

// ============================================================
// 2.0 INDEX INTEL — heavyweight breadth, the index future's price / OI read, chain OI samples
// ============================================================

/**
 * Approximate free-float weights (%) of each index's heavyweights, for breadth only: the share of this weight trading
 * above its own VWAP. Approximate and reviewed monthly; breadth needs 70% of the listed weight to have data.
 * MIDCPNIFTY and NIFTYNXT50 have no table (constituents not verified), so their breadth reads unavailable.
 */
export const FRESH_INDEX_HEAVYWEIGHTS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  NIFTY: { HDFCBANK: 13, ICICIBANK: 9, RELIANCE: 8.5, INFY: 5, BHARTIARTL: 4.5, LT: 4, ITC: 3.5, TCS: 3, SBIN: 3, AXISBANK: 3, KOTAKBANK: 2.7, 'M&M': 2.5, BAJFINANCE: 2.2, HINDUNILVR: 2, SUNPHARMA: 1.7 },
  SENSEX: { HDFCBANK: 15, ICICIBANK: 10, RELIANCE: 10, INFY: 6, BHARTIARTL: 5, LT: 4.5, ITC: 4, TCS: 3.8, SBIN: 3.3, AXISBANK: 3.2, KOTAKBANK: 3, 'M&M': 2.8, BAJFINANCE: 2.5, HINDUNILVR: 2.2, SUNPHARMA: 2 },
  BANKNIFTY: { HDFCBANK: 28, ICICIBANK: 25, SBIN: 9, KOTAKBANK: 8, AXISBANK: 8, INDUSINDBK: 3, FEDERALBNK: 3, BANKBARODA: 3, IDFCFIRSTB: 2.5, AUBANK: 2, PNB: 2, CANBK: 2 },
  BANKEX: { HDFCBANK: 28, ICICIBANK: 25, SBIN: 10, AXISBANK: 9, KOTAKBANK: 9, INDUSINDBK: 4, BANKBARODA: 3, FEDERALBNK: 3, IDFCFIRSTB: 2.5, AUBANK: 2 },
  FINNIFTY: { HDFCBANK: 30, ICICIBANK: 24, AXISBANK: 8, SBIN: 8, KOTAKBANK: 7, BAJFINANCE: 6, SHRIRAMFIN: 3, BAJAJFINSV: 3, HDFCLIFE: 2.5, SBILIFE: 2.5 },
});
export const FRESH_BREADTH_MIN_COVERAGE = 0.7;

/** Pure: the weight share of `index`'s heavyweights above their own VWAP in the scan, and the weight covered. */
export function freshIndexBreadth(scan: FreshScan | null, index: string): { breadth: number | null; coverage: number } {
  const weights = FRESH_INDEX_HEAVYWEIGHTS[index];
  if (!scan || !weights) return { breadth: null, coverage: 0 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0), bySymbol = new Map(scan.rows.map((r) => [r.symbol, r]));
  let covered = 0, above = 0;
  for (const [symbol, w] of Object.entries(weights)) {
    const r = bySymbol.get(symbol);
    if (!r || !(w > 0) || !(r.vwap! > 0) || !(r.price > 0)) continue;
    covered += w;
    if (r.price > r.vwap!) above += w;
  }
  const coverage = total > 0 ? covered / total : 0;
  return { breadth: coverage >= FRESH_BREADTH_MIN_COVERAGE && covered > 0 ? above / covered : null, coverage };
}

/** One sample of an index future: price and open interest at `at`. */
export interface FreshFuturesSample { at: number; price: number; oi: number }
export const FRESH_FUTURES_OI_WINDOW_MS = 30 * 60000;
/** The smallest OI change (fraction) read as positioning, rather than noise. */
export const FRESH_FUTURES_OI_MIN_CHANGE = 0.005;
/**
 * Pure: the index future's price / OI read over the last 30 minutes (samples at or before `now`, spanning >= 20 min):
 * price up + OI up = LONG_BUILDUP, down + up = SHORT_BUILDUP, up + down = SHORT_COVERING, down + down = LONG_UNWINDING,
 * an OI change under 0.5% = NEUTRAL; null without enough samples.
 */
export function freshFuturesOiRead(samples: readonly FreshFuturesSample[], now: number): string | null {
  const xs = samples.filter((x) => x.at <= now && now - x.at <= FRESH_FUTURES_OI_WINDOW_MS && x.oi > 0 && x.price > 0).sort((a, b) => a.at - b.at);
  if (xs.length < 2 || xs[xs.length - 1].at - xs[0].at < 20 * 60000) return null;
  const first = xs[0], last = xs[xs.length - 1], doi = (last.oi - first.oi) / first.oi, dp = last.price - first.price;
  if (Math.abs(doi) < FRESH_FUTURES_OI_MIN_CHANGE || dp === 0) return 'NEUTRAL';
  return dp > 0 ? (doi > 0 ? 'LONG_BUILDUP' : 'SHORT_COVERING') : (doi > 0 ? 'SHORT_BUILDUP' : 'LONG_UNWINDING');
}

/** Pure: the chain OI sample nearest to ~15 minutes before the latest one (within 12-20 min), or null. */
/** Old cached legs used zero for missing data, so only their positive readings are qualified. */
export function observedFreshOi(leg: { oi: number; observedOi?: number | null } | null | undefined): number | null {
  if (!leg) return null;
  const oi = leg.observedOi === undefined ? (leg.oi > 0 ? leg.oi : null) : leg.observedOi;
  return typeof oi === 'number' && Number.isFinite(oi) && oi >= 0 ? oi : null;
}

export function freshOiBefore(samples: readonly FreshOiSample[], latest: FreshOiSample): FreshOiSample | null {
  if (!latest.expiry) return null;
  const target = latest.at - 15 * 60000;
  return samples.filter((x) => x.expiry === latest.expiry && latest.at - x.at >= FRESH_IDX_OI_LOOKBACK_MS[0] && latest.at - x.at <= FRESH_IDX_OI_LOOKBACK_MS[1]).sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0] ?? null;
}

/** Pure: an index's intel as of `now` from the scan (breadth), its futures samples and its chain OI samples. */
export function freshIndexIntel(name: string, scan: FreshScan | null, futures: readonly FreshFuturesSample[], chains: readonly FreshOiSample[], now: number): FreshIndexIntel | null {
  const usable = chains.filter((x) => x.at <= now).sort((a, b) => a.at - b.at), oiNow = usable[usable.length - 1] ?? null;
  const { breadth, coverage } = freshIndexBreadth(scan && scan.at <= now && now - scan.at <= FRESH_INTEL_MAX_AGE_MS ? scan : null, name);
  const at = Math.min(scan && scan.at <= now ? scan.at : now, oiNow ? oiNow.at : now);
  return { at, breadth, breadthCoverage: Math.round(coverage * 1000) / 1000, futuresOi: freshFuturesOiRead(futures, now), oiNow, oiBefore: oiNow ? freshOiBefore(usable, oiNow) : null };
}
