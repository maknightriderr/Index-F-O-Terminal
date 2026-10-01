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
//
// SECOND PASS additions (coordinator request): fixed zigzag census bug;
// precision (2R/3R-before-1R hit rate of each family's own triggers, with
// lift); funnel removed-candidate grading for A and B; full feature battery
// (true 1H trend/ADX resample, BOS/CHoCH, FVG, displacement, candle-label,
// PDH/PDL distance, day-of-week) + phi redundancy matrix; regime x family
// cross-tabs with a multiple-testing note; index-vs-MCX opportunity density
// normalised per session hour; cost sensitivity (0/0.05/0.10/0.15R); and a
// pre-registered horizon test (target = session close) for C and A.
// ============================================================

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STRUCTURE_VARIANTS, MOMENTUM_BREAK_VARIANTS, type MomentumBreakVariant, type StructureVariant } from '@fno/analytics';
import { getSessionWindow } from '@fno/shared';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { BACKTEST_SYMBOLS, loadSymbol, splitDate } from './diagnose-helpers.js';
import { buildOppBars, clusterWindows, type OppBar, type OppWindow } from '../research/opportunity-census.js';
import { buildContext, type SymbolContext } from '../research/context.js';
import { evaluatePullback, evaluateFailedBreakout, evaluateRangeReversal, evaluateControl, mulberry32, type SimpleTrigger } from '../research/triggers.js';
import { gradePath } from '../services/grade-path.js';
import { wilson95, round, mean } from '../research/stats.js';
import { zigzagMoves } from '../research/percent-moves.js';
import { runFeatureLiftV2 } from '../research/feature-lift-v2.js';
import { fetchLiveFunnel } from '../research/live-funnel.js';
import { oppIndexBySymbol, scorePrecision, pooledBaseRates, type PrecisionEvent } from '../research/precision.js';
import { runFunnelB } from '../research/funnel-momentum.js';
import { runFunnelA } from '../research/funnel-structure.js';
import { buildCtx1hMap, crossTabByRegime, type RegimeEvent } from '../research/regime.js';
import { costSensitivity, gradeToSessionClose } from '../research/cost-horizon.js';

const COST_R = 0.1;
const BAR_MS_15 = 15 * 60 * 1000;

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

function gradeTrigger(loaded: SymbolBundle['loaded'], i: number, trig: SimpleTrigger) {
  const dir: 1 | -1 = trig.direction === 'BULLISH' ? 1 : -1;
  const { series } = loaded;
  const s = series.sessionIdx[i];
  const sessionEnd = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  const after = series.bars.slice(i + 1, sessionEnd + 1);
  if (after.length === 0) return null;
  const path = gradePath(after, dir, trig.entry, trig.stop, trig.target);
  const grossR = round(path.settledR);
  const netR = round(path.settledR - COST_R);
  return { netR, grossR, exit: path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : 'SESSION_END', mfe: path.mfe, mae: path.mae };
}

interface FamilyTradeRow {
  symbol: string;
  session: string;
  index: number;
  direction: 'LONG' | 'SHORT';
  netR: number;
  grossR: number;
}

function familyStats(rows: FamilyTradeRow[]) {
  const n = rows.length;
  const wins = rows.filter((r) => r.netR > 0).length;
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

function runFamily(bundles: SymbolBundle[], splitAt: string, evalFn: (b: SymbolBundle, i: number) => SimpleTrigger | null) {
  const rowsIS: FamilyTradeRow[] = [];
  const rowsOOS: FamilyTradeRow[] = [];
  for (const b of bundles) {
    const { series } = b.loaded;
    for (let i = 1; i < series.bars.length; i++) {
      if (b.loaded.masked.has(series.sessionDates[series.sessionIdx[i]])) continue;
      const trig = evalFn(b, i);
      if (!trig) continue;
      const graded = gradeTrigger(b.loaded, i, trig);
      if (!graded) continue;
      const session = series.sessionDates[series.sessionIdx[i]];
      const row: FamilyTradeRow = { symbol: b.symbol, session, index: i, direction: trig.direction === 'BULLISH' ? 'LONG' : 'SHORT', netR: graded.netR, grossR: graded.grossR };
      (session < splitAt ? rowsIS : rowsOOS).push(row);
    }
  }
  return { is: familyStats(rowsIS), oos: familyStats(rowsOOS), isRows: rowsIS, oosRows: rowsOOS };
}

function buildTimeIndex(loaded: SymbolBundle['loaded']): Map<number, number> {
  const map = new Map<number, number>();
  loaded.series.bars.forEach((b, i) => map.set(b.time, i));
  return map;
}

async function main() {
  const bundles15 = loadAll('', BAR_MS_15);
  if (bundles15.length === 0) throw new Error('No 15m snapshots found');
  const calendar = bundles15.find((b) => b.symbol === 'NIFTY') ?? bundles15[0];
  const splitAt = splitDate(calendar.loaded.series.sessionDates);
  const bundleBySymbol = new Map(bundles15.map((b) => [b.symbol, b]));

  // ---------- 1. Opportunity census (15m) ----------
  const oppBarsBySymbol = new Map<string, OppBar[]>();
  const windowsBySymbol = new Map<string, { r2: OppWindow[]; r3: OppWindow[] }>();
  for (const b of bundles15) {
    const bars = buildOppBars(b.loaded, BAR_MS_15);
    oppBarsBySymbol.set(b.symbol, bars);
    windowsBySymbol.set(b.symbol, { r2: clusterWindows(b.symbol, bars, 2), r3: clusterWindows(b.symbol, bars, 3) });
  }

  const baseRates: Record<string, { longRate2: number; shortRate2: number; longRate3: number; shortRate3: number; n: number }> = {};
  const sessionsWithZero: Record<string, { zero2: number; zero3: number; totalSessions: number }> = {};
  const slotDistribution: Record<string, number> = {};
  const sessionHoursBySymbol: Record<string, number> = {};
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
    // average session length in hours, from the loaded symbol's session window
    const b0 = bundleBySymbol.get(symbol)!;
    const dates = [...new Set(b0.loaded.series.sessionDates)].filter((d) => !b0.loaded.masked.has(d));
    const hoursList = dates.map((d) => {
      const w = getSessionWindow(b0.loaded.spec.exchange, d);
      return w ? (w.close - w.open) / 3600000 : null;
    }).filter((h): h is number => h != null);
    sessionHoursBySymbol[symbol] = hoursList.length ? round(mean(hoursList), 2) : 0;
  }

  const windowsPerDayBySymbol: Record<string, number> = {};
  const windowsPerHourBySymbol: Record<string, number> = {};
  for (const [symbol] of oppBarsBySymbol) {
    const w = windowsBySymbol.get(symbol)!.r2;
    const sessions = new Set(oppBarsBySymbol.get(symbol)!.map((b) => b.session)).size;
    windowsPerDayBySymbol[symbol] = round(w.length / Math.max(1, sessions), 3);
    const hours = sessionHoursBySymbol[symbol] || 1;
    windowsPerHourBySymbol[symbol] = round(windowsPerDayBySymbol[symbol] / hours, 3);
  }

  // percent-move census (0.5/1/1.5% zigzag) per symbol — BUGFIXED this pass
  const percentMoveCensus: Record<string, ReturnType<typeof zigzagMoves>> = {};
  for (const b of bundles15) percentMoveCensus[b.symbol] = zigzagMoves(b.loaded);

  // ---------- 2. Setup-family triggers C, D, E, CONTROL (15m) ----------
  const familyC = runFamily(bundles15, splitAt, (b, i) => evaluatePullback(b.loaded, b.ctx, i));
  const familyD = runFamily(bundles15, splitAt, (b, i) => evaluateFailedBreakout(b.loaded, b.ctx, i));
  const familyE = runFamily(bundles15, splitAt, (b, i) => evaluateRangeReversal(b.loaded, b.ctx, i));
  const rngs = new Map(bundles15.map((b) => [b.symbol, mulberry32(42)]));
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
  const chosenMomentumVariant: MomentumBreakVariant = MOMENTUM_BREAK_VARIANTS.find((v) => v.id === momentumReport?.chosenVariant?.id) ?? MOMENTUM_BREAK_VARIANTS[0];
  const chosenStructureVariant: StructureVariant = STRUCTURE_VARIANTS.find((v) => v.id === structureReport?.chosenVariant?.id) ?? STRUCTURE_VARIANTS[0];

  const timeIndexBySymbol = new Map(bundles15.map((b) => [b.symbol, buildTimeIndex(b.loaded)]));
  interface ExistingTrade { symbol: string; index: number; direction: 'LONG' | 'SHORT'; grossR: number; netR: number }
  const momentumOosTrades: ExistingTrade[] = [];
  if (momentumReport?.oosTrades) {
    for (const t of momentumReport.oosTrades) {
      const idx = timeIndexBySymbol.get(t.symbol)?.get(t.signal.barTime);
      if (idx == null) continue;
      momentumOosTrades.push({ symbol: t.symbol, index: idx, direction: t.signal.direction === 'BULLISH' ? 'LONG' : 'SHORT', grossR: t.grossR, netR: t.netR });
    }
  }
  const structureOosTrades: ExistingTrade[] = [];
  if (structureReport?.oosTrades) {
    for (const t of structureReport.oosTrades) {
      // BacktestTrade.fill is {at, price, barsWaited, hour} (harness.ts) — the
      // fill BAR's own open time, not an index; resolve it through the
      // per-symbol time->index map (same technique as the momentum trades).
      if (!t.fill?.at) continue;
      const idx = timeIndexBySymbol.get(t.symbol)?.get(Date.parse(t.fill.at));
      if (idx == null) continue;
      structureOosTrades.push({ symbol: t.symbol, index: idx, direction: t.signal.direction === 'BULLISH' ? 'LONG' : 'SHORT', grossR: t.grossR, netR: t.netR });
    }
  }

  // ---------- 3. Missed-opportunity / detectability (union of C, D, E, A, B) ----------
  type TriggerEvent = { symbol: string; session: string; index: number; direction: 'LONG' | 'SHORT'; family: string };
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
  for (const t of momentumOosTrades) {
    const session = bundleBySymbol.get(t.symbol)!.loaded.series.sessionDates[bundleBySymbol.get(t.symbol)!.loaded.series.sessionIdx[t.index]];
    familyEvents.push({ symbol: t.symbol, session, index: t.index, direction: t.direction, family: 'B' });
  }
  for (const t of structureOosTrades) {
    const session = bundleBySymbol.get(t.symbol)!.loaded.series.sessionDates[bundleBySymbol.get(t.symbol)!.loaded.series.sessionIdx[t.index]];
    familyEvents.push({ symbol: t.symbol, session, index: t.index, direction: t.direction, family: 'A' });
  }

  function detectability(windows: OppWindow[]) {
    let early = 0, late = 0, never = 0;
    const lateBarsGaps: number[] = [];
    for (const w of windows) {
      const barMatch = familyEvents.filter((e) => e.symbol === w.symbol && e.session === w.session && e.direction === w.direction);
      const earlyHit = barMatch.some((e) => e.index >= w.startIndex - 2 && e.index <= w.startIndex + 2);
      const lateHit = barMatch.find((e) => e.index > w.startIndex + 2 && e.index <= w.endIndex);
      if (earlyHit) early++;
      else if (lateHit) { late++; lateBarsGaps.push(lateHit.index - w.startIndex); }
      else never++;
    }
    return { early, late, never, total: windows.length, avgLateBars: lateBarsGaps.length ? round(mean(lateBarsGaps), 1) : null };
  }
  const detectabilityBySymbol: Record<string, ReturnType<typeof detectability>> = {};
  for (const [symbol, w] of windowsBySymbol) detectabilityBySymbol[symbol] = detectability(w.r2);
  const allWindowsR2 = [...windowsBySymbol.values()].flatMap((w) => w.r2);
  const detectabilityOverall = detectability(allWindowsR2);

  // ---------- item 1 (second pass): PRECISION per family ----------
  const allOppBars = [...oppBarsBySymbol.values()].flat();
  const base = pooledBaseRates(allOppBars, splitAt);
  const oppIndex = oppIndexBySymbol(bundles15);
  const toEvents = (rows: FamilyTradeRow[]): PrecisionEvent[] => rows.map((r) => ({ symbol: r.symbol, index: r.index, direction: r.direction }));
  const precision = {
    C: { is: scorePrecision(toEvents(familyC.isRows), oppIndex, base.is2R, base.is3R), oos: scorePrecision(toEvents(familyC.oosRows), oppIndex, base.oos2R, base.oos3R) },
    D: { is: scorePrecision(toEvents(familyD.isRows), oppIndex, base.is2R, base.is3R), oos: scorePrecision(toEvents(familyD.oosRows), oppIndex, base.oos2R, base.oos3R) },
    E: { is: scorePrecision(toEvents(familyE.isRows), oppIndex, base.is2R, base.is3R), oos: scorePrecision(toEvents(familyE.oosRows), oppIndex, base.oos2R, base.oos3R) },
    CONTROL: { is: scorePrecision(toEvents(familyControl.isRows), oppIndex, base.is2R, base.is3R), oos: scorePrecision(toEvents(familyControl.oosRows), oppIndex, base.oos2R, base.oos3R) },
    // A/B: only OOS trade logs exist (see funnels for why IS isn't re-derived here).
    A: { is: null as null, oos: scorePrecision(momentumOosTradesToEvents(structureOosTrades), oppIndex, base.oos2R, base.oos3R) },
    B: { is: null as null, oos: scorePrecision(momentumOosTradesToEvents(momentumOosTrades), oppIndex, base.oos2R, base.oos3R) },
  };
  function momentumOosTradesToEvents(trades: ExistingTrade[]): PrecisionEvent[] {
    return trades.map((t) => ({ symbol: t.symbol, index: t.index, direction: t.direction }));
  }

  // ---------- item 2: funnel removed-candidate grading ----------
  const funnelB = runFunnelB(bundles15, splitAt, chosenMomentumVariant);
  const funnelA = runFunnelA(bundles15, splitAt, chosenStructureVariant);

  // ---------- item 5: FULL feature battery + phi matrix ----------
  const featureLift = runFeatureLiftV2(bundles15, splitAt);

  // ---------- item 4: regime x family cross-tabs ----------
  const ctx1hMap = buildCtx1hMap(bundles15);
  const toRegimeEvents = (rows: FamilyTradeRow[], isIS: boolean): RegimeEvent[] => rows.map((r) => ({ symbol: r.symbol, index: r.index, isIS, netR: r.netR }));
  const regimeCrossTabs: Record<string, ReturnType<typeof crossTabByRegime>> = {
    C: crossTabByRegime([...toRegimeEvents(familyC.isRows, true), ...toRegimeEvents(familyC.oosRows, false)], bundles15, ctx1hMap),
    D: crossTabByRegime([...toRegimeEvents(familyD.isRows, true), ...toRegimeEvents(familyD.oosRows, false)], bundles15, ctx1hMap),
    E: crossTabByRegime([...toRegimeEvents(familyE.isRows, true), ...toRegimeEvents(familyE.oosRows, false)], bundles15, ctx1hMap),
    CONTROL: crossTabByRegime([...toRegimeEvents(familyControl.isRows, true), ...toRegimeEvents(familyControl.oosRows, false)], bundles15, ctx1hMap),
    A: crossTabByRegime(structureOosTrades.map((t) => ({ symbol: t.symbol, index: t.index, isIS: false, netR: t.netR })), bundles15, ctx1hMap),
    B: crossTabByRegime(momentumOosTrades.map((t) => ({ symbol: t.symbol, index: t.index, isIS: false, netR: t.netR })), bundles15, ctx1hMap),
  };
  const totalCellsTested = Object.values(regimeCrossTabs).reduce((a, rows) => a + rows.length, 0);
  const positiveBothCount = Object.values(regimeCrossTabs).reduce((a, rows) => a + rows.filter((r) => r.positiveBoth).length, 0);
  const expectedByChance = round(totalCellsTested * 0.25, 1); // see regime.ts's own note on the ~25% naive chance rate

  // ---------- item 7: index vs MCX, hour-normalised ----------
  const indexVsMcx = {
    indexAvgWindowsPerHour: round(mean(['NIFTY', 'BANKNIFTY', 'SENSEX'].map((s) => windowsPerHourBySymbol[s]).filter((x) => x != null)), 3),
    mcxAvgWindowsPerHour: round(mean(['CRUDEOIL', 'GOLD'].map((s) => windowsPerHourBySymbol[s]).filter((x) => x != null)), 3),
    windowsPerHourBySymbol,
    sessionHoursBySymbol,
  };

  // ---------- item 5: cost sensitivity ----------
  const costSens = {
    C: { is: costSensitivity(familyC.isRows.map((r) => r.grossR)), oos: costSensitivity(familyC.oosRows.map((r) => r.grossR)) },
    D: { is: costSensitivity(familyD.isRows.map((r) => r.grossR)), oos: costSensitivity(familyD.oosRows.map((r) => r.grossR)) },
    E: { is: costSensitivity(familyE.isRows.map((r) => r.grossR)), oos: costSensitivity(familyE.oosRows.map((r) => r.grossR)) },
    CONTROL: { is: costSensitivity(familyControl.isRows.map((r) => r.grossR)), oos: costSensitivity(familyControl.oosRows.map((r) => r.grossR)) },
    A: { oos: costSensitivity(structureOosTrades.map((t) => t.grossR)) },
    B: { oos: costSensitivity(momentumOosTrades.map((t) => t.grossR)) },
  };

  // ---------- item 6: horizon sensitivity (target = session close) ----------
  const horizonC_IS: number[] = [];
  const horizonC_OOS: number[] = [];
  for (const r of familyC.isRows.concat(familyC.oosRows)) {
    const b = bundleBySymbol.get(r.symbol)!;
    // Re-derive the trigger's own entry/stop (not stored on the row) by re-evaluating at its bar index.
    const trig = evaluatePullback(b.loaded, b.ctx, r.index);
    if (!trig) continue;
    const dir: 1 | -1 = trig.direction === 'BULLISH' ? 1 : -1;
    const g = gradeToSessionClose(b.loaded, r.index, dir, trig.entry, trig.stop);
    if (g == null) continue;
    (r.session < splitAt ? horizonC_IS : horizonC_OOS).push(round(g - COST_R));
  }
  const horizonA_OOS: number[] = [];
  if (structureReport?.oosTrades) {
    for (const t of structureReport.oosTrades) {
      const b = bundleBySymbol.get(t.symbol);
      const idx = t.fill?.at ? timeIndexBySymbol.get(t.symbol)?.get(Date.parse(t.fill.at)) : null;
      if (!b || idx == null || t.signal?.entry == null || t.signal?.stop == null) continue;
      const dir: 1 | -1 = t.signal.direction === 'BULLISH' ? 1 : -1;
      const g = gradeToSessionClose(b.loaded, idx, dir, t.signal.entry, t.signal.stop);
      if (g == null) continue;
      horizonA_OOS.push(round(g - COST_R));
    }
  }
  const horizonSensitivity = {
    C: {
      is: { trades: horizonC_IS.length, avgNetR: horizonC_IS.length ? round(mean(horizonC_IS)) : null, vsFixedTarget: familyC.is.avgNetR },
      oos: { trades: horizonC_OOS.length, avgNetR: horizonC_OOS.length ? round(mean(horizonC_OOS)) : null, vsFixedTarget: familyC.oos.avgNetR },
    },
    A: {
      oos: { trades: horizonA_OOS.length, avgNetR: horizonA_OOS.length ? round(mean(horizonA_OOS)) : null, vsFixedTarget: structureReport?.outOfSample?.stats?.avgNetR ?? null },
    },
  };

  // ---------- 5m sensitivity ----------
  let baseRates5: typeof baseRates = {};
  try {
    const bundles5 = loadAll('.5m', 5 * 60 * 1000);
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
    opportunityCensus: { baseRates, sessionsWithZero, windowsPerDayBySymbol, windowsPerHourBySymbol, slotDistribution, sessionHoursBySymbol },
    percentMoveCensus,
    families: {
      C_pullback: { is: familyC.is, oos: familyC.oos },
      D_failedBreakout: { is: familyD.is, oos: familyD.oos },
      E_rangeReversal: { is: familyE.is, oos: familyE.oos },
      CONTROL: { is: familyControl.is, oos: familyControl.oos },
      A_structure_existing: structureReport ? { oos: structureReport.outOfSample?.stats } : null,
      B_momentum_existing: momentumReport ? { oos: momentumReport.outOfSample?.stats } : null,
    },
    precision,
    funnelA,
    funnelB,
    detectability: { overall: detectabilityOverall, bySymbol: detectabilityBySymbol },
    featureLift,
    regimeCrossTabs,
    multipleTestingNote: { totalCellsTested, positiveBothIsAndOos: positiveBothCount, expectedByChanceApprox: expectedByChance },
    indexVsMcx,
    costSensitivity: costSens,
    horizonSensitivity,
    fiveMinute: { baseRates: baseRates5 },
    liveFunnel,
  };

  writeFileSync(join(BACKTEST_DATA_DIR, 'diagnosis-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'diagnosis-report.md'), renderMarkdown(report));
  console.log('Wrote diagnosis-report.json and diagnosis-report.md');
}

function renderMarkdown(r: any): string {
  const lines: string[] = [];
  lines.push('# Signal-generation diagnosis (research) — second pass');
  lines.push('');
  lines.push(`Generated ${r.generatedAt}. IS/OOS split at ${r.split.splitAt}.`);
  lines.push('');
  lines.push('## 0. Percent-move census (zigzag bug fixed this pass)');
  lines.push('');
  for (const [symbol, summaries] of Object.entries(r.percentMoveCensus) as any) {
    lines.push(`### ${symbol}`);
    for (const s of summaries) lines.push(`- >=${s.threshold}%: ${s.count} legs`);
  }
  lines.push('');
  lines.push('## 1. Opportunity census (2R = +2 ATR before -1 ATR)');
  lines.push('');
  lines.push('| Symbol | Long base rate | Short base rate | Windows/day | Windows/hour | Session hrs | Zero-opp sessions (2R) | Total sessions |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [symbol, br] of Object.entries(r.opportunityCensus.baseRates) as any) {
    const zero = r.opportunityCensus.sessionsWithZero[symbol];
    lines.push(`| ${symbol} | ${(br.longRate2 * 100).toFixed(2)}% | ${(br.shortRate2 * 100).toFixed(2)}% | ${r.opportunityCensus.windowsPerDayBySymbol[symbol]} | ${r.opportunityCensus.windowsPerHourBySymbol[symbol]} | ${r.opportunityCensus.sessionHoursBySymbol[symbol]} | ${zero.zero2}/${zero.totalSessions} | ${zero.totalSessions} |`);
  }
  lines.push('');
  lines.push(`Index avg windows/hour: ${r.indexVsMcx.indexAvgWindowsPerHour}, MCX avg windows/hour: ${r.indexVsMcx.mcxAvgWindowsPerHour}`);
  lines.push('');
  lines.push('## 2. Setup families (OOS)');
  lines.push('');
  lines.push('| Family | Trades | Win % | Avg net R | PF | Low-N |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [name, f] of Object.entries(r.families) as any) {
    if (!f) { lines.push(`| ${name} | — no data | | | | |`); continue; }
    const s = f.oos;
    if (s?.stats) {
      const st = s.stats;
      lines.push(`| ${name} | ${st.trades} | ${st.winRate != null ? (st.winRate * 100).toFixed(1) + '%' : '—'} | ${st.avgNetR ?? '—'} | ${st.profitFactor ?? '—'} | ${st.trades < 30} |`);
    } else if (s) {
      lines.push(`| ${name} | ${s.trades} | ${s.winRate != null ? (s.winRate * 100).toFixed(1) + '%' : '—'} | ${s.avgNetR ?? '—'} | ${s.profitFactor ?? '—'} | ${s.lowN ?? s.trades < 30} |`);
    }
  }
  lines.push('');
  lines.push('## 1/3 Precision (fraction of triggers reaching 2R/3R before 1R) + lift');
  lines.push('');
  lines.push(JSON.stringify(r.precision, null, 2).slice(0, 6000));
  lines.push('');
  lines.push('## 3. Detectability (2R windows, union of families)');
  lines.push('');
  lines.push(`Overall: early=${r.detectability.overall.early}, late=${r.detectability.overall.late}, never=${r.detectability.overall.never}, total=${r.detectability.overall.total}, avgLateBars=${r.detectability.overall.avgLateBars}`);
  lines.push('');
  lines.push('## 4. Funnel A (structure) removed-candidate grading');
  lines.push('');
  lines.push(JSON.stringify(r.funnelA, null, 2));
  lines.push('');
  lines.push('## 4. Funnel B (momentum) removed-candidate grading');
  lines.push('');
  lines.push(JSON.stringify(r.funnelB, null, 2));
  lines.push('');
  lines.push('## 5. Feature lift (full battery) + redundancy');
  lines.push('');
  lines.push(JSON.stringify(r.featureLift, null, 2).slice(0, 8000));
  lines.push('');
  lines.push('## 6. Regime x family cross-tabs');
  lines.push('');
  lines.push(`Multiple-testing context: ${r.multipleTestingNote.totalCellsTested} cells tested, ${r.multipleTestingNote.positiveBothIsAndOos} positive in both IS and OOS with N>=30, ~${r.multipleTestingNote.expectedByChanceApprox} expected by chance alone.`);
  lines.push('');
  lines.push(JSON.stringify(r.regimeCrossTabs, null, 2).slice(0, 8000));
  lines.push('');
  lines.push('## 5. Cost sensitivity (0 / 0.05 / 0.10 / 0.15 R)');
  lines.push('');
  lines.push(JSON.stringify(r.costSensitivity, null, 2));
  lines.push('');
  lines.push('## 6. Horizon sensitivity (target = session close)');
  lines.push('');
  lines.push(JSON.stringify(r.horizonSensitivity, null, 2));
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
