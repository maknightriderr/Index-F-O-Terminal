// ============================================================
// CLI: structure engine on 5m entries (15m pools) — backtest and
// pre-registered head-to-head against the 15m engine
// ============================================================
// npm run backtest-structure-5m --workspace=@fno/server [-- --in-sample-only]
//
// Protocol, fixed before any result was seen:
//   1. The 5m window is the 5m NIFTY session calendar up to the last date
//      the 15m history also covers (so the head-to-head is on the same
//      dates). First ⅔ in-sample, last ⅓ out-of-sample.
//   2. Four pre-registered variants (STRUCTURE_5M_VARIANTS: DISP_MULT {1.0,
//      1.5} × closing guard {60, 15}; opening guard OFF) run in-sample.
//   3. One chosen by in-sample average net R (ties: the earlier-registered),
//      run ONCE out of sample.
//   4. Head-to-head: the live 15m config (D1.0, no opening guard, closing
//      guard 60) on its 15m data over the SAME out-of-sample dates and masks.
//      5m goes live (STRUCTURE_ENTRY_TF = '5m') only if its OOS avg net R >
//      the 15m's AND its PF > the 15m's AND it has ≥ 20 OOS trades.
//   5. The 15m closing guard (60 vs 15) is chosen on the 15m IN-SAMPLE period
//      only (D1.0, no opening guard; average net R, ties keep 60). Its OOS is
//      shown for information and marked as already-seen data.
//   6. STRUCTURE_CLOSING_GUARD_MIN default = the choice for the live timeframe.
// Masks: the 15m backtest's session masks (thin sessions, masked rolls), plus
// any session thin in the 5m data. 0.1R cost per trade. Results are in
// UNDERLYING R. Writes structure-5m-report.json / .md next to the snapshots.
// ============================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateStructureSessionMTF,
  istSlotOf,
  prepareMomentumSeries,
  STRUCTURE_15M_CLOSING_VARIANTS,
  STRUCTURE_5M_VARIANTS,
  STRUCTURE_BAR_MS_5M,
  STRUCTURE_VARIANTS,
  type MomentumBar,
  type StructureSetup,
  type StructureVariant,
} from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import {
  BACKTEST_SYMBOLS,
  borrowVolume,
  chooseVariant,
  CLOSING_GUARD_MIN,
  COST_R,
  groupStats,
  loadSymbol,
  replayStrategy,
  splitDate,
  statsOf,
  type BacktestStrategy,
  type LoadedSymbol,
  type ReplayWindow,
  type TradeStats,
  type UnfilledOrder,
} from '../backtest/harness.js';
import { countSetups, isFalsePositive, sessionSetups, STRUCTURE_5M_STRATEGY, STRUCTURE_STRATEGY, type StructureTrade } from '../backtest/structure-backtest.js';

const inSampleOnly = process.argv.includes('--in-sample-only');
const INDEX = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);
const M5 = STRUCTURE_BAR_MS_5M;

/** The live 15m config the 5m engine must beat: D1.0, no opening guard, closing guard 60 (the harness default). */
const LIVE_15M: StructureVariant = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-NOGUARD')!;
/** Pre-registered promotion rule for STRUCTURE_ENTRY_TF = '5m'. */
export const PROMOTE_5M_RULE = { minOosTrades: 20 } as const;

export function promote5m(s5: TradeStats, s15: TradeStats): { promote: boolean; checks: { avgNetR: boolean; pf: boolean; trades: boolean } } {
  const r = (x: number | null) => x ?? -Infinity;
  const pf = (x: number | null) => x ?? 0;
  const checks = {
    avgNetR: r(s5.avgNetR) > r(s15.avgNetR),
    pf: pf(s5.profitFactor) > pf(s15.profitFactor),
    trades: s5.trades >= PROMOTE_5M_RULE.minOosTrades,
  };
  return { promote: checks.avgNetR && checks.pf && checks.trades, checks };
}

const fmtR = (n: number | null | undefined) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(3));
const fmtPct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtPf = (n: number | null) => (n == null ? '—' : n === Infinity ? '∞' : n.toFixed(2));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayBefore = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

const HEADER = '| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) | Avg MFE (R) | Avg MAE (R) | False-positive % |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
function row(label: string, trades: StructureTrade[]): string {
  const s = statsOf(trades);
  const fp = trades.length ? trades.filter(isFalsePositive).length / trades.length : null;
  return `| ${label} | ${s.trades} | ${fmtPct(s.winRate)} | ${fmtR(s.avgNetR)} | ${fmtR(s.totalNetR)} | ${fmtPf(s.profitFactor)} | ${s.maxDrawdownR.toFixed(2)} | ${fmtR(avg(trades.map((t) => t.mfeR ?? 0)))} | ${fmtR(avg(trades.map((t) => t.maeR ?? 0)))} | ${fmtPct(fp)} |`;
}
function grouped<K extends string | number>(trades: StructureTrade[], key: (t: StructureTrade) => K): Array<{ key: K; trades: StructureTrade[] }> {
  const m = new Map<K, StructureTrade[]>();
  for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, ts]) => ({ key: k, trades: ts }));
}
function summary(trades: StructureTrade[]) {
  return {
    stats: statsOf(trades),
    avgMfeR: avg(trades.map((t) => t.mfeR ?? 0)),
    avgMaeR: avg(trades.map((t) => t.maeR ?? 0)),
    falsePositiveRate: trades.length ? trades.filter(isFalsePositive).length / trades.length : null,
  };
}

interface PeriodRun {
  trades: StructureTrade[];
  unfilled: UnfilledOrder<StructureSetup>[];
  setups: Map<string, StructureSetup[]>;
}

function runPeriod(loaded: LoadedSymbol[], strategy: BacktestStrategy<StructureVariant, StructureSetup>, variant: StructureVariant, window: ReplayWindow): PeriodRun {
  const trades: StructureTrade[] = [];
  const unfilled: UnfilledOrder<StructureSetup>[] = [];
  const setups = new Map<string, StructureSetup[]>();
  for (const l of loaded) {
    const r = replayStrategy(l, strategy, variant, window);
    trades.push(...r.trades);
    unfilled.push(...r.unfilled);
    const list: StructureSetup[] = [];
    l.series.sessionDates.forEach((date, s) => {
      if (date < window.from || date > window.to || l.masked.has(date)) return;
      list.push(...sessionSetups(l, s, variant));
    });
    setups.set(l.spec.symbol, list);
  }
  return { trades, unfilled, setups };
}

function setupTable(run: PeriodRun, log: (s?: string) => void) {
  log('| Symbol | Sweeps | Displaced & resolved | Placed (early) | LATE | LOW_RR | Zone already traded | Trades | MISSED | NO_FILL | GUARDED | Session end | Not placed (busy) |');
  log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const totals = { idx: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], mcx: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  for (const [symbol, list] of run.setups) {
    const c = countSetups(list);
    const tr = run.trades.filter((t) => t.symbol === symbol).length;
    const un = (o: string) => run.unfilled.filter((u) => u.symbol === symbol && u.outcome === o).length;
    const busy = c.early - tr - un('MISSED') - un('NO_FILL') - un('GUARDED') - un('SESSION_END');
    const cells = [c.sweeps, c.confirmedOrLater, c.early, c.late, c.lowRr, c.zoneTradedThrough, tr, un('MISSED'), un('NO_FILL'), un('GUARDED'), un('SESSION_END'), busy];
    const bucket = INDEX.has(symbol) ? totals.idx : totals.mcx;
    cells.forEach((v, k) => (bucket[k] += v));
    log(`| ${symbol} | ${cells.join(' | ')} |`);
  }
  log(`| **Index (NIFTY, BANKNIFTY, SENSEX)** | ${totals.idx.join(' | ')} |`);
  log(`| **MCX (CRUDEOIL, GOLD)** | ${totals.mcx.join(' | ')} |`);
  return totals;
}

function funnelJson(run: PeriodRun) {
  return Object.fromEntries(
    [...run.setups].map(([symbol, list]) => {
      const un = (o: string) => run.unfilled.filter((u) => u.symbol === symbol && u.outcome === o).length;
      return [symbol, { ...countSetups(list), trades: run.trades.filter((t) => t.symbol === symbol).length, missed: un('MISSED'), noFill: un('NO_FILL'), guarded: un('GUARDED'), sessionEnd: un('SESSION_END') }];
    })
  );
}

interface SnapshotMeta {
  name: string;
  count: number;
  firstBar: string | null;
  lastBar: string | null;
  requestedFrom: string;
  requestedTo: string;
  chunks: Array<{ from: string; to: string; count: number; firstBar?: string | null; suspectTruncated?: boolean; error?: string }>;
  suspectTruncatedChunks?: number;
}
function snapshotMeta(name: string): SnapshotMeta | null {
  const file = join(BACKTEST_DATA_DIR, `${name}.5m.json`);
  if (!existsSync(file)) return null;
  const { bars: _bars, ...meta } = JSON.parse(readFileSync(file, 'utf8'));
  return meta as SnapshotMeta;
}

// ---------------- detection lead time ----------------

interface LeadPair {
  symbol: string;
  date: string;
  direction: string;
  pool: string;
  sweep5At: number;
  sweep15At: number;
  confirm5At: number | null;
  confirm15At: number | null;
}

/**
 * The same pool sweep seen by both engines: same symbol, date, direction,
 * pool kind and price (the pools come from the same 15m bars), the 5m sweep
 * detected within 60 minutes of the 15m one (nearest wins). Lead = 15m
 * detection time − 5m detection time (bar-close instants), for the sweep
 * (DEVELOPING) and, where both confirmed, for CONFIRMED.
 */
function leadTimes(l5s: LoadedSymbol[], l15s: LoadedSymbol[], v5: StructureVariant, v15: StructureVariant, window: ReplayWindow) {
  const pairs: LeadPair[] = [];
  let sweeps15 = 0;
  let sweeps5 = 0;
  for (const l5 of l5s) {
    const l15 = l15s.find((x) => x.spec.symbol === l5.spec.symbol);
    if (!l15) continue;
    l5.series.sessionDates.forEach((date, s5) => {
      if (date < window.from || date > window.to || l5.masked.has(date)) return;
      const s15 = l15.series.sessionDates.indexOf(date);
      if (s15 < 0) return;
      const a = sessionSetups(l5, s5, v5);
      const b = sessionSetups(l15, s15, v15);
      sweeps5 += a.length;
      sweeps15 += b.length;
      const used = new Set<string>();
      for (const st15 of b) {
        const t15 = st15.history[0].at;
        let best: StructureSetup | null = null;
        for (const st5 of a) {
          if (used.has(st5.id) || st5.direction !== st15.direction || st5.pool.kind !== st15.pool.kind || Math.abs(st5.pool.price - st15.pool.price) > 0.005) continue;
          const d = Math.abs(t15 - st5.history[0].at);
          if (d > 60 * 60000) continue;
          if (!best || d < Math.abs(t15 - best.history[0].at)) best = st5;
        }
        if (!best) continue;
        used.add(best.id);
        const conf = (st: StructureSetup) => st.history.find((h) => h.stage === 'CONFIRMED')?.at ?? null;
        pairs.push({ symbol: l5.spec.symbol, date, direction: st15.direction, pool: `${st15.pool.kind} ${st15.pool.price}`, sweep5At: best.history[0].at, sweep15At: t15, confirm5At: conf(best), confirm15At: conf(st15) });
      }
    });
  }
  const sweepLeads = pairs.map((p) => (p.sweep15At - p.sweep5At) / 60000);
  const both = pairs.filter((p) => p.confirm5At != null && p.confirm15At != null);
  const confirmLeads = both.map((p) => (p.confirm15At! - p.confirm5At!) / 60000);
  return {
    method: 'same symbol, date, direction, pool kind and price; 5m sweep within 60 min of the 15m sweep (nearest); lead = 15m detection − 5m detection, minutes',
    sweeps5,
    sweeps15,
    matched: pairs.length,
    sweep: { mean: avg(sweepLeads), median: median(sweepLeads), earlier5: sweepLeads.filter((x) => x > 0).length, same: sweepLeads.filter((x) => x === 0).length, later5: sweepLeads.filter((x) => x < 0).length },
    confirmBoth: both.length,
    confirm: { mean: avg(confirmLeads), median: median(confirmLeads), earlier5: confirmLeads.filter((x) => x > 0).length, later5: confirmLeads.filter((x) => x < 0).length },
    confirmed5Only: pairs.filter((p) => p.confirm5At != null && p.confirm15At == null).length,
    confirmed15Only: pairs.filter((p) => p.confirm5At == null && p.confirm15At != null).length,
    pairs,
  };
}

// ---------------- named cases ----------------

function namedCase5(l5: LoadedSymbol, l15: LoadedSymbol | null, variant: StructureVariant, date: string, from: string, to: string, oosTrades: StructureTrade[] | null) {
  const lines: string[] = [];
  const { series } = l5;
  const s = series.sessionDates.indexOf(date);
  if (s < 0) return { lines: [`No ${date} session in the ${l5.spec.symbol} 5m data.`], data: null };
  const start = series.sessionStarts[s];
  const end = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  lines.push(`Masked session: ${l5.masked.get(date) ?? 'no'}. Variant ${variant.id} (5m events, 15m pools).`);
  lines.push('');
  lines.push('| 5m bar (IST) | O | H | L | C | 5m ATR | Bearish stage | Bullish stage | WATCH pool (bear / bull) |');
  lines.push('|---|---:|---:|---:|---:|---:|---|---|---|');
  const stageOf = (setups: StructureSetup[], dir: 'BEARISH' | 'BULLISH', i: number) => {
    const mine = setups.filter((x) => x.direction === dir);
    const cur = mine[mine.length - 1];
    if (!cur) return '—';
    const lastT = cur.history[cur.history.length - 1];
    return lastT.barIndex === i ? `**${lastT.stage}**${lastT.reason ? ` (${lastT.reason})` : ''}` : cur.stage;
  };
  const rows: unknown[] = [];
  for (let i = start; i <= end; i++) {
    const slot = istSlotOf(series.bars[i].time);
    if (slot < from || slot >= to) continue;
    const ev = evaluateStructureSessionMTF(l5.poolSeries!, series, i, variant);
    const b = series.bars[i];
    const w = `${ev.watch.BEARISH ? `${ev.watch.BEARISH.kind} ${ev.watch.BEARISH.price}` : '—'} / ${ev.watch.BULLISH ? `${ev.watch.BULLISH.kind} ${ev.watch.BULLISH.price}` : '—'}`;
    lines.push(`| ${slot}–${istSlotOf(b.time + M5)} | ${b.open} | ${b.high} | ${b.low} | ${b.close} | ${ev.atr ?? '—'} | ${stageOf(ev.setups, 'BEARISH', i)} | ${stageOf(ev.setups, 'BULLISH', i)} | ${w} |`);
    rows.push({ slot, bearish: stageOf(ev.setups, 'BEARISH', i), bullish: stageOf(ev.setups, 'BULLISH', i), watch: w });
  }
  lines.push('');
  const describe = (st: StructureSetup, bars: MomentumBar[], barMs: number) =>
    `- ${st.direction} ${st.pool.kind} ${st.pool.price} swept at ${istSlotOf(st.sweep.barTime)} (${st.sweep.bars}-bar, extreme ${round2(st.sweep.extreme)}, depth ${st.sweep.depthAtr} ATR)` +
    (st.displacement ? `; displacement ${istSlotOf(st.displacement.barTime)} ${st.displacement.bodyAtr} ATR${st.displacement.structureShift ? ' + structure shift' : ''}` : '') +
    (st.zone ? `; zone ${st.zone.kind} ${st.zone.near}–${st.zone.far}, entry ${st.entry}, stop ${st.stop}, T1 ${st.t1 ? `${st.t1.kind} ${st.t1.price} (${st.rToT1}R)` : '—'}` : '') +
    ` → ${st.history.map((h) => `${h.stage}@${istSlotOf(bars[h.barIndex].time + barMs)}${h.reason ? `(${h.reason})` : ''}`).join(' → ')}` +
    (st.score ? `; score ${st.score.total}` : '');
  const day = sessionSetups(l5, s, variant);
  lines.push('**5m engine (15m pools):**');
  lines.push('');
  if (day.length === 0) lines.push('No sweep of a Tier-1 pool that day.');
  for (const st of day) lines.push(describe(st, series.bars, M5));
  if (l15) {
    const s15 = l15.series.sessionDates.indexOf(date);
    lines.push('');
    lines.push(`**15m engine (${LIVE_15M.id}), same day, for timing:**`);
    lines.push('');
    const day15 = s15 >= 0 ? sessionSetups(l15, s15, LIVE_15M) : [];
    if (day15.length === 0) lines.push('No sweep of a Tier-1 pool that day on 15m.');
    for (const st of day15) lines.push(describe(st, l15.series.bars, 15 * 60000));
  }
  const r = replayStrategy(l5, STRUCTURE_5M_STRATEGY, variant, { from: date, to: date });
  lines.push('');
  if (r.trades.length === 0 && r.unfilled.length === 0) lines.push('The 5m harness placed no order that day.');
  for (const t of r.trades) lines.push(`5m harness trade: ${t.signal.direction} filled ${t.fill ? istSlotOf(Date.parse(t.fill.at)) : '?'} at ${t.fill?.price}, exit ${t.exit} ${t.exitPrice} (${istSlotOf(Date.parse(t.exitAt))}): ${fmtR(t.grossR)}R gross, ${fmtR(t.netR)}R net.`);
  for (const u of r.unfilled) lines.push(`5m harness order not filled: ${u.signal.direction} confirmed ${istSlotOf(Date.parse(u.decidedAt))} → ${u.outcome}.`);
  if (oosTrades) {
    const inOos = oosTrades.filter((t) => t.symbol === l5.spec.symbol && t.date === date);
    lines.push(inOos.length ? `In the 5m out-of-sample statistics: ${inOos.length} trade(s) that day.` : 'Not in the 5m out-of-sample trade list that day.');
  } else {
    lines.push('(29 Sep is after the last date both histories cover — this case is shown for reference, not counted.)');
  }
  return { lines, data: { rows, setups: day, harness: { trades: r.trades, unfilled: r.unfilled.map((u) => ({ outcome: u.outcome, decidedAt: u.decidedAt })) } } };
}

/** NIFTY 15m history plus the 29 Sep 15m bars fetched for the named case only. */
function nifty15With29Sep(nifty15: LoadedSymbol): LoadedSymbol | null {
  const read = (name: string) => {
    const file = join(BACKTEST_DATA_DIR, `${name}.2026-09-29.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).bars as Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>) : null;
  };
  const px = read('NIFTY_INDEX');
  const vol = read('NIFTY_FUT');
  if (!px) return null;
  const toBars = (bs: NonNullable<typeof px>): MomentumBar[] => bs.map((b) => ({ time: Date.parse(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const extra = vol ? borrowVolume(toBars(px), toBars(vol)) : toBars(px);
  const lastTime = nifty15.series.bars[nifty15.series.bars.length - 1].time;
  const series = prepareMomentumSeries([...nifty15.series.bars, ...extra.filter((b) => b.time > lastTime)]);
  return { ...nifty15, series };
}

// ---------------- main ----------------

function main() {
  const loaded5: LoadedSymbol[] = [];
  const loaded15: LoadedSymbol[] = [];
  const h2h15: LoadedSymbol[] = [];
  const missing: string[] = ['FINNIFTY (no snapshot fetched — not backtested)'];
  const maskNotes: string[] = [];
  for (const spec of BACKTEST_SYMBOLS) {
    const l15 = loadSymbol(BACKTEST_DATA_DIR, spec);
    const l5 = loadSymbol(BACKTEST_DATA_DIR, spec, { barMs: M5, fileSuffix: '.5m' });
    if (!l15 || !l5) {
      missing.push(`${spec.symbol} (${!l5 ? '5m' : '15m'} snapshot missing)`);
      continue;
    }
    // The same masks as the 15m backtest, plus any session thin in the 5m data.
    const masked = new Map(l15.masked);
    const extra: string[] = [];
    for (const [date, why] of l5.masked) {
      if (why === 'THIN' && !masked.has(date)) {
        masked.set(date, 'THIN');
        extra.push(date);
      }
    }
    if (extra.length) maskNotes.push(`${spec.symbol}: ${extra.join(', ')} thin in 5m only`);
    loaded15.push(l15);
    loaded5.push({ ...l5, poolSeries: l15.series, masked });
    h2h15.push({ ...l15, masked });
  }
  if (loaded5.length === 0) throw new Error(`No 5m snapshots in ${BACKTEST_DATA_DIR} — run fetch-history.ts --interval=5m first`);

  const last15 = [...loaded15.flatMap((l) => l.series.sessionDates)].sort().at(-1)!;
  const cal5Symbol = loaded5.find((l) => l.spec.symbol === 'NIFTY') ?? loaded5[0];
  const cal5 = cal5Symbol.series.sessionDates.filter((d) => d <= last15);
  const oosFrom = splitDate(cal5);
  const inSample: ReplayWindow = { from: cal5[0], to: dayBefore(oosFrom) };
  const outOfSample: ReplayWindow = { from: oosFrom, to: last15 };
  const cal15Symbol = loaded15.find((l) => l.spec.symbol === 'NIFTY') ?? loaded15[0];
  const cal15 = cal15Symbol.series.sessionDates;
  const oos15From = splitDate(cal15);
  const inSample15: ReplayWindow = { from: cal15[0], to: dayBefore(oos15From) };
  const outOfSample15: ReplayWindow = { from: oos15From, to: last15 };

  const lines: string[] = [];
  const log = (s = '') => {
    lines.push(s);
    console.log(s);
  };

  log('# Structure engine on 5m entries (15m pools) — backtest and head-to-head');
  log();
  log(`5m window ${cal5[0]} → ${last15} (the ${cal5Symbol.spec.symbol} 5m session calendar, capped at the last date the 15m history covers). In-sample ${inSample.from} → ${inSample.to}; out-of-sample ${outOfSample.from} → ${outOfSample.to} (chronological ⅔ / ⅓).`);
  log(`Cost ${COST_R}R per trade deducted. Masks: the 15m backtest's (thin sessions, masked futures rolls) plus sessions thin in the 5m data${maskNotes.length ? ` (${maskNotes.join('; ')})` : ' (none extra)'}.`);
  log(`Variants (pre-registered): ${STRUCTURE_5M_VARIANTS.map((v) => `${v.id} (DISP_MULT ${v.dispMult}, closing guard ${v.closingGuardMin} min, opening guard off)`).join('; ')}.`);
  log('Rules restated in time (pre-registered): sweep depth ≥ 0.1 × 5m ATR; displacement body ≥ DISP_MULT × 5m ATR within 30 min (6 × 5m); FVG ≥ 0.1 × 5m ATR; stop 0.1 × 5m ATR beyond the sweep extreme; the limit rests 120 min (24 × 5m); LATE at > 1R; pools from 15m bars closed by the 5m bar\'s close, taken by any 5m bar through them.');
  log();
  log('**Decision rules (fixed before any result):**');
  log(`- 5m variant: highest in-sample average net R (ties: the earlier-registered), run once out of sample.`);
  log(`- STRUCTURE_ENTRY_TF = '5m' only if, on the same out-of-sample dates and masks, 5m avg net R > the live 15m config's (${LIVE_15M.id}, closing guard ${CLOSING_GUARD_MIN}) AND 5m PF > 15m PF AND 5m has ≥ ${PROMOTE_5M_RULE.minOosTrades} trades. Otherwise '15m'.`);
  log(`- 15m closing guard: ${STRUCTURE_15M_CLOSING_VARIANTS.map((v) => v.id).join(' vs ')} on the 15m IN-SAMPLE period only (${inSample15.from} → ${inSample15.to}); highest average net R, ties keep 60.`);
  log(`- STRUCTURE_CLOSING_GUARD_MIN default = the closing guard chosen for the live timeframe.`);
  log();
  log('**Stated limits.** Results are in UNDERLYING R: there is no option-chain history, so Part A (strike by delta, cost ceiling, stop outside noise, expiry fallback) and the option leg are not in these numbers. LIMIT fills are conservative (at the limit, never better; a fill bar reaching the stop is a full loss; its target is not credited; T1 before any touch is MISSED). The 5m history is ~6 months, so the out-of-sample third is ~2 months.');
  log();
  log(`Excluded: ${missing.join('; ')}.`);
  log();

  // ---- the 5m data ----
  log('## 5m data (GET /api/market/historical, read-only)');
  log();
  log('| Snapshot | Bars | First bar | Last bar | Chunks | Suspect-truncated chunks |');
  log('|---|---:|---|---|---:|---:|');
  const snapNames = [...new Set(BACKTEST_SYMBOLS.flatMap((s) => [s.priceFile, ...(s.volumeFile ? [s.volumeFile] : [])]))];
  const snapshots: Record<string, unknown> = {};
  for (const name of snapNames) {
    const m = snapshotMeta(name);
    if (!m) {
      log(`| ${name} | — | — | — | — | — |`);
      continue;
    }
    snapshots[name] = m;
    log(`| ${name}.5m | ${m.count} | ${m.firstBar} | ${m.lastBar} | ${m.chunks.length} | ${m.suspectTruncatedChunks ?? m.chunks.filter((c) => c.suspectTruncated).length} |`);
  }
  log();

  // ---- In-sample: all four 5m variants ----
  const isRuns = STRUCTURE_5M_VARIANTS.map((variant) => {
    const run = runPeriod(loaded5, STRUCTURE_5M_STRATEGY, variant, inSample);
    return { variant, run, stats: statsOf(run.trades) };
  });
  log('## 5m in-sample, per variant (pooled across symbols)');
  log();
  log(HEADER);
  for (const r of isRuns) log(row(r.variant.id, r.run.trades));
  log();
  for (const r of isRuns) {
    log(`<details><summary>${r.variant.id} in-sample by symbol and setup funnel</summary>`);
    log();
    log(HEADER);
    log(row('Index (NIFTY, BANKNIFTY, SENSEX)', r.run.trades.filter((t) => INDEX.has(t.symbol))));
    log(row('MCX (CRUDEOIL, GOLD)', r.run.trades.filter((t) => !INDEX.has(t.symbol))));
    for (const g of grouped(r.run.trades, (t) => t.symbol)) log(row(g.key, g.trades));
    log();
    setupTable(r.run, log);
    log();
    log('</details>');
    log();
  }
  const chosen = chooseVariant(isRuns.map((r) => ({ variant: r.variant, stats: r.stats })));
  log(`**Chosen on in-sample average net R: ${chosen.id}** (DISP_MULT ${chosen.dispMult}, closing guard ${chosen.closingGuardMin} min, opening guard off).`);
  log();

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    window5m: { from: cal5[0], to: last15 },
    inSample,
    outOfSample,
    costR: COST_R,
    variants: STRUCTURE_5M_VARIANTS,
    decisionRules: {
      variant: 'highest in-sample avg net R; ties keep the earlier-registered',
      entryTimeframe: `5m only if OOS avgNetR5 > avgNetR15 AND PF5 > PF15 AND trades5 >= ${PROMOTE_5M_RULE.minOosTrades}, same OOS dates and masks, vs ${LIVE_15M.id} closing ${CLOSING_GUARD_MIN}`,
      closingGuard15m: `15m in-sample (${inSample15.from} → ${inSample15.to}) avg net R, ${STRUCTURE_15M_CLOSING_VARIANTS.map((v) => v.id).join(' vs ')}; ties keep 60`,
      closingGuardDefault: 'the choice for the live timeframe',
    },
    excluded: missing,
    maskNotes,
    snapshots,
    inSampleResults: isRuns.map((r) => ({
      variant: r.variant,
      ...summary(r.run.trades),
      index: summary(r.run.trades.filter((t) => INDEX.has(t.symbol))),
      mcx: summary(r.run.trades.filter((t) => !INDEX.has(t.symbol))),
      bySymbol: groupStats(r.run.trades, (t) => t.symbol),
      funnel: funnelJson(r.run),
    })),
    chosenVariant: chosen,
  };

  if (inSampleOnly) {
    log('(--in-sample-only: out-of-sample, head-to-head and closing-guard runs not done.)');
    writeFileSync(join(BACKTEST_DATA_DIR, 'structure-5m-report.insample.json'), JSON.stringify(report, null, 2));
    return;
  }

  // ---- Out-of-sample: the chosen 5m variant, once ----
  const oos = runPeriod(loaded5, STRUCTURE_5M_STRATEGY, chosen, outOfSample);
  const oosStats = statsOf(oos.trades);
  log(`## 5m out-of-sample — ${chosen.id}, run once`);
  log();
  log(HEADER);
  log(row('**All symbols**', oos.trades));
  log(row('Index (NIFTY, BANKNIFTY, SENSEX)', oos.trades.filter((t) => INDEX.has(t.symbol))));
  log(row('MCX (CRUDEOIL, GOLD)', oos.trades.filter((t) => !INDEX.has(t.symbol))));
  for (const g of grouped(oos.trades, (t) => t.symbol)) log(row(g.key, g.trades));
  log();
  log('### Setup funnel (early vs LATE vs MISSED)');
  log();
  const funnel = setupTable(oos, log);
  log();
  log(`Index setups placed out of sample: ${funnel.idx[2]} (${funnel.idx[6]} traded); MCX: ${funnel.mcx[2]} (${funnel.mcx[6]} traded). "Placed (early)" = confirmed with price still within 1R of the zone; LATE = already > 1R toward T1 at confirmation (never placed); MISSED = T1 reached before the limit filled; "Not placed (busy)" = confirmed while an earlier order or trade on that symbol was still open.`);
  log();
  for (const [title, key] of Object.entries(STRUCTURE_5M_STRATEGY.groupKeys)) {
    log(`### ${title}`);
    log();
    log(HEADER);
    for (const g of grouped(oos.trades, key)) log(row(String(g.key), g.trades));
    log();
  }
  const losers = oos.trades.filter((t) => t.netR < 0);
  log(`### Losing trades (${losers.length}) — characteristics`);
  log();
  const loserSlices: Array<[string, (t: StructureTrade) => string]> = [
    ['pool', (t) => t.signal.pool.kind],
    ['fill hour', (t) => String(t.fill?.hour ?? t.hour).padStart(2, '0')],
    ['direction', (t) => t.signal.direction],
    ['displacement', (t) => STRUCTURE_5M_STRATEGY.groupKeys['By displacement size'](t) as string],
    ['exit', (t) => t.exit],
  ];
  for (const [name, key] of loserSlices) {
    const parts = grouped(losers, key).map((g) => `${g.key} ${g.trades.length} (${fmtR(avg(g.trades.map((t) => t.netR)))})`);
    log(`- by ${name}: ${parts.join(', ') || '—'}`);
  }
  log(`- stopped before ever reaching +0.5R (false positives): ${oos.trades.filter(isFalsePositive).length} of ${oos.trades.length} trades.`);
  log();

  // ---- Head-to-head on the same OOS dates ----
  const h2h = runPeriod(h2h15, STRUCTURE_STRATEGY, LIVE_15M, outOfSample);
  const h2hStats = statsOf(h2h.trades);
  const decision = promote5m(oosStats, h2hStats);
  const entryTf: '5m' | '15m' = decision.promote ? '5m' : '15m';
  log(`## Head-to-head — ${outOfSample.from} → ${outOfSample.to}, same dates and masks`);
  log();
  log(HEADER);
  log(row(`**5m ${chosen.id}**`, oos.trades));
  log(row(`**15m ${LIVE_15M.id} (closing ${CLOSING_GUARD_MIN})**`, h2h.trades));
  log(row('5m — Index', oos.trades.filter((t) => INDEX.has(t.symbol))));
  log(row('15m — Index', h2h.trades.filter((t) => INDEX.has(t.symbol))));
  log(row('5m — MCX', oos.trades.filter((t) => !INDEX.has(t.symbol))));
  log(row('15m — MCX', h2h.trades.filter((t) => !INDEX.has(t.symbol))));
  log();
  log('<details><summary>15m setup funnel on the same dates</summary>');
  log();
  setupTable(h2h, log);
  log();
  log('</details>');
  log();
  const cmp = (a: string, b: string, ok: boolean) => `${a} ${ok ? '>' : '≤'} ${b}`;
  log(
    `Checks: avg net R ${cmp(fmtR(oosStats.avgNetR), fmtR(h2hStats.avgNetR), decision.checks.avgNetR)}; PF ${cmp(fmtPf(oosStats.profitFactor), fmtPf(h2hStats.profitFactor), decision.checks.pf)}; 5m trades ${oosStats.trades} ${decision.checks.trades ? '≥' : '<'} ${PROMOTE_5M_RULE.minOosTrades}.`
  );
  log();
  log(
    decision.promote
      ? `**5m WINS the pre-registered head-to-head → STRUCTURE_ENTRY_TF default '5m'.**`
      : `**5m does NOT beat 15m on the pre-registered rule → STRUCTURE_ENTRY_TF default '15m'** (5m ships OFF, behind the flag).`
  );
  log();

  // ---- 15m closing guard: in-sample only ----
  const cgRuns = STRUCTURE_15M_CLOSING_VARIANTS.map((variant) => {
    const run = runPeriod(loaded15, STRUCTURE_STRATEGY, variant, inSample15);
    return { variant, run, stats: statsOf(run.trades) };
  });
  const cgChosen = chooseVariant(cgRuns.map((r) => ({ variant: r.variant, stats: r.stats })));
  log(`## 15m closing guard — chosen on the 15m in-sample period only (${inSample15.from} → ${inSample15.to})`);
  log();
  log(HEADER);
  for (const r of cgRuns) log(row(r.variant.id, r.run.trades));
  log();
  log(`**Chosen: ${cgChosen.id}** (closing guard ${cgChosen.closingGuardMin} min).`);
  log();
  const cgOos = STRUCTURE_15M_CLOSING_VARIANTS.map((variant) => ({ variant, run: runPeriod(loaded15, STRUCTURE_STRATEGY, variant, outOfSample15) }));
  log(`For information only — ALREADY-SEEN data (the 15m out-of-sample period ${outOfSample15.from} → ${outOfSample15.to} was reported in the 15m structure backtest; it did not inform the choice):`);
  log();
  log(HEADER);
  for (const r of cgOos) log(row(`${r.variant.id} (seen)`, r.run.trades));
  log();

  const closingGuardDefault = entryTf === '5m' ? chosen.closingGuardMin! : cgChosen.closingGuardMin!;
  log('## Flag defaults');
  log();
  log(`- STRUCTURE_ENTRY_TF = '${entryTf}' (head-to-head ${decision.promote ? 'won' : 'not won'} by 5m).`);
  log(`- Closing guard: 5m → ${chosen.closingGuardMin} min (in the chosen 5m variant); 15m → ${cgChosen.closingGuardMin} min (15m in-sample choice).`);
  log(`- STRUCTURE_CLOSING_GUARD_MIN = ${closingGuardDefault} (the choice for the live timeframe, ${entryTf}). The consensus engine keeps its 60-minute closing guard.`);
  log();

  // ---- Detection lead time ----
  const whole: ReplayWindow = { from: cal5[0], to: last15 };
  const leadAll = leadTimes(loaded5, h2h15, chosen, LIVE_15M, whole);
  const leadOos = leadTimes(loaded5, h2h15, chosen, LIVE_15M, outOfSample);
  log('## Detection lead time — 5m vs 15m, the same pool sweeps');
  log();
  log(`Matching: ${leadAll.method}.`);
  log();
  log('| Window | 15m sweeps | 5m sweeps | Matched | Sweep lead mean (min) | median | 5m earlier / same / later | Both confirmed | Confirm lead mean (min) | median | 5m-only confirms | 15m-only confirms |');
  log('|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|');
  for (const [label, L] of [[`Whole 5m window ${whole.from} → ${whole.to}`, leadAll], [`Out-of-sample ${outOfSample.from} → ${outOfSample.to}`, leadOos]] as const) {
    const f = (n: number | null) => (n == null ? '—' : n.toFixed(1));
    log(`| ${label} | ${L.sweeps15} | ${L.sweeps5} | ${L.matched} | ${f(L.sweep.mean)} | ${f(L.sweep.median)} | ${L.sweep.earlier5} / ${L.sweep.same} / ${L.sweep.later5} | ${L.confirmBoth} | ${f(L.confirm.mean)} | ${f(L.confirm.median)} | ${L.confirmed5Only} | ${L.confirmed15Only} |`);
  }
  log();

  // ---- Named cases ----
  const crude5 = loaded5.find((l) => l.spec.symbol === 'CRUDEOIL');
  const crude15 = h2h15.find((l) => l.spec.symbol === 'CRUDEOIL') ?? null;
  log('## Named case — 28 Sep 2026 CRUDEOIL, 21:00–22:00 IST (5m)');
  log();
  const crudeCase = crude5 ? namedCase5(crude5, crude15, chosen, '2026-09-28', '21:00', '22:00', oos.trades) : { lines: ['CRUDEOIL 5m snapshot missing.'], data: null };
  for (const l of crudeCase.lines) log(l);
  log();
  log('## Named case — 29 Sep 2026 NIFTY opening fall (22,732 → 22,570) (5m)');
  log();
  const nifty5 = loaded5.find((l) => l.spec.symbol === 'NIFTY');
  const nifty15 = h2h15.find((l) => l.spec.symbol === 'NIFTY');
  const n15ext = nifty15 ? nifty15With29Sep(nifty15) : null;
  const niftyCase =
    nifty5 && n15ext && nifty5.series.sessionDates.includes('2026-09-29')
      ? namedCase5({ ...nifty5, poolSeries: n15ext.series }, n15ext, chosen, '2026-09-29', '09:15', '11:00', null)
      : { lines: ['The 29 Sep NIFTY bars (5m, or the 15m NIFTY_INDEX.2026-09-29.json for pools) are not in backtest-data — not evaluated.'], data: null };
  for (const l of niftyCase.lines) log(l);
  log();

  report.outOfSample = {
    ...outOfSample,
    variant: chosen,
    ...summary(oos.trades),
    index: summary(oos.trades.filter((t) => INDEX.has(t.symbol))),
    mcx: summary(oos.trades.filter((t) => !INDEX.has(t.symbol))),
    bySymbol: groupStats(oos.trades, (t) => t.symbol),
    byGroup: Object.fromEntries(Object.entries(STRUCTURE_5M_STRATEGY.groupKeys).map(([k, f]) => [k, groupStats(oos.trades, f)])),
    funnel: funnelJson(oos),
    unfilled: oos.unfilled.map((u) => ({ symbol: u.symbol, decidedAt: u.decidedAt, outcome: u.outcome, id: u.signal.id })),
  };
  report.headToHead = {
    window: outOfSample,
    fiveMinute: { variant: chosen, ...summary(oos.trades), index: summary(oos.trades.filter((t) => INDEX.has(t.symbol))), mcx: summary(oos.trades.filter((t) => !INDEX.has(t.symbol))) },
    fifteenMinute: { variant: LIVE_15M, closingGuardMin: CLOSING_GUARD_MIN, ...summary(h2h.trades), index: summary(h2h.trades.filter((t) => INDEX.has(t.symbol))), mcx: summary(h2h.trades.filter((t) => !INDEX.has(t.symbol))), funnel: funnelJson(h2h) },
    checks: decision.checks,
    promote5m: decision.promote,
  };
  report.closingGuard15m = {
    inSample: inSample15,
    results: cgRuns.map((r) => ({ variant: r.variant, ...summary(r.run.trades) })),
    chosen: cgChosen,
    outOfSampleAlreadySeen: { window: outOfSample15, results: cgOos.map((r) => ({ variant: r.variant, ...summary(r.run.trades) })) },
  };
  report.flagDefaults = { STRUCTURE_ENTRY_TF: entryTf, STRUCTURE_CLOSING_GUARD_MIN: closingGuardDefault, closingGuard5m: chosen.closingGuardMin, closingGuard15m: cgChosen.closingGuardMin };
  report.leadTime = { whole: { window: whole, ...leadAll }, outOfSample: { window: outOfSample, ...leadOos } };
  report.namedCases = { crude28Sep: crudeCase.data, nifty29Sep: niftyCase.data };
  report.oosTrades = oos.trades.map((t) => ({ ...t, signal: { ...t.signal, history: undefined } }));
  report.h2h15Trades = h2h.trades.map((t) => ({ ...t, signal: { ...t.signal, history: undefined } }));
  writeFileSync(join(BACKTEST_DATA_DIR, 'structure-5m-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'structure-5m-report.md'), lines.join('\n'));
  console.log(`\nWrote ${join(BACKTEST_DATA_DIR, 'structure-5m-report.md')}`);
}

try {
  main();
} catch (err: any) {
  console.error('Structure 5m backtest failed:', err);
  process.exit(1);
}
