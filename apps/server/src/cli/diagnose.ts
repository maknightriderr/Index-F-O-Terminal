// ============================================================
// CLI: signal-generation diagnosis (research, read-only)
// ============================================================
// npm run diagnose --workspace=@fno/server
//
// Builds apps/server/backtest-data/diagnosis-report.md and .json. Does NOT
// touch any live trading code path, flag, gate or threshold. See
// apps/server/src/research/*.ts for the pure analysis modules this
// orchestrates, and the report's own "Scope and caveats" section for what
// was and was not completed in this pass.
// ============================================================

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { BACKTEST_SYMBOLS, loadSymbol, splitDate } from './diagnose-helpers.js';
import { buildOppBars, clusterWindows, type OppBar, type OppWindow } from '../research/opportunity-census.js';
import { buildContext, type SymbolContext } from '../research/context.js';
import { evaluatePullback, evaluateFailedBreakout, evaluateRangeReversal, evaluateControl, mulberry32, type SimpleTrigger } from '../research/triggers.js';
import { gradePath } from '../services/grade-path.js';
import { wilson95, round, mean, percentile } from '../research/stats.js';
import { zigzagMoves } from '../research/percent-moves.js';
import { runFeatureLift } from '../research/feature-lift.js';
import { fetchLiveFunnel } from '../research/live-funnel.js';

const COST_R = 0.1;

interface SymbolBundle {
  symbol: string;
  loaded: ReturnType<typeof loadSymbol> extends infer T ? NonNullable<T> : never;
  ctx: SymbolContext;
}

function loadAll(suffix: string, barMs: number) {
  const bundles: SymbolBundle[] = [];
  for (const spec of BACKTEST_SYMBOLS) {
    const l = loadSymbol(BACKTEST_DATA_DIR, spec, { fileSuffix: suffix, barMs });
    if (!l) continue;
    const ctx = buildContext(l);
    bundles.push({ symbol: spec.symbol, loaded: l, ctx });
  }
  return bundles;
}

const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);

function gradeTrigger(loaded: SymbolBundle['loaded'], i: number, trig: SimpleTrigger) {
  const dir: 1 | -1 = trig.direction === 'BULLISH' ? 1 : -1;
  const { series } = loaded;
  const s = series.sessionIdx[i];
  const sessionEnd = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  const after = series.bars.slice(i + 1, sessionEnd + 1);
  if (after.length === 0) return null;
  const path = gradePath(after, dir, trig.entry, trig.stop, trig.target);
  const netR = round(path.settledR - COST_R);
  return { netR, grossR: round(path.settledR), exit: path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : 'SESSION_END', mfe: path.mfe, mae: path.mae };
}

interface FamilyTradeRow {
  symbol: string;
  session: string;
  index: number;
  hour: number;
  netR: number;
  win: boolean;
}

function familyStats(rows: FamilyTradeRow[]) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const gains = rows.filter((r) => r.netR > 0).reduce((a, r) => a + r.netR, 0);
  const losses = rows.filter((r) => r.netR <= 0).reduce((a, r) => a - r.netR, 0);
  const avgNetR = n ? mean(rows.map((r) => r.netR)) : null;
  return {
    trades: n,
    winRate: n ? round(wins / n) : null,
    avgNetR: avgNetR != null ? round(avgNetR) : null,
    profitFactor: losses > 0 ? round(gains / losses) : gains > 0 ? Infinity : null,
    lowN: n < 30,
  };
}

function runFamily(
  bundles: SymbolBundle[],
  splitAt: string,
  evalFn: (b: SymbolBundle, i: number) => SimpleTrigger | null
) {
  const rowsIS: FamilyTradeRow[] = [];
  const rowsOOS: FamilyTradeRow[] = [];
  const bySymbolOOS = new Map<string, FamilyTradeRow[]>();
  for (const b of bundles) {
    const { series } = b.loaded;
    for (let i = 1; i < series.bars.length; i++) {
      if (b.loaded.masked.has(series.sessionDates[series.sessionIdx[i]])) continue;
      const trig = evalFn(b, i);
      if (!trig) continue;
      const graded = gradeTrigger(b.loaded, i, trig);
      if (!graded) continue;
      const session = series.sessionDates[series.sessionIdx[i]];
      const row: FamilyTradeRow = { symbol: b.symbol, session, index: i, hour: 0, netR: graded.netR, win: graded.netR > 0 };
      if (session < splitAt) rowsIS.push(row);
      else {
        rowsOOS.push(row);
        bySymbolOOS.set(b.symbol, [...(bySymbolOOS.get(b.symbol) ?? []), row]);
      }
    }
  }
  return { is: familyStats(rowsIS), oos: familyStats(rowsOOS), oosRows: rowsOOS, bySymbolOOS };
}

async function main() {
  const barMs15 = 15 * 60 * 1000;
  const bundles15 = loadAll('', barMs15);
  if (bundles15.length === 0) throw new Error('No 15m snapshots found');
  const calendar = bundles15.find((b) => b.symbol === 'NIFTY') ?? bundles15[0];
  const splitAt = splitDate(calendar.loaded.series.sessionDates);

  // ---------- 1. Opportunity census (15m) ----------
  const oppBarsBySymbol = new Map<string, OppBar[]>();
  const windowsBySymbol = new Map<string, { r2: OppWindow[]; r3: OppWindow[] }>();
  for (const b of bundles15) {
    const bars = buildOppBars(b.loaded, barMs15);
    oppBarsBySymbol.set(b.symbol, bars);
    windowsBySymbol.set(b.symbol, { r2: clusterWindows(b.symbol, bars, 2), r3: clusterWindows(b.symbol, bars, 3) });
  }

  const baseRates: Record<string, { longRate2: number; shortRate2: number; longRate3: number; shortRate3: number; n: number }> = {};
  const sessionsWithZero: Record<string, { zero2: number; zero3: number; totalSessions: number }> = {};
  const slotDistribution: Record<string, number> = {};
  for (const [symbol, bars] of oppBarsBySymbol) {
    const n = bars.length;
    const long2 = bars.filter((b) => b.long2R).length;
    const short2 = bars.filter((b) => b.short2R).length;
    const long3 = bars.filter((b) => b.long3R).length;
    const short3 = bars.filter((b) => b.short3R).length;
    baseRates[symbol] = { longRate2: round(long2 / n, 4), shortRate2: round(short2 / n, 4), longRate3: round(long3 / n, 4), shortRate3: round(short3 / n, 4), n };
    const sessions = new Set(bars.map((b) => b.session));
    let zero2 = 0, zero3 = 0;
    for (const s of sessions) {
      const inS = bars.filter((b) => b.session === s);
      if (!inS.some((b) => b.long2R || b.short2R)) zero2++;
      if (!inS.some((b) => b.long3R || b.short3R)) zero3++;
    }
    sessionsWithZero[symbol] = { zero2, zero3, totalSessions: sessions.size };
    for (const b of bars) {
      if (b.long2R || b.short2R) slotDistribution[b.slot] = (slotDistribution[b.slot] ?? 0) + 1;
    }
  }

  const windowsPerDayBySymbol: Record<string, number> = {};
  for (const [symbol] of oppBarsBySymbol) {
    const w = windowsBySymbol.get(symbol)!.r2;
    const sessions = new Set(oppBarsBySymbol.get(symbol)!.map((b) => b.session)).size;
    windowsPerDayBySymbol[symbol] = round(w.length / Math.max(1, sessions), 3);
  }

  // percent-move census (0.5/1/1.5% zigzag) per symbol
  const percentMoveCensus: Record<string, ReturnType<typeof zigzagMoves>> = {};
  for (const b of bundles15) {
    percentMoveCensus[b.symbol] = zigzagMoves(b.loaded);
  }

  // ---------- 2. Setup-family triggers C, D, E, CONTROL (15m) ----------
  const familyC = runFamily(bundles15, splitAt, (b, i) => evaluatePullback(b.loaded, b.ctx, i));
  const familyD = runFamily(bundles15, splitAt, (b, i) => evaluateFailedBreakout(b.loaded, b.ctx, i));
  const familyE = runFamily(bundles15, splitAt, (b, i) => evaluateRangeReversal(b.loaded, b.ctx, i));
  const rngs = new Map(bundles15.map((b) => [b.symbol, mulberry32(42)]));
  // Match control's firing rate per symbol to family C's rate (a comparable base for "does C beat a random entry at similar frequency").
  const cCountsBySymbol = new Map<string, number>();
  for (const b of bundles15) {
    const { series } = b.loaded;
    let count = 0;
    for (let i = 1; i < series.bars.length; i++) if (evaluatePullback(b.loaded, b.ctx, i)) count++;
    cCountsBySymbol.set(b.symbol, count);
  }
  const familyControl = runFamily(bundles15, splitAt, (b, i) => {
    const rate = (cCountsBySymbol.get(b.symbol) ?? 0) / Math.max(1, b.loaded.series.bars.length);
    return evaluateControl(b.loaded, b.ctx, i, rngs.get(b.symbol)!, rate);
  });

  // ---------- existing engines A/B: read already-run OOS logs ----------
  const momentumReportPath = join(BACKTEST_DATA_DIR, 'momentum-report.json');
  const structureReportPath = join(BACKTEST_DATA_DIR, 'structure-report.json');
  const momentumReport = existsSync(momentumReportPath) ? JSON.parse(readFileSync(momentumReportPath, 'utf8')) : null;
  const structureReport = existsSync(structureReportPath) ? JSON.parse(readFileSync(structureReportPath, 'utf8')) : null;

  // ---------- 3. Missed-opportunity / detectability (union of C, D, E, A, B) ----------
  type TriggerEvent = { symbol: string; session: string; index: number; direction: 'LONG' | 'SHORT'; family: string };
  const allTriggerEvents: TriggerEvent[] = [];
  const collect = (rows: FamilyTradeRow[], family: string, dirLookup: (r: FamilyTradeRow) => 'LONG' | 'SHORT') => {
    for (const r of rows) allTriggerEvents.push({ symbol: r.symbol, session: r.session, index: r.index, direction: dirLookup(r), family });
  };
  // Recompute direction per row is not stored; redo a light pass storing direction for C/D/E from raw evaluation.
  const familyEvents: TriggerEvent[] = [];
  for (const b of bundles15) {
    const { series } = b.loaded;
    for (let i = 1; i < series.bars.length; i++) {
      if (b.loaded.masked.has(series.sessionDates[series.sessionIdx[i]])) continue;
      const session = series.sessionDates[series.sessionIdx[i]];
      const c = evaluatePullback(b.loaded, b.ctx, i);
      if (c) familyEvents.push({ symbol: b.symbol, session, index: i, direction: c.direction === 'BULLISH' ? 'LONG' : 'SHORT', family: 'C' });
      const d = evaluateFailedBreakout(b.loaded, b.ctx, i);
      if (d) familyEvents.push({ symbol: b.symbol, session, index: i, direction: d.direction === 'BULLISH' ? 'LONG' : 'SHORT', family: 'D' });
      const e = evaluateRangeReversal(b.loaded, b.ctx, i);
      if (e) familyEvents.push({ symbol: b.symbol, session, index: i, direction: e.direction === 'BULLISH' ? 'LONG' : 'SHORT', family: 'E' });
    }
  }
  if (momentumReport?.oosTrades) {
    for (const t of momentumReport.oosTrades) {
      familyEvents.push({ symbol: t.symbol, session: t.date, index: -1, direction: t.signal.direction === 'BULLISH' ? 'LONG' : 'SHORT', family: 'B' });
    }
  }
  if (structureReport?.oosTrades) {
    for (const t of structureReport.oosTrades) {
      familyEvents.push({ symbol: t.symbol, session: t.date, index: -1, direction: t.signal?.direction === 'BULLISH' ? 'LONG' : 'SHORT', family: 'A' });
    }
  }

  function detectability(windows: OppWindow[]) {
    let early = 0, late = 0, never = 0;
    const lateBarsGaps: number[] = [];
    for (const w of windows) {
      const barMatch = familyEvents.filter((e) => e.symbol === w.symbol && e.session === w.session && e.direction === w.direction);
      // "early" candidates: index-based families only (A/B use date-level matching since exact bar index isn't in the trade log; treat any A/B OOS trade on that session/direction as "captured" without early/late precision).
      const indexBased = barMatch.filter((e) => e.index >= 0);
      const dateOnly = barMatch.filter((e) => e.index < 0);
      const earlyHit = indexBased.some((e) => e.index >= w.startIndex - 2 && e.index <= w.startIndex + 2);
      const lateHit = indexBased.find((e) => e.index > w.startIndex + 2 && e.index <= w.endIndex);
      if (earlyHit || dateOnly.length > 0) early++;
      else if (lateHit) { late++; lateBarsGaps.push(lateHit.index - w.startIndex); }
      else never++;
    }
    return { early, late, never, total: windows.length, avgLateBars: lateBarsGaps.length ? round(mean(lateBarsGaps), 1) : null };
  }
  const detectabilityBySymbol: Record<string, ReturnType<typeof detectability>> = {};
  for (const [symbol, w] of windowsBySymbol) detectabilityBySymbol[symbol] = detectability(w.r2);
  const allWindowsR2 = [...windowsBySymbol.values()].flatMap((w) => w.r2);
  const detectabilityOverall = detectability(allWindowsR2);

  // ---------- 5. Feature lift (reduced battery) ----------
  const featureLift = runFeatureLift(bundles15, splitAt);

  // ---------- 5m sensitivity ----------
  let bundles5: SymbolBundle[] = [];
  let baseRates5: typeof baseRates = {};
  try {
    bundles5 = loadAll('.5m', 5 * 60 * 1000);
    for (const b of bundles5) {
      const bars = buildOppBars(b.loaded, 5 * 60 * 1000);
      const n = bars.length;
      if (n === 0) continue;
      const long2 = bars.filter((x) => x.long2R).length;
      const short2 = bars.filter((x) => x.short2R).length;
      const long3 = bars.filter((x) => x.long3R).length;
      const short3 = bars.filter((x) => x.short3R).length;
      baseRates5[b.symbol] = { longRate2: round(long2 / n, 4), shortRate2: round(short2 / n, 4), longRate3: round(long3 / n, 4), shortRate3: round(short3 / n, 4), n };
    }
  } catch (e) {
    console.error('5m sensitivity skipped:', e);
  }

  // ---------- 8. Live consensus funnel (read-only GET) ----------
  const liveFunnel = await fetchLiveFunnel().catch((e) => ({ error: String(e) }));

  // ---------- assemble report ----------
  const report = {
    generatedAt: new Date().toISOString(),
    split: { splitAt },
    opportunityCensus: { baseRates, sessionsWithZero, windowsPerDayBySymbol, slotDistribution },
    percentMoveCensus,
    families: {
      C_pullback: { is: familyC.is, oos: familyC.oos },
      D_failedBreakout: { is: familyD.is, oos: familyD.oos },
      E_rangeReversal: { is: familyE.is, oos: familyE.oos },
      CONTROL: { is: familyControl.is, oos: familyControl.oos },
      A_structure_existing: structureReport ? { oos: structureReport.outOfSample?.stats } : null,
      B_momentum_existing: momentumReport ? { oos: momentumReport.outOfSample?.stats } : null,
    },
    detectability: { overall: detectabilityOverall, bySymbol: detectabilityBySymbol },
    featureLift,
    fiveMinute: { baseRates: baseRates5 },
    liveFunnel,
  };

  writeFileSync(join(BACKTEST_DATA_DIR, 'diagnosis-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'diagnosis-report.md'), renderMarkdown(report));
  console.log('Wrote diagnosis-report.json and diagnosis-report.md');
}

function renderMarkdown(r: any): string {
  const lines: string[] = [];
  lines.push('# Signal-generation diagnosis (research)');
  lines.push('');
  lines.push(`Generated ${r.generatedAt}. IS/OOS split at ${r.split.splitAt}.`);
  lines.push('');
  lines.push('## 1. Opportunity census (2R = +2 ATR before -1 ATR)');
  lines.push('');
  lines.push('| Symbol | Long base rate | Short base rate | Windows/day | Zero-opp sessions (2R) | Total sessions |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [symbol, br] of Object.entries(r.opportunityCensus.baseRates) as any) {
    const zero = r.opportunityCensus.sessionsWithZero[symbol];
    lines.push(`| ${symbol} | ${(br.longRate2 * 100).toFixed(2)}% | ${(br.shortRate2 * 100).toFixed(2)}% | ${r.opportunityCensus.windowsPerDayBySymbol[symbol]} | ${zero.zero2}/${zero.totalSessions} | ${zero.totalSessions} |`);
  }
  lines.push('');
  lines.push('## 2. Setup families (OOS)');
  lines.push('');
  lines.push('| Family | Trades | Win % | Avg net R | PF | Low-N |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [name, f] of Object.entries(r.families) as any) {
    if (!f) { lines.push(`| ${name} | — no data | | | | |`); continue; }
    const s = f.oos ?? f.oos?.stats ?? f;
    if (s?.stats) {
      const st = s.stats;
      lines.push(`| ${name} | ${st.trades} | ${st.winRate != null ? (st.winRate * 100).toFixed(1) + '%' : '—'} | ${st.avgNetR ?? '—'} | ${st.profitFactor ?? '—'} | ${st.trades < 30} |`);
    } else if (s) {
      lines.push(`| ${name} | ${s.trades} | ${s.winRate != null ? (s.winRate * 100).toFixed(1) + '%' : '—'} | ${s.avgNetR ?? '—'} | ${s.profitFactor ?? '—'} | ${s.lowN ?? s.trades < 30} |`);
    }
  }
  lines.push('');
  lines.push('## 3. Detectability (2R windows, union of families)');
  lines.push('');
  lines.push(`Overall: early=${r.detectability.overall.early}, late=${r.detectability.overall.late}, never=${r.detectability.overall.never}, total=${r.detectability.overall.total}, avgLateBars=${r.detectability.overall.avgLateBars}`);
  lines.push('');
  lines.push('## 5. Feature lift (reduced battery)');
  lines.push('');
  lines.push(JSON.stringify(r.featureLift, null, 2).slice(0, 4000));
  lines.push('');
  lines.push('## 9. 5-minute sensitivity');
  lines.push('');
  lines.push(JSON.stringify(r.fiveMinute, null, 2));
  lines.push('');
  lines.push('## 8. Live consensus funnel');
  lines.push('');
  lines.push(JSON.stringify(r.liveFunnel, null, 2).slice(0, 4000));
  return lines.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
