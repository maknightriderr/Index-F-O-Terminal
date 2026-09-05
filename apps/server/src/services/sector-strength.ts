// ============================================================
// SECTOR STRENGTH RANKING
// ============================================================
// Ranks SECTOR_MAP's 11 sectors by average relative strength (today's
// changePercent vs NIFTY's own — already computed per-stock by
// fno-scanner.ts), so the Market Scanner can pick "the strongest
// sector" / "the weakest sector" instead of scanning the whole ~180-
// stock F&O universe stock-by-stock with no market-structure context.
// ============================================================

import { SECTOR_MAP } from '@fno/shared';
import type { FnoScannerRow, SectorRank } from '@fno/shared';

const MIN_SECTOR_MEMBERS = 2; // a 1-stock "sector" reading isn't a real sector signal

export function rankSectors(rows: FnoScannerRow[]): SectorRank[] {
  const rowBySymbol = new Map(rows.map((r) => [r.symbol, r]));

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

  ranks.sort((a, b) => b.avgRelativeStrength - a.avgRelativeStrength);
  return ranks;
}
