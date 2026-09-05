// ============================================================
// SECTOR STRENGTH RANKING
// ============================================================
// Ranks SECTOR_MAP's 11 sectors by relative strength, preferring the
// REAL sectoral index (NIFTYIT, NIFTYAUTO, ...) this app already has
// live quotes for over averaging each sector's own constituent stocks —
// NIFTYIT's own move today IS the standard definition of "how IT did,"
// not a same-day average of ~8 of its stocks recomputed here. Falls
// back to averaging member stocks (the original approach) only for
// sectors with no matching sectoral index (Telecom, and the untagged
// "Other" catch-all — see rankSectors below).
// ============================================================

import { SECTOR_MAP } from '@fno/shared';
import type { Exchange, FnoScannerRow, SectorRank } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { getLiveIndexQuotes } from './indices.js';

const MIN_SECTOR_MEMBERS = 2; // a 1-stock "sector" reading isn't a real sector signal
export const OTHER_SECTOR = 'Other';

// SECTOR_MAP sector name -> the real NSE sectoral index that best represents
// it. Telecom has no dedicated NSE sectoral index (NIFTYMEDIA is media, not
// telecom) so it stays on the stock-averaging fallback below.
const SECTOR_INDEX_MAP: Record<string, string> = {
  Banking: 'BANKNIFTY',
  IT: 'NIFTYIT',
  Auto: 'NIFTYAUTO',
  Pharma: 'NIFTYPHARMA',
  Metal: 'NIFTYMETAL',
  Energy: 'NIFTYENERGY',
  FMCG: 'NIFTYFMCG',
  Realty: 'NIFTYREALTY',
  'Financial Services': 'FINNIFTY',
  Infrastructure: 'NIFTYINFRA',
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function rankSectors(provider: MarketDataProvider, rows: FnoScannerRow[]): Promise<SectorRank[]> {
  const rowBySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const mappedSymbols = new Set(Object.values(SECTOR_MAP).flat());

  const indexSymbols = Array.from(new Set(['NIFTY', ...Object.values(SECTOR_INDEX_MAP)]));
  const indexQuotes = await getLiveIndexQuotes(
    provider,
    indexSymbols.map((symbol) => ({ symbol, exchange: 'NSE' as Exchange }))
  ).catch(() => []);
  const quoteBySymbol = new Map(indexQuotes.map((q) => [q.symbol, q]));
  const niftyChangePercent = quoteBySymbol.get('NIFTY')?.changePercent ?? 0;

  const ranks: SectorRank[] = [];
  for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
    const members = symbols
      .map((symbol) => rowBySymbol.get(symbol))
      .filter((r): r is FnoScannerRow => r != null);

    const indexSymbol = SECTOR_INDEX_MAP[sector];
    const indexQuote = indexSymbol ? quoteBySymbol.get(indexSymbol) : undefined;

    if (indexQuote) {
      // Real sectoral index vs NIFTY, same day — needs at least one liquid
      // member stock for the shortlist step to have anything to pick from,
      // even though the ranking itself doesn't depend on member count.
      if (members.length === 0) continue;
      ranks.push({
        sector,
        avgRelativeStrength: round2(indexQuote.changePercent - niftyChangePercent),
        memberCount: members.length,
        symbols: members.map((r) => r.symbol),
      });
      continue;
    }

    // Fallback: no sectoral index for this sector (Telecom) or its quote
    // wasn't available this tick — average member stocks' own relative
    // strength instead, the original approach.
    if (members.length < MIN_SECTOR_MEMBERS) continue;
    const avgRelativeStrength = members.reduce((sum, r) => sum + r.relativeStrength, 0) / members.length;
    ranks.push({
      sector,
      avgRelativeStrength: round2(avgRelativeStrength),
      memberCount: members.length,
      symbols: members.map((r) => r.symbol),
    });
  }

  // Untagged F&O stocks (SECTOR_MAP only covers ~90 of the ~180-200
  // universe) have no sectoral index by definition — always stock-averaged.
  const unmapped = rows.filter((r) => !mappedSymbols.has(r.symbol));
  if (unmapped.length >= MIN_SECTOR_MEMBERS) {
    const avgRelativeStrength = unmapped.reduce((sum, r) => sum + r.relativeStrength, 0) / unmapped.length;
    ranks.push({
      sector: OTHER_SECTOR,
      avgRelativeStrength: round2(avgRelativeStrength),
      memberCount: unmapped.length,
      symbols: unmapped.map((r) => r.symbol),
    });
  }

  ranks.sort((a, b) => b.avgRelativeStrength - a.avgRelativeStrength);
  return ranks;
}
