// ============================================================
// UNITS PER LOT (audit 2026-10-18, COST-1)
// ============================================================
// The terminal's `lotSize` is the P&L multiplier of one lot: rupees per rupee
// of premium. Every cost share (brokerage per unit) and rupee figure divides
// or multiplies by it. Angel One's scrip master gives the exchange's QUANTITY
// unit instead, which on MCX is not always the same thing:
//
//   GOLD   master lotsize 1   (a 1 kg lot)   quoted per 10 g -> Rs 100 per Rs 1
//   GOLDM  master lotsize 100 (a 100 g lot)  quoted per 10 g -> Rs 10 per Rs 1
//
// (MCX contract specifications. CRUDEOIL 100, SILVER 30, NATURALGAS 1250 and
// the NSE / BSE contracts already match.) With lotSize 1, GOLD's estimated
// cost carried the whole round-trip brokerage on one unit of premium: about
// +1.7 points of premium per trade (3.67% average vs 1.93% corrected, 69
// trades since 5 Oct) and 54 of 59 COST_TOO_HIGH refusals.
// Pure.
// ============================================================

export const MCX_UNITS_PER_LOT_OVERRIDE: Readonly<Record<string, number>> = Object.freeze({ GOLD: 100, GOLDM: 10 });

/** The P&L multiplier per lot: the MCX override for GOLD / GOLDM, else the master's lot size (1 when it is missing). */
export function unitsPerLot(exchange: string, name: string | null | undefined, masterLotSize: number): { lotSize: number; source: 'OVERRIDE' | 'MASTER' | 'MISSING' } {
  const override = exchange === 'MCX' && name ? MCX_UNITS_PER_LOT_OVERRIDE[name] : undefined;
  if (override != null) return { lotSize: override, source: 'OVERRIDE' };
  if (Number.isFinite(masterLotSize) && masterLotSize > 0) return { lotSize: masterLotSize, source: 'MASTER' };
  return { lotSize: 1, source: 'MISSING' };
}
