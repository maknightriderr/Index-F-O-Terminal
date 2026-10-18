// ============================================================
// COST-1 (audit 2026-10-18): lotSize is the P&L multiplier of one lot. Angel One's master gives MCX GOLD 1 (a 1 kg
// lot) and GOLDM 100 (a 100 g lot), both quoted per 10 g: Rs 100 and Rs 10 per Rs 1 of premium.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRoundTripCost } from '@fno/analytics';
import { MCX_UNITS_PER_LOT_OVERRIDE, unitsPerLot } from '../../providers/angel-one/lot-size.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('units per lot', () => {
  it('MCX GOLD and GOLDM use their contract multipliers; everything else keeps the master value', () => {
    expect(unitsPerLot('MCX', 'GOLD', 1)).toEqual({ lotSize: 100, source: 'OVERRIDE' });
    expect(unitsPerLot('MCX', 'GOLDM', 100)).toEqual({ lotSize: 10, source: 'OVERRIDE' });
    // Rows from the 18 Oct master that already match the exchange multiplier.
    expect(unitsPerLot('MCX', 'CRUDEOIL', 100).lotSize).toBe(100);
    expect(unitsPerLot('MCX', 'SILVER', 30).lotSize).toBe(30);
    expect(unitsPerLot('MCX', 'NATURALGAS', 1250).lotSize).toBe(1250);
    expect(unitsPerLot('NSE', 'NIFTY', 65).lotSize).toBe(65);
    expect(unitsPerLot('BSE', 'SENSEX', 20).lotSize).toBe(20);
    // Only on MCX: an NSE name that happens to be GOLD-like is not touched.
    expect(unitsPerLot('NSE', 'GOLD', 1).lotSize).toBe(1);
    expect(Object.keys(MCX_UNITS_PER_LOT_OVERRIDE).sort()).toEqual(['GOLD', 'GOLDM']);
  });
  it('a missing lot size is 1 (conservative cost), flagged MISSING', () => {
    expect(unitsPerLot('NSE', 'X', NaN)).toEqual({ lotSize: 1, source: 'MISSING' });
    expect(unitsPerLot('NSE', 'X', 0)).toEqual({ lotSize: 1, source: 'MISSING' });
  });
  it('what it fixes: a GOLD option at Rs 2,860 premium carried ~1.65 points of bogus brokerage share', () => {
    const before = estimateRoundTripCost(2860, 2855, 2865, 1).pct;
    const after = estimateRoundTripCost(2860, 2855, 2865, 100).pct;
    expect(before - after).toBeGreaterThan(1.6);
    expect(before - after).toBeLessThan(1.7);
  });
  it('the provider maps every instrument through it', () => {
    const src = readFileSync(path.join(SRC, 'providers/angel-one/index.ts'), 'utf8');
    expect(src).toMatch(/lotSize: unitsPerLot\(exchange, raw\.name, parseInt\(raw\.lotsize\)\)\.lotSize,/);
    expect(src).not.toMatch(/lotSize: parseInt\(raw\.lotsize\) \|\| 1/);
  });
});
