// ============================================================
// SECTOR STRENGTH RANKING
// ============================================================
// Ranks SECTOR_MAP's 11 sectors by average relative strength (today's
// changePercent vs NIFTY's own — already computed per-stock by
// fno-scanner.ts), so the Market Scanner can pick "the strongest
// sector" / "the weakest sector" instead of scanning the whole ~180-
// stock F&O universe stock-by-stock with no market-structure context.
//
// SECTOR_MAP only tags ~90 of the ~180-200 F&O universe into its 11
// named sectors — everything else (the OTHER_SECTOR bucket below) would
// otherwise never be eligible as a scanner candidate at all, no matter
// how strong its own move. Grouping the untagged remainder into one
// catch-all sector keeps every F&O stock reachable without pretending
// to know its real sector classification.
// ============================================================

import { SECTOR_MAP } from '@fno/shared';
import type { FnoScannerRow, SectorRank } from '@fno/shared';

const MIN_SECTOR_MEMBERS = 2; // a 1-stock "sector" reading isn't a real sector signal
export const OTHER_SECTOR = 'Other';

export function rankSectors(rows: FnoScannerRow[]): SectorRank[] {
  const rowBySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const mappedSymbols = new Set(Object.values(SECTOR_MAP).flat());

  const ranks: SectorRank[] = [];
  for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
    const members = symbols
      .map((symbol) => rowBySymbol.get(symbol))
      .filter((r): r is FnoScannerRow => r != null);

    if (members.length < MIN_SECTOR_MEMBERS) continue;

    const avgRelativeStrength = members.reduce((sum, r) => sum + r.relativeStrength, 0) / members.length;

    ranks.push({
      sector,
      avgRelativeStrength: Math.round(avgRelativeStrength * 100) / 100,
      memberCount: members.length,
      symbols: members.map((r) => r.symbol),
    });
  }

  const unmapped = rows.filter((r) => !mappedSymbols.has(r.symbol));
  if (unmapped.length >= MIN_SECTOR_MEMBERS) {
    const avgRelativeStrength = unmapped.reduce((sum, r) => sum + r.relativeStrength, 0) / unmapped.length;
    ranks.push({
      sector: OTHER_SECTOR,
      avgRelativeStrength: Math.round(avgRelativeStrength * 100) / 100,
      memberCount: unmapped.length,
      symbols: unmapped.map((r) => r.symbol),
    });
  }

  ranks.sort((a, b) => b.avgRelativeStrength - a.avgRelativeStrength);
  return ranks;
}
