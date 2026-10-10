// ============================================================
// F&O EXPLORER — the filters and derived lists of the three views it replaces
// ============================================================
// F&O Stocks, OI Intelligence and IV & Greeks were three pages over ONE dataset
// (the F&O scan). Each had its own filters and derived lists; this keeps every one
// of them, unchanged in meaning, as view presets of a single page.
// ============================================================

import { LIQUID_SPREAD_MAX_PCT } from '@fno/shared';
import type { BiasDirection, FnoScannerRow, OIInterpretation } from '@fno/shared';
import type { ExplorerView } from './nav';

export type BiasFilter = 'ALL' | BiasDirection;
export type ActivityFilter = 'ALL' | OIInterpretation;
export type IvRankFilter = 'ALL' | 'HIGH' | 'LOW';

export interface ExplorerFilters {
  query: string;
  bias: BiasFilter;
  /** Used by the F&O Stocks and OI views. */
  activity: ActivityFilter;
  /** F&O Stocks view only: ATM spread within the liquidity gate (no spread data is not "liquid"). */
  liquidOnly: boolean;
  /** IV & Greeks view only. */
  ivRank: IvRankFilter;
}

export const DEFAULT_EXPLORER_FILTERS: ExplorerFilters = { query: '', bias: 'ALL', activity: 'ALL', liquidOnly: false, ivRank: 'ALL' };

/** Which filters each view offers (the others are ignored, exactly as the separate pages did). */
export const VIEW_FILTERS: Record<ExplorerView, ReadonlyArray<keyof ExplorerFilters>> = {
  overview: ['query', 'bias', 'activity', 'liquidOnly'],
  oi: ['query', 'bias', 'activity'],
  iv: ['query', 'bias', 'ivRank'],
};

export function filterExplorerRows(rows: readonly FnoScannerRow[], view: ExplorerView, f: ExplorerFilters): FnoScannerRow[] {
  const q = f.query.trim().toUpperCase();
  const active = new Set(VIEW_FILTERS[view]);
  return rows.filter((r) => {
    if (q && !r.symbol.includes(q)) return false;
    if (active.has('bias') && f.bias !== 'ALL' && r.direction !== f.bias) return false;
    if (active.has('activity') && f.activity !== 'ALL' && r.oiInterpretation !== f.activity) return false;
    // No spread data this tick reads as "cannot confirm it is liquid", the same as an actually wide spread.
    if (active.has('liquidOnly') && f.liquidOnly && !(r.atmSpreadPct != null && r.atmSpreadPct <= LIQUID_SPREAD_MAX_PCT)) return false;
    if (active.has('ivRank') && f.ivRank === 'HIGH' && !(r.ivRank != null && r.ivRank >= 70)) return false;
    if (active.has('ivRank') && f.ivRank === 'LOW' && !(r.ivRank != null && r.ivRank <= 30)) return false;
    return true;
  });
}

/** The default sort of each view (the page it replaces). */
export const DEFAULT_SORT: Record<ExplorerView, { id: string; dir: 'asc' | 'desc' }> = {
  overview: { id: 'score', dir: 'desc' },
  oi: { id: 'oiPct', dir: 'desc' },
  iv: { id: 'ivRank', dir: 'desc' },
};

/** The four OI activity lists of the OI view: the top 8 of each build-up type, ranked as the original page did. */
export function oiActivityLists(rows: readonly FnoScannerRow[]) {
  const top = (type: OIInterpretation, desc: boolean) =>
    rows
      .filter((s) => s.oiInterpretation === type)
      .sort((a, b) => (desc ? b.futuresChangeOiPercent - a.futuresChangeOiPercent : a.futuresChangeOiPercent - b.futuresChangeOiPercent))
      .slice(0, 8);
  return {
    longBuildup: top('LONG_BUILDUP', true),
    shortBuildup: top('SHORT_BUILDUP', true),
    shortCovering: top('SHORT_COVERING', false),
    longUnwinding: top('LONG_UNWINDING', false),
  };
}

/** The ten symbols with the largest OI% swing, whichever the direction (the 🔥 flag of the OI view). */
export function unusualOiSymbols(rows: readonly FnoScannerRow[]): Set<string> {
  return new Set([...rows].sort((a, b) => Math.abs(b.futuresChangeOiPercent) - Math.abs(a.futuresChangeOiPercent)).slice(0, 10).map((r) => r.symbol));
}
