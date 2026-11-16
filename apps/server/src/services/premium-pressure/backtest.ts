// ============================================================
// PREMIUM PRESSURE backtest: replay on STORED chain snapshots (oi_snapshots), read-only
// ============================================================
// Limits, stated in every result: the capture writes one snapshot per symbol every 15 minutes, so the replay reads
// 15 / 30 / 45 / 60-minute windows — NOT the live module's 1 / 3 / 5 / 10 minutes — and can only see a stop or target
// at the next 15-minute snapshot. Rows older than the retention horizon are archived and not read here. It measures
// whether the idea has any edge at a coarse resolution; it cannot validate the live thresholds.
// ============================================================

import { ppReplay, ppReplayStats, GXP_CONFIG, type PpConfig, type PpLeg, type PpReplayOptions, type PpReplayStats, type PpSample, type PpVariant } from '@fno/analytics';
import { sql } from '../../lib/db.js';
import { gxpMinutesToExpiry } from './runner.js';

export const GXP_BACKTEST_CONFIG: PpConfig = {
  ...GXP_CONFIG, windows: [15, 30, 45, 60], maxSampleAgeMs: Number.MAX_SAFE_INTEGER,
  periods: { NON_EXPIRY: { ...GXP_CONFIG.periods.NON_EXPIRY, primary: 1 }, EXPIRY: { ...GXP_CONFIG.periods.EXPIRY, primary: 0 }, EXPIRY_LAST_60: { ...GXP_CONFIG.periods.EXPIRY_LAST_60, primary: 0 }, EXPIRY_LAST_30: { ...GXP_CONFIG.periods.EXPIRY_LAST_30, primary: 0 } },
};
export const GXP_BACKTEST_OPTIONS: PpReplayOptions = { config: GXP_BACKTEST_CONFIG, slippagePct: 0.005, costPct: 0.004, maxHoldMin: 90, rr: 1.5, stopSigma: 1.5, cooldownMin: 30 };
const VARIANTS: readonly PpVariant[] = ['GEX_PLUS_PRESSURE', 'PRESSURE_ONLY', 'GEX_CONTEXT_ONLY', 'UNDERLYING_BASELINE'];

interface Row { time: Date; strike: string | number; option_type: string; expiry: Date | string; oi: string | number | null; volume: string | number | null; ltp: string | number | null; bid: string | number | null; ask: string | number | null; iv: string | number | null; delta: string | number | null; gamma: string | number | null; theta: string | number | null; vega: string | number | null; spot_price: string | number | null }
const num = (v: unknown): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const isoDay = (d: Date | string) => (d instanceof Date ? new Date(d.getTime() + 19_800_000).toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Stored rows -> one sample per capture time, on the nearest expiry of that time. Pure. */
export function gxpSamplesFromRows(rows: readonly Row[], closeMinuteIst: number): PpSample[] {
  const byTime = new Map<number, Row[]>();
  for (const r of rows) { const t = Math.floor(r.time.getTime() / 60_000) * 60_000; byTime.set(t, [...(byTime.get(t) ?? []), r]); }
  const out: PpSample[] = [];
  for (const [at, group] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    const today = isoDay(new Date(at)), expiry = group.map((r) => isoDay(r.expiry)).filter((e) => e >= today).sort()[0];
    if (!expiry) continue;
    const legs = group.filter((r) => isoDay(r.expiry) === expiry), spot = num(legs.find((r) => num(r.spot_price))?.spot_price);
    if (!spot) continue;
    const strikes = new Map<number, { strike: number; call: PpLeg | null; put: PpLeg | null }>();
    for (const r of legs) {
      const strike = num(r.strike), ltp = num(r.ltp); if (!strike || !ltp) continue;
      const leg: PpLeg = { ltp, bid: num(r.bid) ?? 0, ask: num(r.ask) ?? 0, oi: num(r.oi), volume: num(r.volume), iv: num(r.iv), delta: num(r.delta), gamma: num(r.gamma), theta: num(r.theta), vega: num(r.vega) };
      // A row captured without a book: a modelled half-spread (the replay still pays slippage on it).
      if (!(leg.bid > 0) || !(leg.ask > 0)) { leg.bid = ltp * 0.995; leg.ask = ltp * 1.005; }
      const k = strikes.get(strike) ?? { strike, call: null, put: null };
      if (r.option_type === 'CE') k.call = leg; else k.put = leg; strikes.set(strike, k);
    }
    const list = [...strikes.values()].sort((a, b) => a.strike - b.strike);
    const steps = list.slice(1).map((k, i) => k.strike - list[i].strike).filter((x) => x > 0).sort((a, b) => a - b);
    if (list.length < 5 || !steps.length) continue;
    const closeAt = Date.parse(`${today}T00:00:00+05:30`) + closeMinuteIst * 60_000;
    out.push({ at, spot, spotAt: at, expiry, minutesToExpiry: gxpMinutesToExpiry(expiry, at, closeAt), strikeStep: steps[0], strikes: list });
  }
  return out;
}

export interface GxpBacktestResult {
  simulated: true; symbols: string[]; days: number; from: string | null; to: string | null; samples: number; sessions: number;
  resolution: '15_MINUTE_SNAPSHOTS'; limits: string[];
  /** Chronological split (first 70% of sessions / last 30%). No parameter was fitted on either part. */
  all: PpReplayStats[]; earlier: PpReplayStats[]; later: PpReplayStats[];
  sampleSufficient: boolean;
}

export async function runGxpBacktest(symbols: readonly string[], days: number): Promise<GxpBacktestResult> {
  const from = new Date(Date.now() - days * 86_400_000);
  const per: Array<{ symbol: string; samples: PpSample[] }> = [];
  for (const symbol of symbols) {
    const rows = await sql<Row[]>`SELECT time, strike, option_type, expiry, oi, volume, ltp, bid, ask, iv, delta, gamma, theta, vega, spot_price FROM oi_snapshots WHERE symbol = ${symbol} AND time >= ${from} AND option_type IN ('CE','PE') AND expiry <= (time::date + 10) ORDER BY time`;
    per.push({ symbol, samples: gxpSamplesFromRows(rows, 15 * 60 + 30) });
  }
  const daysSeen = [...new Set(per.flatMap((p) => p.samples.map((s) => new Date(s.at + 19_800_000).toISOString().slice(0, 10))))].sort();
  const cut = daysSeen[Math.floor(daysSeen.length * 0.7)] ?? null;
  const stats = (filter: (day: string) => boolean) => VARIANTS.map((v) => ppReplayStats(v, per.map((p) => ppReplay(p.symbol, p.samples.filter((s) => filter(new Date(s.at + 19_800_000).toISOString().slice(0, 10))), v, GXP_BACKTEST_OPTIONS))));
  const all = stats(() => true);
  return {
    simulated: true, symbols: [...symbols], days, from: daysSeen[0] ?? null, to: daysSeen[daysSeen.length - 1] ?? null, samples: per.reduce((a, p) => a + p.samples.length, 0), sessions: daysSeen.length,
    resolution: '15_MINUTE_SNAPSHOTS',
    limits: [
      'Stored snapshots are 15 minutes apart: windows are 15/30/45/60 minutes, not the live 1/3/5/10; exits are seen only at the next snapshot.',
      'Simulated fills on the stored ask / bid (or last price with 0.5% slippage) and an estimated 0.4% round-trip charge on premium turnover.',
      'The existing GEX read has no direction of its own; "GEX context only" is the underlying baseline taken only in a SHORT_GAMMA regime.',
      'Only symbols and days the capture stored (raw rows inside the retention horizon); stock chains are captured only when tracked.',
      'A small sample proves nothing: fewer than 100 trades or 20 sessions is not evidence of an edge.',
    ],
    all, earlier: cut ? stats((d) => d < cut) : [], later: cut ? stats((d) => d >= cut) : [],
    sampleSufficient: (all[0]?.trades ?? 0) >= 100 && daysSeen.length >= 20,
  };
}
