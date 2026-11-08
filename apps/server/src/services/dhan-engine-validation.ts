// ============================================================
// DHAN ENGINE v2 — PHASE 6: validation from stored data (reproducible)
// ============================================================
// 1. Recorded signals: every SIGNAL / NO_TRADE row of dhan_engine_signals (A–D; expiry gamma has no stop and is not
//    graded) walked forward over the contract's later bars of the same session, built from the RECORDED trade events
//    (order_flow_events: exact observed trade prices, unreconciled volume ignored). Gross R, and net R after a
//    conservative 2-tick round-trip slippage on the futures (option fees are in the paper trades themselves).
// 2. Footprint replay: one contract over at most 10 days — the recorded events rebuilt into 15-minute footprints
//    (the stored price step, the same reconciliation rule), setups A–D re-run bar by bar exactly as live, and every
//    resulting signal graded the same way. On demand only; bounded.
// Nothing here changes a parameter; the report is what the stored data says, with small samples flagged.
// ============================================================

import {
  buildFootprint, evaluateDhanSetups, gradeSignal, istSession, validationReport, unavailableFootprint,
  type EngineBar, type FlowTrade, type FootprintBar, type GradedTrade, type SetupContext, type Side,
} from '@fno/analytics';
import { getSessionWindow, type Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { applyReconciliation, decodeFlowEvents, FLOW_BAR_MS, ORDER_FLOW_EVENTS_MIGRATION } from './order-flow-store.js';
export { decodeFlowEvents };
import { dailyFromFootprints, DHAN_SIGNALS_MIGRATION } from './dhan-engine-shadow.js';

export const REPLAY_MAX_DAYS = 10;
export const VALIDATION_MAX_DAYS = 62;
const SLIPPAGE_TICKS = 2;

export interface RecordedBar { barTime: number; exchange: string; instrument: string | null; trades: FlowTrade[]; unreconciled: number }

async function loadRecorded(symbol: string, from: number, to: number): Promise<RecordedBar[]> {
  const rows = await sql<Array<{ exchange: string; instrument: string | null; bar_time: Date; events: Buffer; encoding: string }>>`
    SELECT exchange, instrument, bar_time, events, encoding FROM order_flow_events
    WHERE symbol = ${symbol} AND bar_time >= ${new Date(from)} AND bar_time < ${new Date(to)} ORDER BY bar_time`;
  return rows.filter((r) => r.encoding === 'gzip-json-v1').map((r) => { const t = new Date(r.bar_time).getTime(); return { barTime: t, exchange: r.exchange, instrument: r.instrument, ...decodeFlowEvents(r.events, t) }; });
}

export function barOfTrades(barTime: number, trades: readonly FlowTrade[]): EngineBar | null {
  if (!trades.length) return null;
  const s = [...trades].sort((a, b) => a.time - b.time);
  return { time: barTime, open: s[0].price, high: Math.max(...s.map((t) => t.price)), low: Math.min(...s.map((t) => t.price)), close: s[s.length - 1].price, volume: s.reduce((a, t) => a + t.qty, 0) };
}

const sessionAfter = (bars: readonly EngineBar[], barTime: number) => bars.filter((b) => b.time >= barTime + FLOW_BAR_MS && istSession(b.time) === istSession(barTime));
const day = (s: string) => Date.parse(`${s}T00:00:00+05:30`);

/** Grade the recorded A–D signals of [fromDay, toDay] (IST dates, inclusive). */
export async function dhanValidation(fromDay: string, toDay: string) {
  const from = day(fromDay), to = day(toDay) + 86_400_000;
  if (!(to > from) || to - from > VALIDATION_MAX_DAYS * 86_400_000) throw new Error(`Range must be 1-${VALIDATION_MAX_DAYS} days`);
  if (!schemaFileReady(DHAN_SIGNALS_MIGRATION) || !schemaFileReady(ORDER_FLOW_EVENTS_MIGRATION)) return { from: fromDay, to: toDay, signals: 0, ungradable: 0, costBasis: `${SLIPPAGE_TICKS} ticks round trip on the futures`, ...validationReport([], 'RECORDED_SIGNALS'), rejected: validationReport([], 'RECORDED_NO_TRADE').overall };
  const signals = await sql<Array<{ strategy: string; side: Side; symbol: string; bar_time: Date; status: string; entry: string; stop_loss: string; target: string; regime: string | null }>>`
    SELECT strategy, side, symbol, bar_time, status, entry, stop_loss, target, regime FROM dhan_engine_signals
    WHERE bar_time >= ${new Date(from)} AND bar_time < ${new Date(to)} AND strategy LIKE 'DHAN\\_%' AND strategy <> 'DHAN_EXPIRY_GAMMA' AND entry IS NOT NULL AND stop_loss IS NOT NULL AND target IS NOT NULL
    ORDER BY bar_time`;
  const ticks = new Map<string, number>();
  for (const r of await sql<Array<{ symbol: string; tick: string | null }>>`SELECT symbol, max(tick_size) AS tick FROM order_flow_bars WHERE bar_time >= ${new Date(from)} AND bar_time < ${new Date(to)} GROUP BY symbol`) if (r.tick != null) ticks.set(r.symbol, Number(r.tick));
  const graded: Record<string, GradedTrade[]> = { SIGNAL: [], NO_TRADE: [] };
  let ungradable = 0;
  for (const symbol of [...new Set(signals.map((s) => s.symbol))]) {
    const mine = signals.filter((s) => s.symbol === symbol);
    const recorded = await loadRecorded(symbol, Math.min(...mine.map((s) => new Date(s.bar_time).getTime())), to);
    const bars = recorded.map((r) => barOfTrades(r.barTime, r.trades)).filter((b): b is EngineBar => b != null);
    for (const s of mine) {
      const t = new Date(s.bar_time).getTime();
      const g = gradeSignal({ side: s.side, entry: Number(s.entry), stop: Number(s.stop_loss), target: Number(s.target), costPoints: SLIPPAGE_TICKS * (ticks.get(symbol) ?? 0) }, sessionAfter(bars, t));
      if (g.r == null) { ungradable++; continue; }
      (graded[s.status] ??= []).push({ key: `${s.strategy}:${s.side}:${symbol}:${t}`, strategy: s.strategy, symbol, side: s.side, time: t, regime: s.regime, status: s.status, r: g.r, netR: g.netR, outcome: g.outcome });
    }
  }
  return {
    from: fromDay, to: toDay, signals: signals.length, ungradable, costBasis: `${SLIPPAGE_TICKS} ticks round trip on the futures`,
    ...validationReport(graded.SIGNAL, 'RECORDED_SIGNALS'),
    // NO_TRADE rows graded separately: what the gates / score / no-trade engine filtered out (never pooled with SIGNAL).
    rejected: validationReport(graded.NO_TRADE ?? [], 'RECORDED_NO_TRADE').overall,
  };
}

/** Re-run setups A–D on one contract's recorded events, bar by bar, and grade every signal. */
export async function dhanReplay(symbol: string, fromDay: string, toDay: string) {
  const from = day(fromDay), to = day(toDay) + 86_400_000;
  if (!(to > from) || to - from > REPLAY_MAX_DAYS * 86_400_000) throw new Error(`Replay range must be 1-${REPLAY_MAX_DAYS} days`);
  if (!schemaFileReady(ORDER_FLOW_EVENTS_MIGRATION)) return { symbol, from: fromDay, to: toDay, bars: 0, evaluations: 0, signals: [], report: validationReport([], 'FOOTPRINT_REPLAY') };
  const meta = await sql<Array<{ bar_time: Date; price_step: string | null; tick_size: string | null }>>`
    SELECT bar_time, price_step, tick_size FROM order_flow_bars WHERE symbol = ${symbol} AND bar_time >= ${new Date(from)} AND bar_time < ${new Date(to)}`;
  const step = new Map(meta.map((m) => [new Date(m.bar_time).getTime(), m.price_step == null ? null : Number(m.price_step)]));
  const tick = Math.max(0, ...meta.map((m) => Number(m.tick_size ?? 0)));
  const recorded = await loadRecorded(symbol, from, to);
  if (!recorded.length || !(tick > 0)) return { symbol, from: fromDay, to: toDay, bars: recorded.length, evaluations: 0, signals: [], report: validationReport([], 'FOOTPRINT_REPLAY'), note: 'No recorded events or tick size for this range.' };
  const fps: FootprintBar[] = [], bars: EngineBar[] = [];
  for (const r of recorded) {
    const b = barOfTrades(r.barTime, r.trades), st = step.get(r.barTime);
    if (!b || !(st && st > 0)) continue;
    const fp = r.trades.length ? buildFootprint(r.trades, r.barTime, FLOW_BAR_MS, st, 'INFERRED') : unavailableFootprint(r.barTime, FLOW_BAR_MS);
    applyReconciliation(fp, r.unreconciled);
    Object.assign(fp, { sourceInstrument: r.instrument, priceStep: st, tickSize: tick, open: b.open, tradeSums: r.trades.reduce((a, t) => ({ pv: a.pv + t.price * t.qty, v: a.v + t.qty, p2v: a.p2v + t.price * t.price * t.qty }), { pv: 0, v: 0, p2v: 0 }) });
    fps.push(fp); bars.push(b);
  }
  const out: Array<{ strategy: string; side: Side; barTime: number; status: string; score: number | null; plan: unknown; outcome: string; r: number | null }> = [];
  const graded: GradedTrade[] = [];
  let evaluations = 0;
  for (let i = 0; i < fps.length; i++) {
    const t = bars[i].time, today = istSession(t);
    const lo = Math.max(0, i - 399), first = fps.findIndex((f) => istSession(f.barTime) === today);
    const ctx: SetupContext = {
      symbol, instrument: recorded[0].instrument, kind: null, exchange: recorded[0].exchange, tickSize: tick, bars: bars.slice(lo, i + 1), fps: fps.slice(lo, i + 1),
      vwapSums: fps.slice(lo, i + 1).map((f) => f.tradeSums ?? null), rvol: fps.slice(lo, i + 1).map(() => null), daily: dailyFromFootprints(fps.slice(0, i + 1), today),
      sessionOpen: getSessionWindow(recorded[0].exchange as Exchange, today)?.open ?? fps[first].barTime, health: { stale: false, mappingValid: true },
    };
    const ev = evaluateDhanSetups(ctx);
    evaluations++;
    if (evaluations % 10 === 0) await new Promise((r) => setImmediate(r)); // never hold the event loop for long
    for (const r of ev.results) {
      if (r.status === 'NO_SETUP' || !r.plan) continue;
      const g = gradeSignal({ side: r.side, entry: r.plan.entry, stop: r.plan.sl, target: r.plan.target, costPoints: SLIPPAGE_TICKS * tick }, sessionAfter(bars, t));
      out.push({ strategy: r.strategy, side: r.side, barTime: t, status: r.status, score: r.score?.total ?? null, plan: r.plan, outcome: g.outcome, r: g.r });
      if (r.status === 'SIGNAL' && g.r != null) graded.push({ key: `${r.strategy}:${r.side}:${t}`, strategy: r.strategy, symbol, side: r.side, time: t, regime: ev.regime?.regime ?? null, status: r.status, r: g.r, netR: g.netR, outcome: g.outcome });
    }
  }
  return { symbol, from: fromDay, to: toDay, bars: bars.length, evaluations, note: 'RVOL is not replayed (setup B needs 20 recorded sessions of the same slot).', signals: out.slice(-200), report: validationReport(graded, 'FOOTPRINT_REPLAY') };
}
