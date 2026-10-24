// NSE strategy levels stay in spot space. Translate each futures footprint
// using its MATCHING closed candle basis, never a current quote or another
// bar's basis. This is a bar-level estimate, not tick-exact alignment.
import { unavailableFootprint, type FootprintBar } from './index.js';
import type { Of1Bar } from './of1.js';

export const FLOW_ALIGNMENT_VERSION = 'FLOW-ALIGN-1.0';
const BAR_MS = 15 * 60_000;
const positive = (n: number) => Number.isFinite(n) && n > 0;
function validBar(b: Of1Bar): boolean {
  return Number.isFinite(b.time) && [b.open, b.high, b.low, b.close].every(positive)
    && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close);
}

export interface FlowAlignmentContract {
  instrument: string;
  expiry: string;
}

/** The caller verifies exchange, underlying and expiry across providers first. */
export function alignFootprintsToReference(
  bars: readonly Of1Bar[],
  raw: ReadonlyMap<number, FootprintBar>,
  futuresBars: readonly Of1Bar[],
  contract: FlowAlignmentContract | null,
  reference: 'SPOT' | 'FUTURES',
  at: number
): Map<number, FootprintBar> {
  const out = new Map<number, FootprintBar>();
  const futures = new Map<number, Of1Bar>();
  const duplicates = new Set<number>();
  for (const b of futuresBars) {
    if (futures.has(b.time)) duplicates.add(b.time);
    futures.set(b.time, b);
  }
  for (const b of bars) {
    const fp = raw.get(b.time);
    if (!fp) continue;
    const reject = (reason: string) => out.set(b.time, {
      ...unavailableFootprint(b.time, BAR_MS), sourceInstrument: fp.sourceInstrument,
      priceAlignment: { status: 'UNAVAILABLE', reason },
    });
    if (!contract?.instrument || !/^\d{4}-\d{2}-\d{2}$/.test(contract.expiry)) { reject('CONTRACT_UNVERIFIED'); continue; }
    if (fp.sourceInstrument !== contract.instrument) { reject('CONTRACT_MISMATCH'); continue; }
    if (fp.priceAlignment) { reject('ALREADY_ALIGNED'); continue; }
    if (!Number.isFinite(at) || !validBar(b) || b.time + BAR_MS > at || fp.barTime !== b.time || fp.barMs !== BAR_MS) { reject('INVALID_OR_UNCLOSED_REFERENCE_BAR'); continue; }
    if (fp.deltaMode === 'UNAVAILABLE') { reject('FLOW_UNAVAILABLE'); continue; }
    if (!(fp.volume != null && positive(fp.volume)) || !fp.levels.length || fp.levels.some(l =>
      !positive(l.price) || [l.buy, l.sell, l.unclassified].some(v => !Number.isFinite(v) || v < 0))) { reject('INVALID_FOOTPRINT'); continue; }
    const f = reference === 'FUTURES' ? b : futures.get(b.time);
    if (!f || !validBar(f) || duplicates.has(b.time)) { reject('MATCHING_FUTURES_BAR_UNAVAILABLE'); continue; }
    const basis = reference === 'FUTURES' ? 0 : f.close - b.close;
    const shift = (p: number | null): number | null => p == null ? null : p - basis;
    const levels = fp.levels.map(l => ({ ...l, price: l.price - basis }));
    const prices = [fp.poc, fp.vah, fp.val, fp.high, fp.low, fp.close].map(shift);
    if (!Number.isFinite(basis) || levels.some(l => !positive(l.price)) || prices.some(p => p != null && !positive(p))) { reject('INVALID_ALIGNED_PRICE'); continue; }
    out.set(b.time, {
      ...fp, levels, poc: prices[0], vah: prices[1], val: prices[2], high: prices[3], low: prices[4], close: prices[5],
      priceAlignment: { status: 'ALIGNED', reference, method: reference === 'FUTURES' ? 'SAME_CONTRACT' : 'BAR_CLOSE_BASIS_ESTIMATE',
        basis, barTime: b.time, instrument: contract.instrument, expiry: contract.expiry, referenceClose: b.close, futuresClose: f.close },
    });
  }
  return out;
}
