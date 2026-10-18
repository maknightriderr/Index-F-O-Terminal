// ============================================================
// COST-1 (audit 2026-10-18): COST-3.0 — dated statutory and exchange charges per exchange, in the builder, the
// setup_events measurement and the per-trade cost record (one flat 0.2% for every exchange before).
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTION_CHARGES, TRADING_COST_MODEL, optionChargesFor, optionStatutoryParts, optionStatutoryPct } from '@fno/shared';
import { estimateRoundTripCost } from '@fno/analytics';
import { measureSetupCost } from '../setup-cost.js';
import { buildCostRecord } from '../trade-costs.js';
import { COST_VERSION } from '../../config/trading-flags.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f: string) => readFileSync(path.join(SRC, f), 'utf8');
const ist = (d: string, t = '10:00') => Date.parse(`${d}T${t}:00+05:30`);
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('the dated charge table', () => {
  it('NSE and BSE options: STT on the sell premium 0.10% to 31 Mar 2026, 0.15% from 1 Apr 2026 (IST)', () => {
    expect(optionChargesFor('NSE', ist('2026-03-31', '23:59'))?.sellTaxPct).toBe(0.1);
    expect(optionChargesFor('NSE', ist('2026-04-01', '00:00'))?.sellTaxPct).toBe(0.15);
    expect(optionChargesFor('BSE', ist('2026-10-16'))?.sellTaxPct).toBe(0.15);
    expect(optionChargesFor('MCX', ist('2026-10-16'))?.sellTaxPct).toBe(0.05);
    // Before the table starts: its first schedule; an unknown exchange: none.
    expect(optionChargesFor('NSE', ist('2024-01-01'))).toEqual(OPTION_CHARGES.NSE[0]);
    expect(optionChargesFor('NYSE', ist('2026-10-16'))).toBeNull();
  });
  it('round-trip parts, % of the entry premium (both legs at the entry premium)', () => {
    const nse = optionStatutoryParts('NSE', ist('2026-10-16'))!;
    near(nse.sellTax, 0.15);
    near(nse.exchangeTxn, 2 * 0.03553);
    near(nse.sebi, 2 * 0.0001);
    near(nse.stamp, 0.003);
    near(nse.gstOnFees, 0.18 * (2 * 0.03553 + 2 * 0.0001));
    near(nse.total, nse.sellTax + nse.exchangeTxn + nse.sebi + nse.stamp + nse.gstOnFees);
    expect(+optionStatutoryPct('NSE', ist('2026-10-16')).toFixed(4)).toBe(0.2371);
    expect(+optionStatutoryPct('BSE', ist('2026-10-16')).toFixed(4)).toBe(0.2299);
    expect(+optionStatutoryPct('MCX', ist('2026-10-16')).toFixed(4)).toBe(0.1519);
    expect(+optionStatutoryPct('NSE', ist('2026-03-31')).toFixed(4)).toBe(0.1871);
    expect(optionStatutoryPct('NYSE', ist('2026-10-16'))).toBe(TRADING_COST_MODEL.statutoryPct);
  });
});

describe('the builder charges it; the default stays COST-2.0 (golden snapshots, research, backtests)', () => {
  it('estimateRoundTripCost moves by exactly entry x the statutory difference', () => {
    const base = estimateRoundTripCost(200, 199, 201, 75);
    const mcx = estimateRoundTripCost(200, 199, 201, 75, optionStatutoryPct('MCX', ist('2026-10-16')));
    near(mcx.perUnit - base.perUnit, 200 * ((optionStatutoryPct('MCX', ist('2026-10-16')) - 0.2) / 100));
    expect(estimateRoundTripCost(200, 199, 201, 75, TRADING_COST_MODEL.statutoryPct)).toEqual(base);
  });
  it('every live build context and cost measurement passes the exchange rate', () => {
    const mb = read('services/market-bias.ts');
    expect(mb.match(/statutoryPct: optionStatutoryPct\(exchange, decisionNow\(\)\),/g)?.length).toBe(5);
    expect(mb.match(/realisticPayoff: \{ sessionHours: sessionHoursFor\(exchange\) \},/g)?.length).toBe(5);
    expect(mb).toMatch(/costVersion: COST_VERSION, statutoryPct: optionStatutoryPct\(chain\.exchange, decisionNow\(\)\) \}/);
    expect(mb).toMatch(/const statutoryPct = optionStatutoryPct\(chain\.exchange, decisionNow\(\)\);/);
    expect(read('services/trigger-router.ts')).toMatch(/statutoryPct: optionStatutoryPct\(chain\.exchange, chain\.timestamp\)/);
    expect(read('services/of1-live.ts')).toMatch(/statutoryPct: optionStatutoryPct\(chain\.exchange, chain\.timestamp\)/);
    expect(read('services/trade-costs.ts')).toMatch(/costRecordForSetup\(args\.setup, args\.chain, \{ exchange: args\.exchange, at: args\.mintedAt \}\)/);
    expect(COST_VERSION).toBe('COST-3.0');
  });
});

describe('measurement agrees with the builder', () => {
  const at = ist('2026-10-16');
  it('setup_events cost: charges move by premium x the statutory difference', () => {
    const option = { side: 'CE' as const, strike: 25000, expiry: '2026-10-21', strikeBasis: 'TRADED' as const, premium: 120, bid: 119.5, ask: 120.5, delta: 0.5, lotSize: 65 };
    const old = measureSetupCost({ entry: 25000, stop: 24950, t1: 25100, atr: 40, option, costVersion: 'COST-2.0' });
    const now = measureSetupCost({ entry: 25000, stop: 24950, t1: 25100, atr: 40, option, costVersion: COST_VERSION, statutoryPct: optionStatutoryPct('NSE', at) });
    expect(now.perUnit!.charges - old.perUnit!.charges).toBeCloseTo(120 * ((optionStatutoryPct('NSE', at) - 0.2) / 100), 4);
  });
  it('the per-trade record lists the parts, they sum to the statutory charge, and it reconciles with the builder', () => {
    const entry = 2000;
    const built = estimateRoundTripCost(entry, 1990, 2010, 100, optionStatutoryPct('MCX', at));
    const rec = buildCostRecord({ entry, stopLoss: 1600, target: 2400, bid: 1990, ask: 2010, lotSize: 100, setupEstimatedCostPct: Math.round(built.pct * 100) / 100, exchange: 'MCX', at })!;
    expect(rec.version).toBe('COST-1.1');
    expect(rec.statutoryParts).toMatchObject({ exchange: 'MCX', effectiveFrom: '2024-10-01' });
    const p = rec.statutoryParts!;
    expect(p.sellTax.perUnit + p.exchangeTxn.perUnit + p.sebi.perUnit + p.stamp.perUnit + p.gstOnFees.perUnit).toBeCloseTo(rec.statutory.perUnit, 3);
    expect(rec.statutory.assumedPct).toBeCloseTo(optionStatutoryPct('MCX', at), 4);
    expect(rec.reconciliation.matchesSetup).toBe(true);
    // Without an exchange: COST-2.0's flat rate, no parts.
    const flat = buildCostRecord({ entry, stopLoss: 1600, target: 2400, bid: 1990, ask: 2010, lotSize: 100 })!;
    expect(flat.statutory.assumedPct).toBe(TRADING_COST_MODEL.statutoryPct);
    expect(flat.statutoryParts).toBeNull();
  });
});
