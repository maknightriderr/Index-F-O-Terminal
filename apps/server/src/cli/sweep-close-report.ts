// ============================================================
// CLI: SWEEP_CLOSE pre-registered clean re-test (research only, read-only)
// ============================================================
// npm run sweep-close-report --workspace=@fno/server
//
// Builds apps/server/backtest-data/sweep-close-report.{md,json}. Touches no
// live trading code path, flag or gate. See:
//   - apps/server/src/research/sweep-close.ts   (trigger, entry, stop, T1,
//     execution rules — the pre-registered geometry)
//   - apps/server/src/research/option-cost.ts   (the modelled per-trade
//     option cost, every assumption listed there)
//   - the approved plan, Stage 1, for the pre-registered pass bar.
//
// Run `fetch-india-vix.ts` and `fetch-option-chain-calibration.ts` first (or
// let this script use whatever is already cached in backtest-data/ — it
// never fetches anything itself).
// ============================================================

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKTEST_SYMBOLS, loadSymbol, splitDate } from '../backtest/harness.js';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { runSweepClose, type SweepCloseRow } from '../research/sweep-close.js';
import { computeOptionCost, hv20, type ChainCalibration } from '../research/option-cost.js';
import { round, mean, percentile } from '../research/stats.js';

const FLAT_COST_R = 0.1;
const GROUPS: Record<string, string[]> = { INDEX: ['NIFTY', 'BANKNIFTY', 'SENSEX'], MCX: ['CRUDEOIL', 'GOLD'] };

interface Graded extends SweepCloseRow {
  netFlatR: number;
  netModelledR: number | null;
  costR: number | null;
  liveWouldRefuse: boolean | null;
  refuseReason: string | null;
  premium: number | null;
  dte: number | null;
  sortKey: number; // trigger bar time, ms
}

function loadVix(): Map<string, number> {
  const file = join(BACKTEST_DATA_DIR, 'INDIAVIX.json');
  if (!existsSync(file)) return new Map();
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map<string, number>();
  for (const b of data.bars ?? []) map.set(String(b.timestamp).slice(0, 10), b.close);
  return map;
}

function nearestOnOrBefore(map: Map<string, number>, date: string): number | null {
  if (map.has(date)) return map.get(date)!;
  const keys = [...map.keys()].filter((k) => k <= date).sort();
  return keys.length ? map.get(keys[keys.length - 1])! : null;
}

function loadChainCalibration(): Record<string, ChainCalibration & { note?: string }> {
  const file = join(BACKTEST_DATA_DIR, 'option-chain-calibration.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function statsOf(rows: Graded[], rKey: 'netFlatR' | 'netModelledR' | 'grossR') {
  const vals = rows.map((r) => r[rKey]).filter((v): v is number => v != null);
  const n = vals.length;
  if (n === 0) return { trades: 0, winRate: null, avgR: null, profitFactor: null, expectancy: null, avgWinner: null, avgLoser: null, maxDrawdownR: null, maxConsecLosses: null, lowN: true };
  const wins = vals.filter((v) => v > 0);
  const losses = vals.filter((v) => v <= 0);
  const gains = wins.reduce((a, b) => a + b, 0);
  const lossSum = losses.reduce((a, b) => a - b, 0);
  // Chronological for drawdown / consecutive losses.
  const chrono = [...rows].filter((r) => r[rKey] != null).sort((a, b) => a.sortKey - b.sortKey);
  let cum = 0, peak = 0, maxDD = 0, consec = 0, maxConsec = 0;
  for (const r of chrono) {
    cum += r[rKey] as number;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    if ((r[rKey] as number) <= 0) { consec++; maxConsec = Math.max(maxConsec, consec); } else consec = 0;
  }
  return {
    trades: n,
    winRate: round(wins.length / n),
    avgR: round(mean(vals)),
    profitFactor: lossSum > 0 ? round(gains / lossSum) : gains > 0 ? Infinity : null,
    expectancy: round(mean(vals)),
    avgWinner: wins.length ? round(mean(wins)) : null,
    avgLoser: losses.length ? round(mean(losses)) : null,
    maxDrawdownR: round(maxDD),
    maxConsecLosses: maxConsec,
    lowN: n < 30,
  };
}

function extraStats(rows: Graded[]) {
  const n = rows.length;
  const mfe = rows.map((r) => r.mfeR);
  const mae = rows.map((r) => r.maeR);
  const bars = rows.map((r) => r.barsHeld);
  const stopAtr = rows.map((r) => r.stopAtr);
  const stopPts = rows.map((r) => r.stopPoints);
  const rToT1 = rows.map((r) => r.rToT1).filter((v): v is number => v != null);
  const refuseCount = rows.filter((r) => r.liveWouldRefuse === true).length;
  const refuseByReason: Record<string, number> = {};
  for (const r of rows) if (r.refuseReason) refuseByReason[r.refuseReason] = (refuseByReason[r.refuseReason] ?? 0) + 1;
  return {
    avgMfeR: n ? round(mean(mfe)) : null,
    avgMaeR: n ? round(mean(mae)) : null,
    avgBarsHeld: n ? round(mean(bars), 1) : null,
    stopAtr: { p25: round(percentile(stopAtr, 25)), p50: round(percentile(stopAtr, 50)), p75: round(percentile(stopAtr, 75)) },
    stopPoints: { p25: round(percentile(stopPts, 25), 2), p50: round(percentile(stopPts, 50), 2), p75: round(percentile(stopPts, 75), 2) },
    rToT1: rToT1.length ? { p25: round(percentile(rToT1, 25)), p50: round(percentile(rToT1, 50)), p75: round(percentile(rToT1, 75)) } : null,
    liveWouldRefusePct: n ? round(refuseCount / n) : null,
    liveWouldRefuseCount: refuseCount,
    refuseByReason,
  };
}

function group(rows: Graded[], pred: (r: Graded) => boolean) {
  return rows.filter(pred);
}

function monthAdd(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function walkForwardWindows(firstSession: string, lastSession: string): Array<{ testStart: string; testEnd: string }> {
  const windows: Array<{ testStart: string; testEnd: string }> = [];
  let testStart = monthAdd(firstSession, 4);
  while (testStart < lastSession) {
    const testEnd = monthAdd(testStart, 2);
    windows.push({ testStart, testEnd: testEnd > lastSession ? lastSession : testEnd });
    testStart = monthAdd(testStart, 2);
  }
  return windows;
}

async function main() {
  const vix = loadVix();
  const chainCal = loadChainCalibration();
  // SENSEX has no live NSE/BSE-index-option bid/ask at calibration time
  // (assumption, stated in the report): fall back to NIFTY's spread% as the
  // nearest liquidity-tier proxy (same asset class, index options).
  if (chainCal.SENSEX && (chainCal.SENSEX.spreadPct == null || Number.isNaN(chainCal.SENSEX.spreadPct)) && chainCal.NIFTY) {
    chainCal.SENSEX = { ...chainCal.SENSEX, spreadPct: chainCal.NIFTY.spreadPct, note: 'ASSUMPTION: BSE/SENSEX chain had no live bid/ask at calibration time; using NIFTY spread% as the nearest liquidity-tier proxy' };
  }

  const bySymbol = new Map<string, ReturnType<typeof loadSymbol>>();
  for (const spec of BACKTEST_SYMBOLS) bySymbol.set(spec.symbol, loadSymbol(BACKTEST_DATA_DIR, spec));
  const nifty = bySymbol.get('NIFTY');
  if (!nifty) throw new Error('NIFTY snapshot required for the IS/OOS calendar split');
  const splitAt = splitDate(nifty.series.sessionDates);
  const firstSession = [...nifty.series.sessionDates].sort()[0];
  const lastSession = [...nifty.series.sessionDates].sort().slice(-1)[0];
  const windows = walkForwardWindows(firstSession, lastSession);

  const allRows: Graded[] = [];
  const skippedCostSymbols = new Set<string>();

  for (const spec of BACKTEST_SYMBOLS) {
    const loaded = bySymbol.get(spec.symbol);
    if (!loaded) continue;
    const rows = runSweepClose(spec.symbol, loaded, spec.exchange);
    // Daily closes (session-end close) for HV20, needed by SENSEX/CRUDEOIL/GOLD.
    const dailyCloses: number[] = [];
    const nSessions = loaded.series.sessionStarts.length;
    for (let s = 0; s < nSessions; s++) {
      const end = (s + 1 < nSessions ? loaded.series.sessionStarts[s + 1] : loaded.series.bars.length) - 1;
      dailyCloses.push(loaded.series.bars[end].close);
    }
    const sessionOrdinal = new Map<string, number>();
    loaded.series.sessionDates.forEach((d, i) => sessionOrdinal.set(d, i));

    const chain = chainCal[spec.symbol];
    for (const r of rows) {
      const netFlatR = round(r.grossR - FLAT_COST_R);
      let netModelledR: number | null = null;
      let costR: number | null = null;
      let liveWouldRefuse: boolean | null = null;
      let refuseReason: string | null = null;
      let premium: number | null = null;
      let dte: number | null = null;

      let sigma: number | null = null;
      if (spec.symbol === 'NIFTY' || spec.symbol === 'BANKNIFTY') {
        const vixClose = nearestOnOrBefore(vix, r.session);
        if (vixClose != null) sigma = (vixClose / 100) * (spec.symbol === 'NIFTY' ? 1.0 : 1.25);
      } else {
        const idx = sessionOrdinal.get(r.session);
        if (idx != null) {
          const h = hv20(dailyCloses, idx);
          if (h != null) sigma = h * 1.1;
        }
      }

      if (sigma != null && chain && Number.isFinite(chain.spreadPct)) {
        const cost = computeOptionCost({
          symbol: spec.symbol,
          session: r.session,
          spot: r.entry,
          atr: r.atr,
          stopPoints: r.stopPoints,
          direction: r.direction,
          sigma,
          chain,
        });
        netModelledR = round(r.grossR - cost.costR);
        costR = cost.costR;
        liveWouldRefuse = cost.liveWouldRefuse;
        refuseReason = cost.refuseReason;
        premium = cost.premium;
        dte = cost.dte;
      } else {
        skippedCostSymbols.add(spec.symbol);
      }

      allRows.push({ ...r, netFlatR, netModelledR, costR, liveWouldRefuse, refuseReason, premium, dte, sortKey: r.triggerBarTime });
    }
  }

  const trades = allRows.filter((r) => r.bucket === 'TRADE');
  const rejected = allRows.filter((r) => r.bucket !== 'TRADE');

  const groupReport = (rows: Graded[]) => ({
    flat: statsOf(rows, 'netFlatR'),
    modelled: statsOf(rows.filter((r) => r.netModelledR != null), 'netModelledR'),
    gross: statsOf(rows, 'grossR'),
    extra: extraStats(rows),
  });

  const perSymbolIS: Record<string, unknown> = {};
  const perSymbolOOS: Record<string, unknown> = {};
  for (const spec of BACKTEST_SYMBOLS) {
    const symRows = trades.filter((r) => r.symbol === spec.symbol);
    perSymbolIS[spec.symbol] = groupReport(symRows.filter((r) => r.session < splitAt));
    perSymbolOOS[spec.symbol] = groupReport(symRows.filter((r) => r.session >= splitAt));
  }

  const perGroupIS: Record<string, unknown> = {};
  const perGroupOOS: Record<string, unknown> = {};
  const perGroupWindows: Record<string, Array<{ window: { testStart: string; testEnd: string }; stats: ReturnType<typeof groupReport> }>> = {};
  for (const [g, symbols] of Object.entries(GROUPS)) {
    const gRows = trades.filter((r) => symbols.includes(r.symbol));
    perGroupIS[g] = groupReport(gRows.filter((r) => r.session < splitAt));
    perGroupOOS[g] = groupReport(gRows.filter((r) => r.session >= splitAt));
    perGroupWindows[g] = windows.map((w) => ({ window: w, stats: groupReport(gRows.filter((r) => r.session >= w.testStart && r.session < w.testEnd)) }));
  }

  const rejectedBySymbol: Record<string, unknown> = {};
  for (const spec of BACKTEST_SYMBOLS) {
    const rRows = rejected.filter((r) => r.symbol === spec.symbol);
    rejectedBySymbol[spec.symbol] = {
      lowRr: groupReport(rRows.filter((r) => r.bucket === 'LOW_RR')),
      noTarget: groupReport(rRows.filter((r) => r.bucket === 'NO_TARGET')),
    };
  }

  const displacementSplit: Record<string, unknown> = {};
  for (const [g, symbols] of Object.entries(GROUPS)) {
    const gRows = trades.filter((r) => symbols.includes(r.symbol));
    displacementSplit[g] = {
      displaced: groupReport(gRows.filter((r) => r.displacedWithin3)),
      notDisplaced: groupReport(gRows.filter((r) => !r.displacedWithin3)),
    };
  }

  // Pre-registered pass bar, OOS, modelled cost, per group.
  const passBar: Record<string, { pass: boolean; avgNetR: number | null; pf: number | null; trades: number; windowsPositiveFrac: number; reasons: string[] }> = {};
  for (const [g] of Object.entries(GROUPS)) {
    const oos = (perGroupOOS[g] as any).modelled;
    const wins = perGroupWindows[g].map((w) => w.stats.modelled.avgR).filter((v): v is number => v != null);
    const positiveWindows = wins.filter((v) => v > 0).length;
    const windowsPositiveFrac = wins.length ? positiveWindows / wins.length : 0;
    const reasons: string[] = [];
    const avgOk = (oos.avgR ?? -Infinity) >= 0.1;
    const pfOk = (oos.profitFactor ?? 0) >= 1.2;
    const nOk = oos.trades >= 100;
    const windowsOk = wins.length > 0 && windowsPositiveFrac >= 2 / 3;
    if (!avgOk) reasons.push(`avg net R ${oos.avgR} < +0.10`);
    if (!pfOk) reasons.push(`PF ${oos.profitFactor} < 1.2`);
    if (!nOk) reasons.push(`${oos.trades} OOS trades < 100`);
    if (!windowsOk) reasons.push(`positive in ${positiveWindows}/${wins.length} walk-forward windows (< 2/3)`);
    passBar[g] = { pass: avgOk && pfOk && nOk && windowsOk, avgNetR: oos.avgR, pf: oos.profitFactor, trades: oos.trades, windowsPositiveFrac: round(windowsPositiveFrac), reasons };
  }

  // Old flawed estimate vs this clean one — for reference only. The old
  // number came from apps/server/src/research/funnel-structure.ts's
  // `noDisplacement` bucket (candidate set = NO_DISPLACEMENT-labelled sweeps
  // only, stop at the engine's widened `sweep.extreme`, no R:R floor, no
  // one-trade-at-a-time rule) — see the module's header comment there and
  // the plan's "Context" section.
  const oldVsClean = {
    old: { label: 'noDisplacement bucket (funnel-structure.ts), look-ahead in the candidate set and the stop', approxR: 0.27, note: 'Retracted — see the plan, Context section, and diagnosis-report.md' },
    clean: { label: 'SWEEP_CLOSE, every sweep, modelled cost, OOS, pooled all symbols', avgNetR: statsOf(trades.filter((r) => r.session >= splitAt && r.netModelledR != null), 'netModelledR').avgR },
  };

  const report = {
    generatedAt: new Date().toISOString(),
    splitAt,
    firstSession,
    lastSession,
    walkForwardWindows: windows,
    costModel: {
      flatR: FLAT_COST_R,
      strikeStep: { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, CRUDEOIL: 50, GOLD: 100 },
      vixMultiplier: { NIFTY: 1.0, BANKNIFTY: 1.25 },
      hvMultiplier: 1.1,
      riskFreeRate: 0.07,
      pctCost: 0.012,
      brokeragePerLot: 47.2,
      chainCalibration: chainCal,
      skippedCostSymbols: [...skippedCostSymbols],
    },
    perSymbol: { is: perSymbolIS, oos: perSymbolOOS },
    perGroup: { is: perGroupIS, oos: perGroupOOS },
    walkForward: perGroupWindows,
    rejectedBySymbol,
    displacementSplit,
    passBar,
    oldVsClean,
    counts: { totalRows: allRows.length, trades: trades.length, rejected: rejected.length, lowRr: rejected.filter((r) => r.bucket === 'LOW_RR').length, noTarget: rejected.filter((r) => r.bucket === 'NO_TARGET').length },
  };

  writeFileSync(join(BACKTEST_DATA_DIR, 'sweep-close-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'sweep-close-report.md'), renderMarkdown(report));
  console.log(`Wrote sweep-close-report.json / .md — ${trades.length} trades, ${rejected.length} rejected (${report.counts.lowRr} LOW_RR, ${report.counts.noTarget} NO_TARGET).`);
}

function fmtStats(s: any): string {
  if (!s || s.trades === 0) return 'n=0';
  return `n=${s.trades} win%=${s.winRate ?? '—'} avgR=${s.avgR ?? '—'} PF=${s.profitFactor ?? '—'} exp=${s.expectancy ?? '—'} maxDD=${s.maxDrawdownR ?? '—'}R maxConsecL=${s.maxConsecLosses ?? '—'}${s.lowN ? ' (lowN)' : ''}`;
}

function renderMarkdown(r: any): string {
  const lines: string[] = [];
  lines.push('# SWEEP_CLOSE — pre-registered clean re-test (research only)');
  lines.push('');
  lines.push(`Generated ${r.generatedAt}. IS/OOS split at ${r.splitAt} (first ⅔ of the NIFTY calendar). Data ${r.firstSession} .. ${r.lastSession}.`);
  lines.push('');
  lines.push('## Old vs clean');
  lines.push(`- Old (retracted): ${r.oldVsClean.old.label} — approx **+${r.oldVsClean.old.approxR}R**. ${r.oldVsClean.old.note}`);
  lines.push(`- Clean (this test): ${r.oldVsClean.clean.label} — **${r.oldVsClean.clean.avgNetR}R**.`);
  lines.push('');
  lines.push('## Pre-registered pass bar (OOS, modelled cost)');
  for (const [g, p] of Object.entries<any>(r.passBar)) {
    lines.push(`- **${g}: ${p.pass ? 'PASS' : 'FAIL'}** — avgNetR=${p.avgNetR}, PF=${p.pf}, trades=${p.trades}, windows positive=${p.windowsPositiveFrac}${p.reasons.length ? `; failed: ${p.reasons.join('; ')}` : ''}`);
  }
  lines.push('');
  lines.push('## Per-group (IS / OOS)');
  for (const g of Object.keys(r.perGroup.is)) {
    lines.push(`### ${g}`);
    lines.push(`- IS flat: ${fmtStats(r.perGroup.is[g].flat)}`);
    lines.push(`- IS modelled: ${fmtStats(r.perGroup.is[g].modelled)}`);
    lines.push(`- OOS flat: ${fmtStats(r.perGroup.oos[g].flat)}`);
    lines.push(`- OOS modelled: ${fmtStats(r.perGroup.oos[g].modelled)}`);
    lines.push(`- OOS extra: avgMFE=${r.perGroup.oos[g].extra.avgMfeR}R avgMAE=${r.perGroup.oos[g].extra.avgMaeR}R avgBars=${r.perGroup.oos[g].extra.avgBarsHeld} stopAtr(p50)=${r.perGroup.oos[g].extra.stopAtr.p50} T1:R(p50)=${r.perGroup.oos[g].extra.rToT1?.p50 ?? '—'} liveWouldRefuse%=${r.perGroup.oos[g].extra.liveWouldRefusePct}`);
  }
  lines.push('');
  lines.push('## Walk-forward windows (2-month OOS test blocks, 4-month build skipped, stepping 2 months; nothing fitted)');
  for (const g of Object.keys(r.walkForward)) {
    lines.push(`### ${g}`);
    for (const w of r.walkForward[g]) {
      lines.push(`- ${w.window.testStart} .. ${w.window.testEnd}: flat ${fmtStats(w.stats.flat)} | modelled ${fmtStats(w.stats.modelled)}`);
    }
  }
  lines.push('');
  lines.push('## Per symbol (IS / OOS, modelled cost)');
  for (const sym of Object.keys(r.perSymbol.is)) {
    lines.push(`- **${sym}** IS: ${fmtStats(r.perSymbol.is[sym].modelled)} | OOS: ${fmtStats(r.perSymbol.oos[sym].modelled)}`);
  }
  lines.push('');
  lines.push('## LOW_RR / NO_TARGET (rejected — not a trade)');
  for (const sym of Object.keys(r.rejectedBySymbol)) {
    lines.push(`- **${sym}** LOW_RR: ${fmtStats(r.rejectedBySymbol[sym].lowRr.modelled)} | NO_TARGET: ${fmtStats(r.rejectedBySymbol[sym].noTarget.modelled)}`);
  }
  lines.push('');
  lines.push('## Displacement split (LATER information only — not tradable at entry)');
  for (const g of Object.keys(r.displacementSplit)) {
    lines.push(`- **${g}** displaced-within-3: ${fmtStats(r.displacementSplit[g].displaced.modelled)} | not displaced: ${fmtStats(r.displacementSplit[g].notDisplaced.modelled)}`);
  }
  lines.push('');
  lines.push('## Cost model assumptions');
  lines.push('See apps/server/src/research/option-cost.ts header. Chain calibration (spread%, lot size) is captured verbatim in the JSON report\'s `costModel.chainCalibration`.');
  if (r.costModel.skippedCostSymbols.length) lines.push(`Symbols with a handful of early sessions (HV20 warm-up, first ~20 sessions) excluded from the modelled-cost stats for missing sigma: ${r.costModel.skippedCostSymbols.join(', ')} (flat-cost stats still include those rows; ${r.counts.trades - Object.values(r.perGroup.oos).reduce((a: number, g: any) => a + g.modelled.trades, 0) - Object.values(r.perGroup.is).reduce((a: number, g: any) => a + g.modelled.trades, 0)} trade rows total lack a modelled cost).`);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
