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
    // An empty scan (rows.length === 0, so advances === declines === 0)
    // isn't a real tie — it's no data at all. `advances >= declines` used
    // to default that case to `true`, which silently forced a bullish
    // read and could veto an otherwise-unanimous bearish call elsewhere
    // (Market Scanner's assessMarketTrend) whenever a scan tick came back
    // empty. Null makes "no data" distinguishable from an actual reading.
    isBullishBias: rows.length === 0 ? null : advances >= declines,
  };
}
