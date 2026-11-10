// ============================================================
// EXPIRY GAMMA MODULE (owner's definition, 7 Nov) — separate from setups A–D, tagged DHAN_EXPIRY_GAMMA, SHADOW
// ============================================================
// "OI short-covering / gamma blast", index expiry day, PM session:
//   Midday build: ATM OI as of the midday lull (the last chain sample in 11:30–13:15 IST) is the baseline.
//   Bullish gamma squeeze: spot tests the day's high (or R1) while ATM call OI falls (call writers unwinding) and
//     ATM put OI rises (put writing), and the intraday PCR (ATM ± 2 strikes) rises sharply (>= +0.10, research value).
//   Bearish flush: spot breaks the day's low, or trades below VWAP, while ATM put OI falls (put writers exit).
//   Entries 13:30–15:00 IST only; any position is force-closed at 15:15 (theta on expiry afternoons).
//   Strikes: ATM or 1 strike ITM (delta >= 0.55, checked in phase 4 against live Greeks); never deep OTM.
// The rules are recorded exactly as defined; the pin (spot within a quarter strike of the largest-OI strike) is
// recorded as evidence only, never as a gate. Index spot has no traded volume, so "VWAP" is the index FUTURES'
// trade-based session VWAP against the futures price (labelled).
// ============================================================

import type { Side } from './common.js';

export const DHAN_GAMMA_ID = 'DHAN_EXPIRY_GAMMA';
export const DHAN_GAMMA_VERSION = 'DHAN-GAMMA-1.1';

export const DHAN_GAMMA_RULES = Object.freeze({
  baselineFrom: 11 * 60 + 30,
  baselineTo: 13 * 60 + 15,
  entryFrom: 13 * 60 + 30,
  entryTo: 15 * 60,
  forcedExit: 15 * 60 + 15,
  pcrStrikes: 2,
  pcrJump: 0.1,
  /** "Tests the day's high": within 0.05% of it (or above). */
  testTolerance: 0.0005,
  maxSampleAgeMs: 5 * 60_000,
  pinFraction: 0.25,
});

export interface GammaStrike { strike: number; callOi: number | null; putOi: number | null }
export interface GammaSample { at: number; spot: number; strikes: GammaStrike[] }

export interface GammaInput {
  index: string;
  expiryToday: boolean;
  now: number;
  /** Today's chain samples, any order. */
  samples: GammaSample[];
  /** Spot day high / low before the latest sample (from closed bars). */
  dayHigh: number | null;
  dayLow: number | null;
  r1: number | null;
  futuresPrice: number | null;
  futuresVwap: number | null;
  strikeStep: number;
}

export interface GammaResult {
  strategy: typeof DHAN_GAMMA_ID;
  side: Side;
  status: 'SIGNAL' | 'NO_SETUP';
  failed: string | null;
  checks: Array<{ id: string; ok: boolean; value?: unknown }>;
  evidence: Record<string, unknown>;
  strikes: { atm: number; itm: number; right: 'CE' | 'PE' } | null;
  forcedExitAt: number | null;
}

const istMin = (t: number) => { const d = new Date(t + 19_800_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
/** The epoch ms of an IST minute-of-day on the same IST day as `t`. */
const atIst = (t: number, min: number) => { const day = Math.floor((t + 19_800_000) / 86_400_000) * 86_400_000; return day - 19_800_000 + min * 60_000; };

export function pivotR1(prev: { high: number; low: number; close: number } | null): number | null {
  if (!prev) return null;
  const p = (prev.high + prev.low + prev.close) / 3;
  return Math.round((2 * p - prev.low) * 100) / 100;
}

const knownOi = (oi: number | null | undefined): oi is number =>
  typeof oi === 'number' && Number.isFinite(oi) && oi >= 0;

function pcr(s: GammaSample, atm: number, step: number, n: number): number | null {
  if (!(step > 0)) return null;
  let calls = 0, puts = 0;
  for (let k = -n; k <= n; k++) {
    const row = s.strikes.find((x) => Math.abs(x.strike - (atm + k * step)) <= 1e-9);
    if (!knownOi(row?.callOi) || !knownOi(row?.putOi)) return null;
    calls += row.callOi;
    puts += row.putOi;
  }
  return calls > 0 ? puts / calls : null;
}

export function evaluateExpiryGamma(x: GammaInput): GammaResult[] {
  const R = DHAN_GAMMA_RULES;
  const ss = x.samples.filter((s) => s.at <= x.now && s.spot > 0 && s.strikes.length).sort((a, b) => a.at - b.at);
  const latest = ss.at(-1) ?? null;
  const base = ss.filter((s) => istMin(s.at) >= R.baselineFrom && istMin(s.at) <= R.baselineTo).at(-1) ?? null;
  const atm = latest ? latest.strikes.reduce((a, s) => (Math.abs(s.strike - latest.spot) < Math.abs(a.strike - latest.spot) ? s : a)).strike : null;
  const nowAtm = latest && atm != null ? latest.strikes.find((s) => s.strike === atm) ?? null : null;
  const baseAtm = base && atm != null ? base.strikes.find((s) => s.strike === atm) ?? null : null;
  const dCe = knownOi(nowAtm?.callOi) && knownOi(baseAtm?.callOi) ? nowAtm.callOi - baseAtm.callOi : null;
  const dPe = knownOi(nowAtm?.putOi) && knownOi(baseAtm?.putOi) ? nowAtm.putOi - baseAtm.putOi : null;
  const pcrNow = latest && atm != null ? pcr(latest, atm, x.strikeStep, R.pcrStrikes) : null;
  const pcrBase = base && atm != null ? pcr(base, atm, x.strikeStep, R.pcrStrikes) : null;
  const maxOi = latest?.strikes.flatMap((s) => knownOi(s.callOi) && knownOi(s.putOi)
    ? [{ strike: s.strike, total: s.callOi + s.putOi }] : []).sort((a, b) => b.total - a.total)[0] ?? null;
  const evidence = {
    atm, spot: latest?.spot ?? null, sampleAt: latest?.at ?? null, baselineAt: base?.at ?? null, dCallOi: dCe, dPutOi: dPe,
    pcrBase: pcrBase == null ? null : Math.round(pcrBase * 1000) / 1000, pcrNow: pcrNow == null ? null : Math.round(pcrNow * 1000) / 1000,
    dayHigh: x.dayHigh, dayLow: x.dayLow, r1: x.r1, futuresPrice: x.futuresPrice, futuresVwap: x.futuresVwap, vwapSource: 'FUTURES_TRADE_VWAP',
    maxOiStrike: maxOi?.strike ?? null, pinned: maxOi && latest ? Math.abs(latest.spot - maxOi.strike) <= R.pinFraction * x.strikeStep : null,
  };
  const common: Array<[string, () => unknown]> = [
    ['G0_EXPIRY_DAY', () => x.expiryToday || null],
    ['G1_ENTRY_WINDOW', () => istMin(x.now) >= R.entryFrom && istMin(x.now) < R.entryTo || null],
    ['G2_FRESH_CHAIN', () => latest && x.now - latest.at <= R.maxSampleAgeMs || null],
    ['G3_MIDDAY_BASELINE', () => baseAtm != null || null],
  ];
  const sides: Array<[Side, Array<[string, () => unknown]>]> = [
    ['BULLISH', [
      ['G4_TESTS_DAY_HIGH_OR_R1', () => { const s = latest!.spot; return (x.dayHigh != null && s >= x.dayHigh * (1 - R.testTolerance)) || (x.r1 != null && s >= x.r1 * (1 - R.testTolerance)) || null; }],
      ['G5_CALL_OI_UNWINDING', () => dCe != null && dCe < 0 || null],
      ['G6_PUT_WRITING', () => dPe != null && dPe > 0 || null],
      ['G7_PCR_SHARPLY_HIGHER', () => pcrNow != null && pcrBase != null && pcrNow - pcrBase >= R.pcrJump || null],
    ]],
    ['BEARISH', [
      ['G4_BREAKS_DAY_LOW_OR_VWAP', () => (x.dayLow != null && latest!.spot < x.dayLow) || (x.futuresPrice != null && x.futuresVwap != null && x.futuresPrice < x.futuresVwap) || null],
      ['G5_PUT_WRITERS_EXIT', () => dPe != null && dPe < 0 || null],
    ]],
  ];
  return sides.map(([side, steps]) => {
    const checks: GammaResult['checks'] = [];
    let failed: string | null = null;
    for (const [id, f] of [...common, ...steps]) {
      const ok = !!f();
      checks.push({ id, ok });
      if (!ok) { failed = id; break; }
    }
    const signal = failed == null && atm != null;
    return {
      strategy: DHAN_GAMMA_ID, side, status: signal ? 'SIGNAL' : 'NO_SETUP', failed, checks, evidence,
      strikes: signal ? { atm: atm!, itm: side === 'BULLISH' ? atm! - x.strikeStep : atm! + x.strikeStep, right: side === 'BULLISH' ? 'CE' : 'PE' } : null,
      forcedExitAt: signal ? atIst(x.now, R.forcedExit) : null,
    };
  });
}
