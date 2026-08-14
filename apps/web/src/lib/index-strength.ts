// ============================================================
// INDEX STRENGTH
// ============================================================
// A 0-100 price-action strength score computable from a single
// live quote (no historical candles, no OI) — most of the 34
// indices this terminal tracks have no F&O contracts of their own
// (sectoral/MCX benchmark indices), so OI-based bias doesn't apply
// universally the way it does for F&O stocks. Blends today's %
// change against a typical daily-move scale with where the index
// sits in its own day range (closing near the high = strong).
// ============================================================

export function computeIndexStrength(input: { changePercent: number; ltp: number; high: number; low: number }): number {
  const { changePercent, ltp, high, low } = input;

  const positionInRange = high > low ? ((ltp - low) / (high - low)) * 100 : 50;

  // Typical index daily moves rarely exceed ~3% — clamp to that scale
  // rather than a raw percentage so the score doesn't bottom/top out
  // on ordinary days.
  const clampedChange = Math.max(-3, Math.min(3, changePercent));
  const changeComponent = 50 + (clampedChange / 3) * 50;

  const strength = 0.5 * positionInRange + 0.5 * changeComponent;
  return Math.round(Math.max(0, Math.min(100, strength)));
}
