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
import { FRESH_INTEL_MAX_AGE_MS, FRESH_RS_MIN_PCT, FRESH_RS_MAX_SPREAD_PCT, FRESH_RS_MAX_IV_RANK, FRESH_RS_SECTOR_TOLERANCE_PCT, type FreshStockIntel } from '@fno/analytics';
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
  if (!scan) return null;
  const symbols = freshRefSymbols(ref), row = scan.rows.find((r) => symbols.includes(r.symbol));
  const at = row && Number.isFinite(row.timestamp) ? Math.min(row.timestamp, scan.at) : scan.at;
  if (!row || !Number.isFinite(row.relativeStrength) || !(at <= now) || now - at > FRESH_INTEL_MAX_AGE_MS) return null;
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
