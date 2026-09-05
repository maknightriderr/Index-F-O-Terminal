// ============================================================
// MARKET BREADTH
// ============================================================
// Advance/decline read across the F&O universe — same formula the
// Dashboard already computes inline on the frontend (advances vs
// declines vs unchanged by today's changePercent), pulled out here so
// the Market Scanner can use it server-side without duplicating it.
// ============================================================

import type { FnoScannerRow, MarketBreadth } from '@fno/shared';

export function computeMarketBreadth(rows: FnoScannerRow[]): MarketBreadth {
  const advances = rows.filter((r) => r.changePercent > 0).length;
  const declines = rows.filter((r) => r.changePercent < 0).length;
  const unchanged = rows.filter((r) => r.changePercent === 0).length;
  const total = rows.length || 1;
  const advPercent = Math.round((advances / total) * 100);
  const decPercent = Math.round((declines / total) * 100);
  const unchPercent = Math.max(0, 100 - advPercent - decPercent);

  return {
    advances,
    declines,
    unchanged,
    total: rows.length,
    advPercent,
    decPercent,
    unchPercent,
    isBullishBias: advances >= declines,
  };
}
