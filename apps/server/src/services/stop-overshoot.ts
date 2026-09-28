// ============================================================
// STOP OVERSHOOT — measurement only (validation review, fix 3)
// ============================================================
// A stop gapped through already records the observed LTP as the exit
// (exitValueForPriceHit in market-bias.ts): a stop-market order fills where
// the market is, so that is the honest paper fill and nothing here changes it.
// This only measures HOW FAR past the stop a losing exit filled, so the −1R
// average loser can be split into gap-through and costs.
//
//   stopOvershootPct = (stopLoss − exitPrice) / entry
//
// A FRACTION of the entry premium (0.05 = five percent of entry), matching
// how the premium stop percentages are held (e.g. 0.3 for a 30% stop).
// Positive = filled below the stop; 0 = filled exactly at it.
// ============================================================

export function stopOvershootPct(
  stored: { entry?: number | null; stopLoss?: number | null },
  exitPrice: number | null
): number | null {
  if (exitPrice == null || stored.entry == null || !(stored.entry > 0) || stored.stopLoss == null) return null;
  return Math.round(((stored.stopLoss - exitPrice) / stored.entry) * 10000) / 10000;
}
