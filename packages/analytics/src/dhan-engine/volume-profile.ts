// ============================================================
// VOLUME PROFILE (master prompt Part 7) — actual traded volume, one contract
// ============================================================
// Rows come from the contract's footprints (same price step). Every traded unit at a known price counts (aggressor
// side is irrelevant to a profile). Unreconciled volume has no price and is excluded; when any bar was INCOMPLETE the
// profile is INCOMPLETE (shown, but labelled).
// POC: the row with the most volume; ties -> the row nearest the middle of the range, then the lower.
// Value area: from the POC, add the larger adjacent row (ties -> the upper) until >= 70% of the volume.
// (Both are the existing order-flow valueArea rules, reused.)
// HVN / LVN: on 3-row smoothed volume, an HVN is a local maximum >= 1.5x the mean row; an LVN an interior local
// minimum <= 0.5x the mean row.
// Profiles are never merged across contracts, expiries or price steps: a mismatch is refused.
// ============================================================

import { valueArea, type FootprintBar } from '../order-flow/index.js';
import { DHAN_ENGINE_RULES, roundDp, rowOf, type EngineStatus } from './common.js';

export interface VolumeProfile {
  status: EngineStatus;
  reason: string | null;
  instrument: string | null;
  priceStep: number | null;
  rows: Array<{ price: number; volume: number }>;
  total: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  /** Share of volume inside [val, vah] (>= valueAreaFrac when available). */
  valueAreaShare: number | null;
  hvn: number[];
  lvn: number[];
  bars: number;
}

const empty = (reason: string, status: EngineStatus = 'UNAVAILABLE'): VolumeProfile => ({ status, reason, instrument: null, priceStep: null, rows: [], total: 0, poc: null, vah: null, val: null, valueAreaShare: null, hvn: [], lvn: [], bars: 0 });

export function profileFromRows(rowsIn: ReadonlyArray<{ price: number; volume: number }>, frac: number = DHAN_ENGINE_RULES.valueAreaFrac): Omit<VolumeProfile, 'status' | 'reason' | 'instrument' | 'priceStep' | 'bars'> {
  const rows = rowsIn.filter((r) => r.volume > 0).slice().sort((a, b) => a.price - b.price);
  const total = rows.reduce((a, r) => a + r.volume, 0);
  const va = valueArea(rows.map((r) => ({ price: r.price, total: r.volume })), frac);
  const inVa = va ? rows.filter((r) => r.price >= va.val && r.price <= va.vah).reduce((a, r) => a + r.volume, 0) : 0;
  const { hvn, lvn } = nodes(rows);
  return { rows, total, poc: va?.poc ?? null, vah: va?.vah ?? null, val: va?.val ?? null, valueAreaShare: va && total > 0 ? roundDp(inVa / total, 4) : null, hvn, lvn };
}

function nodes(rows: ReadonlyArray<{ price: number; volume: number }>): { hvn: number[]; lvn: number[] } {
  if (rows.length < 3) return { hvn: [], lvn: [] };
  const sm = rows.map((_, i) => {
    const w = rows.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, r) => a + r.volume, 0) / w.length;
  });
  const mean = rows.reduce((a, r) => a + r.volume, 0) / rows.length;
  const hvn: number[] = [], lvn: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const l = i > 0 ? sm[i - 1] : -Infinity, r = i < rows.length - 1 ? sm[i + 1] : -Infinity;
    if (sm[i] >= l && sm[i] >= r && (sm[i] > l || sm[i] > r) && sm[i] >= DHAN_ENGINE_RULES.hvnMult * mean) hvn.push(rows[i].price);
    if (i > 0 && i < rows.length - 1 && sm[i] <= sm[i - 1] && sm[i] <= sm[i + 1] && (sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) && sm[i] <= DHAN_ENGINE_RULES.lvnMult * mean) lvn.push(rows[i].price);
  }
  return { hvn, lvn };
}

/** Session (or developing, when passed the bars closed so far) profile of one contract's footprints. */
export function profileFromFootprints(fps: readonly FootprintBar[], frac: number = DHAN_ENGINE_RULES.valueAreaFrac): VolumeProfile {
  const used = fps.filter((f) => f.deltaMode !== 'UNAVAILABLE' && f.levels.length > 0);
  if (!used.length) return empty('NO_TRADES');
  const instruments = new Set(used.map((f) => f.sourceInstrument ?? null).filter((x) => x != null));
  if (instruments.size > 1) return empty('MIXED_CONTRACTS');
  const steps = new Set(used.map((f) => f.priceStep ?? null).filter((x): x is number => x != null));
  if (steps.size > 1) return empty('MIXED_PRICE_STEP');
  const step = steps.size ? [...steps][0] : null;
  const acc = new Map<number, number>();
  for (const f of used) for (const l of f.levels) {
    const p = step ? rowOf(l.price, step) : l.price;
    acc.set(p, (acc.get(p) ?? 0) + l.buy + l.sell + l.unclassified);
  }
  const prof = profileFromRows([...acc].map(([price, volume]) => ({ price, volume })), frac);
  const incomplete = used.some((f) => f.incomplete);
  // Exchange volume at observed trade prices; any unreconciled (price-less) volume makes the profile partial.
  const partial = used.some((f) => (f.unreconciledVolume ?? 0) > 0);
  return { status: incomplete ? 'INCOMPLETE' : partial ? 'ESTIMATED' : 'VERIFIED', reason: incomplete ? 'INCOMPLETE_BARS_INCLUDED' : partial ? 'UNRECONCILED_VOLUME_EXCLUDED' : null, instrument: instruments.size ? [...instruments][0] : null, priceStep: step, bars: used.length, ...prof };
}
