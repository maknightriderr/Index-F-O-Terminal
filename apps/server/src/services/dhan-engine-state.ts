// ============================================================
// DHAN ENGINE v2 — per-contract engine snapshot (read-only, phase 2)
// ============================================================
// Runs the pure engines (packages/analytics dhan-engine) over one contract's closed 15-minute footprints of the
// current session and its trade-based session VWAP. On demand only (diagnostics endpoint): no timer, no IO, no
// effect on any strategy or paper trade. Setups (phase 3) will read the same engines.
// Every block carries its status (ESTIMATED / INCOMPLETE / UNAVAILABLE / ...), never a bare number.
// ============================================================

import {
  analyzeStructure, cvdDivergences, cvdSeries, detectAbsorption, detectExhaustion, diagonalImbalances, istSession, profileFromFootprints, vwapFromSums,
  DHAN_ENGINE_VERSION, type EngineBar, type FootprintBar,
} from '@fno/analytics';
import { flowSessionState, flowSymbols } from './order-flow-store.js';

const ATR_BARS = 14;
const MIN_ATR_BARS = 5;

const traded = (f: FootprintBar) => f.deltaMode !== 'UNAVAILABLE' && f.high != null && f.low != null && f.close != null;
const toBar = (f: FootprintBar): EngineBar => ({ time: f.barTime, open: f.close!, high: f.high!, low: f.low!, close: f.close! });

/** Mean 15-minute range of the session's traded bars (a range proxy, labelled as such); null below 5 bars. */
function rangeAtr(fps: readonly FootprintBar[]): number | null {
  const r = fps.filter(traded).slice(-ATR_BARS).map((f) => f.high! - f.low!);
  return r.length >= MIN_ATR_BARS ? r.reduce((a, x) => a + x, 0) / r.length : null;
}

export function dhanEngineSnapshot(symbol: string, now: number = Date.now()) {
  const st = flowSessionState(symbol, now);
  if (!st) return null;
  const fps = st.footprints;
  const tradedFps = fps.filter(traded);
  const bars = tradedFps.map(toBar);
  const latest = fps.at(-1) ?? null;
  const atr = rangeAtr(fps);
  const cvdBars = fps.map((f) => ({ time: f.barTime, open: f.close ?? 0, high: f.high ?? 0, low: f.low ?? 0, close: f.close ?? 0, delta: f.deltaMode === 'UNAVAILABLE' ? null : f.delta }));
  const cvd = cvdSeries(cvdBars, istSession);
  // Divergence needs confirmed price pivots: only on a session with no empty bar (pivots on traded bars = the same bars).
  const divergences = tradedFps.length === fps.length ? cvdDivergences(cvdBars, cvd) : [];
  const profile = profileFromFootprints(tradedFps);
  const vwapRaw = st.vwap ? vwapFromSums(st.vwap.sums, 'TRADES', st.vwap.unreconciled) : vwapFromSums({ pv: 0, v: 0, p2v: 0 }, 'TRADES');
  // A bar of this session was lost (process restart): the session sums miss its trades.
  const vwap = st.vwap?.incomplete && vwapRaw.status !== 'UNAVAILABLE' ? { ...vwapRaw, status: 'INCOMPLETE' as const } : vwapRaw;
  const lastClose = bars.at(-1)?.close ?? null;
  const fp2 = latest ? diagonalImbalances(latest) : null;
  const structure = st.tickSize && bars.length >= 5 ? analyzeStructure(bars, st.tickSize) : null;
  const absorption = atr ? detectAbsorption(tradedFps, atr, bars).slice(-5) : [];
  const exhaustion = detectExhaustion(tradedFps, bars).slice(-5);
  const at = (i: number) => bars[i]?.time ?? null;
  return {
    symbol, version: DHAN_ENGINE_VERSION, session: istSession(now), exchange: st.exchange, instrument: st.instrument, kind: st.kind, tickSize: st.tickSize,
    bars: fps.length, tradedBars: tradedFps.length, incompleteBars: fps.filter((f) => f.incomplete).length,
    lastBar: latest && { barTime: latest.barTime, deltaMode: latest.deltaMode, delta: latest.delta, deltaPct: latest.deltaPct, incomplete: !!latest.incomplete, unreconciledVolume: latest.unreconciledVolume ?? null },
    footprint: fp2 && { status: fp2.status, reason: fp2.reason, barTime: fp2.barTime, priceStep: fp2.priceStep, minLevelVolume: fp2.minLevelVolume, buyImbalances: fp2.buyImbalances, sellImbalances: fp2.sellImbalances, stacks: fp2.stacks, rows: (fp2.rows.length ? fp2.rows : (latest?.levels ?? []).map((l) => ({ price: l.price, ask: l.buy, bid: l.sell, unknown: l.unclassified, buyRatio: null, sellRatio: null, buyImbalance: false, sellImbalance: false }))).slice(-60) },
    cvd: { last: cvd.at(-1) ?? null, series: cvd.map((p) => ({ time: p.time, delta: p.delta, cvd: p.cvd, status: p.status })), divergences: divergences.map((d) => ({ ...d, time: cvdBars[d.second].time })) },
    profile: { status: profile.status, reason: profile.reason, poc: profile.poc, vah: profile.vah, val: profile.val, valueAreaShare: profile.valueAreaShare, hvn: profile.hvn, lvn: profile.lvn, total: profile.total },
    vwap: { ...vwap, distanceSd: vwap.vwap != null && vwap.sd && lastClose != null ? Math.round(((lastClose - vwap.vwap) / vwap.sd) * 100) / 100 : null },
    atr: { value: atr, source: 'MEAN_15M_RANGE' },
    structure: structure && { source: 'FLOW_15M_BARS', trend: structure.trend, lastSwingHigh: structure.lastSwingHigh?.price ?? null, lastSwingLow: structure.lastSwingLow?.price ?? null, lastBreak: structure.breaks.at(-1) ? { ...structure.breaks.at(-1)!, time: at(structure.breaks.at(-1)!.index) } : null },
    absorption: absorption.map((e) => ({ ...e, time: at(e.index) })),
    exhaustion: exhaustion.map((e) => ({ ...e, time: at(e.index) })),
  };
}

/** One line per contract (for the diagnostics list). */
export function dhanEngineSummary(now: number = Date.now()) {
  return flowSymbols().map((s) => {
    const x = dhanEngineSnapshot(s, now);
    return x && { symbol: s, kind: x.kind, bars: x.bars, incompleteBars: x.incompleteBars, cvd: x.cvd.last?.cvd ?? null, cvdStatus: x.cvd.last?.status ?? 'UNAVAILABLE', vwap: x.vwap.vwap, vwapStatus: x.vwap.status, poc: x.profile.poc, footprint: x.footprint?.status ?? 'UNAVAILABLE', trend: x.structure?.trend ?? null };
  }).filter((x) => x != null);
}
