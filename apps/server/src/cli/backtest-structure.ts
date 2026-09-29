// ============================================================
// CLI: structure-engine backtest
// ============================================================
// npm run backtest-structure --workspace=@fno/server [-- --in-sample-only]
//
// The same protocol as backtest-momentum, on the same snapshots:
//   1. chronological split of the NIFTY session calendar, first ⅔ in-sample;
//   2. the four pre-registered variants (DISP_MULT {1.0, 1.5} × opening
//      guard {on, off}) run on the in-sample period only;
//   3. one chosen by in-sample average net R (ties: the earlier-registered);
//   4. THAT variant run once on the out-of-sample ⅓;
//   5. judged against the pre-registered go-live bar (≥ 30 trades, avg net R
//      ≥ +0.10, PF ≥ 1.2). The bar decides CONSENSUS_SETUPS: OFF when the
//      structure engine passes (it replaces the consensus engine's mints),
//      ON when it fails (both run).
// 0.1R cost per trade. Results are in UNDERLYING R — option premiums cannot
// be backtested (no option-chain history before 21 Sep 2026).
// Writes structure-report.json / structure-report.md next to the snapshots.
// ============================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateStructureSession, istSlotOf, prepareMomentumSeries, STRUCTURE_VARIANTS, type MomentumBar, type StructureSetup, type StructureVariant } from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import {
  BACKTEST_SYMBOLS,
  borrowVolume,
  chooseVariant,
  COST_R,
  GO_LIVE_BAR,
  groupStats,
  loadSymbol,
  passesGoLiveBar,
  replayStrategy,
  sessionMasks,
  splitDate,
  statsOf,
  type LoadedSymbol,
  type ReplayWindow,
  type TradeStats,
  type UnfilledOrder,
} from '../backtest/harness.js';
import { countSetups, isFalsePositive, sessionSetups, STRUCTURE_STRATEGY, type StructureTrade } from '../backtest/structure-backtest.js';

const inSampleOnly = process.argv.includes('--in-sample-only');
const INDEX = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);

const fmtR = (n: number | null | undefined) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(3));
const fmtPct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtPf = (n: number | null) => (n == null ? '—' : n === Infinity ? '∞' : n.toFixed(2));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
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

interface PeriodRun {
  trades: StructureTrade[];
  unfilled: UnfilledOrder<StructureSetup>[];
  /** Engine setups on non-masked sessions inside the window, per symbol. */
  setups: Map<string, StructureSetup[]>;
}

function runPeriod(loaded: LoadedSymbol[], variant: StructureVariant, window: ReplayWindow): PeriodRun {
  const trades: StructureTrade[] = [];
  const unfilled: UnfilledOrder<StructureSetup>[] = [];
  const setups = new Map<string, StructureSetup[]>();
  for (const l of loaded) {
    const r = replayStrategy(l, STRUCTURE_STRATEGY, variant, window);
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

function main() {
  const loaded: LoadedSymbol[] = [];
  const missing: string[] = ['FINNIFTY (no snapshot fetched — not backtested)'];
  for (const spec of BACKTEST_SYMBOLS) {
    const l = loadSymbol(BACKTEST_DATA_DIR, spec);
    if (l) loaded.push(l);
    else missing.push(`${spec.symbol} (snapshot missing)`);
  }
  if (loaded.length === 0) throw new Error(`No snapshots in ${BACKTEST_DATA_DIR} — run fetch-history.ts first`);

  const calendar = loaded.find((l) => l.spec.symbol === 'NIFTY') ?? loaded[0];
  const dates = calendar.series.sessionDates;
  const oosFrom = splitDate(dates);
  const first = dates[0];
  const last = [...loaded.flatMap((l) => l.series.sessionDates)].sort().at(-1)!;
  const dayBefore = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const inSample = { from: first, to: dayBefore(oosFrom) };
  const outOfSample = { from: oosFrom, to: last };

  const lines: string[] = [];
  const log = (s = '') => { lines.push(s); console.log(s); };

  log('# Structure-engine backtest (sweep → displacement → FVG retrace)');
  log();
  log(`In-sample ${inSample.from} → ${inSample.to}; out-of-sample ${outOfSample.from} → ${outOfSample.to} (chronological ⅔ / ⅓ of the ${calendar.spec.symbol} session calendar — the same split, masks and cost as the momentum-break backtest).`);
  log(`Cost ${COST_R}R per trade deducted. Go-live bar (pre-registered, unchanged): OOS ≥ ${GO_LIVE_BAR.minTrades} trades, avg net R ≥ +${GO_LIVE_BAR.minAvgNetR}, PF ≥ ${GO_LIVE_BAR.minProfitFactor}.`);
  log(`Variants (pre-registered): ${STRUCTURE_VARIANTS.map((v) => `${v.id} (DISP_MULT ${v.dispMult}, opening guard ${v.openingGuard ? 'on' : 'off'})`).join('; ')}.`);
  log();
  log('**Stated limits.** Results are in UNDERLYING R: option premium behaviour cannot be backtested (no option-chain history before 21 Sep 2026), so Part A (strike by delta, cost ceiling, stop outside noise, expiry fallback) and the option leg are not in these numbers. Tier-2 score inputs (intraday positioning, OI walls) have no history and are not used here — the score never gates anyway. The consensus engine cannot be replayed historically; its only comparison is its live paper record (225 setups, PF 1.04). LIMIT fills are conservative: the fill is at the limit (never better), a fill bar that reaches the stop is a full loss, a fill bar\'s target is not credited, and a bar reaching T1 before any touch is MISSED.');
  log();
  log(`Excluded: ${missing.join('; ')}.`);
  log();

  // ---- In-sample: all four variants ----
  const isRuns = STRUCTURE_VARIANTS.map((variant) => {
    const run = runPeriod(loaded, variant, inSample);
    return { variant, run, stats: statsOf(run.trades) };
  });
  log('## In-sample, per variant (pooled across symbols)');
  log();
  log(HEADER);
  for (const r of isRuns) log(row(r.variant.id, r.run.trades));
  log();
  for (const r of isRuns) {
    log(`<details><summary>${r.variant.id} in-sample by symbol and setup funnel</summary>`);
    log();
    log(HEADER);
    for (const g of grouped(r.run.trades, (t) => t.symbol)) log(row(g.key, g.trades));
    log();
    setupTable(r.run, log);
    log();
    log('</details>');
    log();
  }
  const chosen = chooseVariant(isRuns.map((r) => ({ variant: r.variant, stats: r.stats })));
  log(`**Chosen on in-sample average net R: ${chosen.id}** (DISP_MULT ${chosen.dispMult}, opening guard ${chosen.openingGuard ? 'on' : 'off'}).`);
  log();

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    inSample,
    outOfSample,
    costR: COST_R,
    goLiveBar: GO_LIVE_BAR,
    variants: STRUCTURE_VARIANTS,
    excluded: missing,
    inSampleResults: isRuns.map((r) => ({
      variant: r.variant,
      stats: r.stats,
      bySymbol: groupStats(r.run.trades, (t) => t.symbol),
      setups: Object.fromEntries([...r.run.setups].map(([k, v]) => [k, countSetups(v)])),
    })),
    chosenVariant: chosen,
  };

  if (inSampleOnly) {
    log('(--in-sample-only: out-of-sample not run.)');
    writeFileSync(join(BACKTEST_DATA_DIR, 'structure-report.insample.json'), JSON.stringify(report, null, 2));
    return;
  }

  // ---- Out-of-sample: the chosen variant, once ----
  const oos = runPeriod(loaded, chosen, outOfSample);
  const oosStats = statsOf(oos.trades);
  const passes = passesGoLiveBar(oosStats);
  log(`## Out-of-sample — ${chosen.id}, run once`);
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
  log(`Index setups placed out of sample: ${funnel.idx[2]} (${funnel.idx[6]} traded). "Placed (early)" = confirmed with price still within 1R of the zone; LATE = already > 1R toward T1 at confirmation (never placed); MISSED = T1 reached before the limit filled; "Not placed (busy)" = confirmed while an earlier order or trade on that symbol was still open.`);
  log();
  for (const [title, key] of Object.entries(STRUCTURE_STRATEGY.groupKeys)) {
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
    ['displacement', (t) => STRUCTURE_STRATEGY.groupKeys['By displacement size'](t) as string],
    ['exit', (t) => t.exit],
  ];
  for (const [name, key] of loserSlices) {
    const parts = grouped(losers, key).map((g) => `${g.key} ${g.trades.length} (${fmtR(avg(g.trades.map((t) => t.netR)))})`);
    log(`- by ${name}: ${parts.join(', ') || '—'}`);
  }
  log(`- stopped before ever reaching +0.5R (false positives): ${oos.trades.filter(isFalsePositive).length} of ${oos.trades.length} trades.`);
  log();

  log('## Go-live decision');
  log();
  const checks = [
    `trades ${oosStats.trades} ${oosStats.trades >= GO_LIVE_BAR.minTrades ? '≥' : '<'} ${GO_LIVE_BAR.minTrades}`,
    `avg net R ${fmtR(oosStats.avgNetR)} ${(oosStats.avgNetR ?? -Infinity) >= GO_LIVE_BAR.minAvgNetR ? '≥' : '<'} +${GO_LIVE_BAR.minAvgNetR}`,
    `PF ${fmtPf(oosStats.profitFactor)} ${(oosStats.profitFactor ?? -Infinity) >= GO_LIVE_BAR.minProfitFactor ? '≥' : '<'} ${GO_LIVE_BAR.minProfitFactor}`,
  ];
  log(`Out-of-sample: ${checks.join('; ')}.`);
  log();
  log(
    passes
      ? '**PASS.** The structure engine meets the pre-registered bar, so it replaces the consensus engine as the minting family: CONSENSUS_SETUPS ships default OFF (the consensus engine still computes bias and votes as context). STRUCTURE ships ON, as decided.'
      : '**FAIL.** The out-of-sample result does not meet the pre-registered bar, so the consensus engine keeps minting: CONSENSUS_SETUPS ships default ON and both families run. STRUCTURE still ships ON, as decided (live now, behind its flag).'
  );
  log();

  // ---- Named cases ----
  const crude = loaded.find((l) => l.spec.symbol === 'CRUDEOIL');
  log('## Named case — 28 Sep 2026 CRUDEOIL, 21:00–22:00 IST');
  log();
  const crudeCase = crude ? namedCase(crude, chosen, '2026-09-28', '21:00', '22:00', oos.trades) : { lines: ['CRUDEOIL snapshot missing.'], data: null };
  for (const l of crudeCase.lines) log(l);
  log();
  log('## Named case — 29 Sep 2026 NIFTY opening fall (22,732 → 22,570)');
  log();
  const nifty29 = loadNiftyWith29Sep(loaded.find((l) => l.spec.symbol === 'NIFTY'));
  const niftyCase = nifty29 ? namedCase(nifty29, chosen, '2026-09-29', '09:15', '11:00', null) : { lines: ['The 29 Sep NIFTY bars are not in backtest-data (NIFTY_INDEX.2026-09-29.json) — not evaluated.'], data: null };
  for (const l of niftyCase.lines) log(l);
  log();

  report.outOfSample = {
    ...outOfSample,
    variant: chosen,
    stats: oosStats,
    bySymbol: groupStats(oos.trades, (t) => t.symbol),
    byGroup: Object.fromEntries(Object.entries(STRUCTURE_STRATEGY.groupKeys).map(([k, f]) => [k, groupStats(oos.trades, f)])),
    avgMfeR: avg(oos.trades.map((t) => t.mfeR ?? 0)),
    avgMaeR: avg(oos.trades.map((t) => t.maeR ?? 0)),
    falsePositiveRate: oos.trades.length ? oos.trades.filter(isFalsePositive).length / oos.trades.length : null,
    setups: Object.fromEntries([...oos.setups].map(([k, v]) => [k, countSetups(v)])),
    unfilled: oos.unfilled.map((u) => ({ symbol: u.symbol, decidedAt: u.decidedAt, outcome: u.outcome, id: u.signal.id })),
  };
  report.decision = { passes, consensusSetupsDefault: !passes, structureDefault: true };
  report.namedCases = { crude28Sep: crudeCase.data, nifty29Sep: niftyCase.data };
  report.oosTrades = oos.trades.map((t) => ({ ...t, signal: { ...t.signal, history: undefined } }));
  writeFileSync(join(BACKTEST_DATA_DIR, 'structure-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'structure-report.md'), lines.join('\n'));
  console.log(`\nWrote ${join(BACKTEST_DATA_DIR, 'structure-report.md')}`);
}

/** NIFTY history plus the 29 Sep bars fetched for this case only (volume from the Sep future). */
function loadNiftyWith29Sep(nifty: LoadedSymbol | undefined): LoadedSymbol | null {
  if (!nifty) return null;
  const read = (name: string) => {
    const file = join(BACKTEST_DATA_DIR, `${name}.2026-09-29.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).bars as Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>) : null;
  };
  const px = read('NIFTY_INDEX');
  const vol = read('NIFTY_FUT');
  if (!px) return null;
  const toBars = (bs: NonNullable<typeof px>): MomentumBar[] => bs.map((b) => ({ time: Date.parse(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const extra = vol ? borrowVolume(toBars(px), toBars(vol)) : toBars(px);
  const lastTime = nifty.series.bars[nifty.series.bars.length - 1].time;
  const bars = [...nifty.series.bars, ...extra.filter((b) => b.time > lastTime)];
  const series = prepareMomentumSeries(bars);
  return { ...nifty, series, ...sessionMasks(series, false) };
}

function namedCase(l: LoadedSymbol, variant: StructureVariant, date: string, from: string, to: string, oosTrades: StructureTrade[] | null) {
  const lines: string[] = [];
  const { series } = l;
  const s = series.sessionDates.indexOf(date);
  if (s < 0) return { lines: [`No ${date} session in the ${l.spec.symbol} data.`], data: null };
  const start = series.sessionStarts[s];
  const end = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  lines.push(`Masked session: ${l.masked.get(date) ?? 'no'}. Variant ${variant.id}.`);
  lines.push('');
  lines.push('| Bar (IST) | O | H | L | C | ATR | Bearish stage | Bullish stage | WATCH pool (bear / bull) |');
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
    const ev = evaluateStructureSession(series, i, variant);
    const b = series.bars[i];
    const w = `${ev.watch.BEARISH ? `${ev.watch.BEARISH.kind} ${ev.watch.BEARISH.price}` : '—'} / ${ev.watch.BULLISH ? `${ev.watch.BULLISH.kind} ${ev.watch.BULLISH.price}` : '—'}`;
    lines.push(`| ${slot}–${istSlotOf(b.time + 15 * 60000)} | ${b.open} | ${b.high} | ${b.low} | ${b.close} | ${ev.atr ?? '—'} | ${stageOf(ev.setups, 'BEARISH', i)} | ${stageOf(ev.setups, 'BULLISH', i)} | ${w} |`);
    rows.push({ slot, bearish: stageOf(ev.setups, 'BEARISH', i), bullish: stageOf(ev.setups, 'BULLISH', i), watch: w });
  }
  lines.push('');
  // Data anomalies in the session (a bar spanning > 5 ATR), named so a
  // "sweep" made of a bad print is not read as a market event.
  for (let i = start; i <= end; i++) {
    const b = series.bars[i];
    const a = evaluateStructureSession(series, i, variant).atr;
    if (a != null && b.high - b.low > 5 * a) {
      lines.push(`Data anomaly: the ${istSlotOf(b.time)} bar spans ${round2(b.high - b.low)} points (${round2((b.high - b.low) / a)} ATR; O ${b.open} H ${b.high} L ${b.low} C ${b.close}) — most likely a bad print; any setup built on it is not a market event.`);
    }
  }
  const day = sessionSetups(l, s, variant);
  if (day.length === 0) lines.push('No sweep of a Tier-1 pool that day.');
  for (const st of day) {
    lines.push(
      `- ${st.direction} ${st.pool.kind} ${st.pool.price} swept at ${istSlotOf(st.sweep.barTime)} (${st.sweep.bars}-bar, extreme ${round2(st.sweep.extreme)}, depth ${st.sweep.depthAtr} ATR)` +
        (st.displacement ? `; displacement ${istSlotOf(st.displacement.barTime)} ${st.displacement.bodyAtr} ATR${st.displacement.structureShift ? ' + structure shift' : ''}` : '') +
        (st.zone ? `; zone ${st.zone.kind} ${st.zone.near}–${st.zone.far}, entry ${st.entry}, stop ${st.stop}, T1 ${st.t1 ? `${st.t1.kind} ${st.t1.price} (${st.rToT1}R)` : '—'}` : '') +
        ` → ${st.history.map((h) => `${h.stage}@${istSlotOf(series.bars[h.barIndex].time + 15 * 60000)}${h.reason ? `(${h.reason})` : ''}`).join(' → ')}` +
        (st.score ? `; score ${st.score.total}` : '')
    );
  }
  // What the harness does with that day (same guards and fills as the statistics).
  const r = replayStrategy(l, STRUCTURE_STRATEGY, variant, { from: date, to: date });
  lines.push('');
  if (r.trades.length === 0 && r.unfilled.length === 0) lines.push('The harness placed no order that day.');
  for (const t of r.trades) lines.push(`Harness trade: ${t.signal.direction} filled ${t.fill ? istSlotOf(Date.parse(t.fill.at)) : '?'} at ${t.fill?.price}, exit ${t.exit} ${t.exitPrice} (${istSlotOf(Date.parse(t.exitAt))}): ${fmtR(t.grossR)}R gross, ${fmtR(t.netR)}R net.`);
  for (const u of r.unfilled) lines.push(`Harness order not filled: ${u.signal.direction} confirmed ${istSlotOf(Date.parse(u.decidedAt))} → ${u.outcome}.`);
  if (oosTrades) {
    const inOos = oosTrades.filter((t) => t.symbol === l.spec.symbol && t.date === date);
    lines.push(inOos.length ? `In the out-of-sample statistics: ${inOos.length} trade(s) that day.` : 'Not in the out-of-sample trade list that day.');
  } else {
    lines.push('(29 Sep is after the snapshot the statistics were computed on — this case is shown for reference, not counted.)');
  }
  return { lines, data: { rows, setups: day.map((x) => ({ ...x, history: x.history })), harness: { trades: r.trades, unfilled: r.unfilled.map((u) => ({ outcome: u.outcome, decidedAt: u.decidedAt })) } } };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

try {
  main();
} catch (err: any) {
  console.error('Structure backtest failed:', err);
  process.exit(1);
}
