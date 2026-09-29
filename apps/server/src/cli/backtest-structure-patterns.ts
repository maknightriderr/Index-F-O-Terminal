// ============================================================
// CLI: exploratory candle-pattern report (Part 1, item 5)
// ============================================================
// npm run backtest-structure-patterns --workspace=@fno/server
//
// Groups the structure engine's already-placed trades by the candle labels
// on their setup (sweepPattern, displacementPattern, combo) — the 15m LIVE
// config (D1.0-NOGUARD, closing guard 60) over its full 12-month window, and
// the 5m CHOSEN variant (the in-sample winner from structure-5m-report,
// 5m-D1.5-C60) over its own (shorter) window.
//
// PURELY EXPLORATORY. This is NOT a backtest decision and gates nothing:
//   - it reuses trades already reported in structure-report.* /
//     structure-5m-report.* (already-seen data, not an out-of-sample test);
//   - most buckets below are small (a handful of trades each) — treat every
//     number here as a hint to look at, never as a result to act on;
//   - the candle-pattern score bonus (+4/+3/+3, Tier 1) was NOT active when
//     entries/exits were decided by the historical engine replay used here —
//     these groups are read off the setups' recorded pattern, the score
//     bonus itself never gated or reordered anything (see candle-labels.ts).
//
// Writes structure-patterns-report.json / .md — a SEPARATE report; nothing
// existing is touched.
// ============================================================

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STRUCTURE_5M_VARIANTS, STRUCTURE_VARIANTS, type StructureSetup } from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { BACKTEST_SYMBOLS, type BacktestTrade, loadSymbol, replayStrategy, statsOf, type LoadedSymbol, type ReplayWindow, type TradeStats } from '../backtest/harness.js';
import { STRUCTURE_5M_STRATEGY, STRUCTURE_STRATEGY } from '../backtest/structure-backtest.js';

const M5 = 5 * 60 * 1000;
type STrade = BacktestTrade<StructureSetup>;

const fmtR = (n: number | null | undefined) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(3));
const fmtPct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtPf = (n: number | null) => (n == null ? '—' : n === Infinity ? '∞' : n.toFixed(2));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface PatternGroupRow {
  key: string;
  trades: number;
  winRate: number | null;
  avgNetR: number | null;
  profitFactor: number | null;
  avgInitialRiskAtr: number | null;
  avgRAchievedOnWinners: number | null;
}

function initialRiskAtr(t: STrade): number | null {
  const entry = t.signal.entry;
  const stop = t.signal.stop;
  const atr = t.signal.atr;
  if (entry == null || stop == null || !(atr > 0)) return null;
  return Math.abs(entry - stop) / atr;
}

function patternGroups(trades: STrade[], key: (t: STrade) => string | null): PatternGroupRow[] {
  const m = new Map<string, STrade[]>();
  for (const t of trades) {
    const k = key(t);
    if (k == null) continue;
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, ts]) => {
      const s: TradeStats = statsOf(ts);
      const winners = ts.filter((t) => t.netR > 0);
      const risks = ts.map(initialRiskAtr).filter((x): x is number => x != null);
      return {
        key: k,
        trades: s.trades,
        winRate: s.winRate,
        avgNetR: s.avgNetR,
        profitFactor: s.profitFactor,
        avgInitialRiskAtr: avg(risks),
        avgRAchievedOnWinners: avg(winners.map((t) => t.netR)),
      };
    });
}

const GROUP_HEADER = '| Pattern | Trades | Win % | Avg net R | PF | Avg initial risk (ATR) | Avg R on winners |\n|---|---:|---:|---:|---:|---:|---:|';
function groupRow(r: PatternGroupRow): string {
  return `| ${r.key} | ${r.trades} | ${fmtPct(r.winRate)} | ${fmtR(r.avgNetR)} | ${fmtPf(r.profitFactor)} | ${r.avgInitialRiskAtr == null ? '—' : r.avgInitialRiskAtr.toFixed(2)} | ${fmtR(r.avgRAchievedOnWinners)} |`;
}

function reportSection(log: (s?: string) => void, title: string, trades: STrade[]) {
  log(`### ${title}`);
  log();
  log(`${trades.length} trades total.`);
  log();
  log('**By sweep pattern**');
  log();
  log(GROUP_HEADER);
  for (const r of patternGroups(trades, (t) => t.signal.patterns?.sweepPattern ?? null)) log(groupRow(r));
  log();
  log('**By displacement pattern**');
  log();
  log(GROUP_HEADER);
  for (const r of patternGroups(trades, (t) => t.signal.patterns?.displacementPattern ?? 'none recorded')) log(groupRow(r));
  log();
  log('**By combo (morning/evening star)**');
  log();
  log(GROUP_HEADER);
  for (const r of patternGroups(trades, (t) => t.signal.patterns?.combo ?? 'no combo')) log(groupRow(r));
  log();
  return {
    total: trades.length,
    bySweepPattern: patternGroups(trades, (t) => t.signal.patterns?.sweepPattern ?? null),
    byDisplacementPattern: patternGroups(trades, (t) => t.signal.patterns?.displacementPattern ?? 'none recorded'),
    byCombo: patternGroups(trades, (t) => t.signal.patterns?.combo ?? 'no combo'),
  };
}

function main() {
  const lines: string[] = [];
  const log = (s = '') => { lines.push(s); console.log(s); };

  log('# Exploratory candle-pattern report (Part 1, item 5)');
  log();
  log('**Caveats — read before drawing any conclusion.** This groups trades ALREADY reported in structure-report.md (15m) and structure-5m-report.md (5m) by the candle labels their setups carry. It is not a fresh out-of-sample test: the same trades appear in both places. Most buckets below have only a handful of trades — treat everything here as a hint to look at, never as a result to act on. The candle-pattern score bonus (+4 clean rejection, +3 engulfing, +3 star) never influenced which of these trades were taken or how they exited; it only orders/describes and is applied after the fact for display.');
  log();

  // ---- 15m: the live config, full 12-month window ----
  const live15: LoadedSymbol[] = [];
  const missing15: string[] = [];
  for (const spec of BACKTEST_SYMBOLS) {
    const l = loadSymbol(BACKTEST_DATA_DIR, spec);
    if (l) live15.push(l);
    else missing15.push(spec.symbol);
  }
  const liveVariant = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-NOGUARD')!;
  const cal15 = (live15.find((l) => l.spec.symbol === 'NIFTY') ?? live15[0]).series.sessionDates;
  const window15: ReplayWindow = { from: cal15[0], to: [...live15.flatMap((l) => l.series.sessionDates)].sort().at(-1)! };
  const trades15: STrade[] = [];
  for (const l of live15) trades15.push(...replayStrategy(l, STRUCTURE_STRATEGY, liveVariant, window15).trades);

  log('## 15m live config (D1.0-NOGUARD, closing guard 60)');
  log();
  log(`Window ${window15.from} → ${window15.to} (the full 12-month history — the same trades reported in structure-report.md's in-sample + out-of-sample, pooled).`);
  if (missing15.length) log(`Excluded: ${missing15.join(', ')} (snapshot missing).`);
  log();
  const section15 = reportSection(log, `15m — ${window15.from} to ${window15.to}`, trades15);

  // ---- 5m: the chosen variant, its own window ----
  const chosen5 = STRUCTURE_5M_VARIANTS.find((v) => v.id === '5m-D1.5-C60')!;
  const loaded15for5: LoadedSymbol[] = [];
  const loaded5: LoadedSymbol[] = [];
  const missing5: string[] = [];
  for (const spec of BACKTEST_SYMBOLS) {
    const l15 = loadSymbol(BACKTEST_DATA_DIR, spec);
    const l5 = loadSymbol(BACKTEST_DATA_DIR, spec, { barMs: M5, fileSuffix: '.5m' });
    if (!l15 || !l5) { missing5.push(spec.symbol); continue; }
    loaded15for5.push(l15);
    loaded5.push({ ...l5, poolSeries: l15.series, masked: l15.masked });
  }
  const cal5 = (loaded5.find((l) => l.spec.symbol === 'NIFTY') ?? loaded5[0])?.series.sessionDates ?? [];
  const window5: ReplayWindow = { from: cal5[0] ?? '', to: [...loaded5.flatMap((l) => l.series.sessionDates)].sort().at(-1) ?? '' };
  const trades5: STrade[] = [];
  for (const l of loaded5) trades5.push(...replayStrategy(l, STRUCTURE_5M_STRATEGY, chosen5, window5).trades);

  log(`## 5m chosen variant (${chosen5.id})`);
  log();
  log(`Window ${window5.from} → ${window5.to} (the 5m history's own window — shorter than the 15m's 12 months; the same trades reported in structure-5m-report.md's in-sample + out-of-sample, pooled).`);
  if (missing5.length) log(`Excluded: ${missing5.join(', ')} (snapshot missing).`);
  log();
  const section5 = reportSection(log, `5m — ${window5.from} to ${window5.to}`, trades5);

  const report = {
    generatedAt: new Date().toISOString(),
    caveat: 'Exploratory only: already-seen trades (regrouped from structure-report.* and structure-5m-report.*), small buckets, not for gating. The score bonus never influenced these trades.',
    fifteenMinute: { variant: liveVariant, window: window15, excluded: missing15, ...section15 },
    fiveMinute: { variant: chosen5, window: window5, excluded: missing5, ...section5 },
  };
  writeFileSync(join(BACKTEST_DATA_DIR, 'structure-patterns-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'structure-patterns-report.md'), lines.join('\n'));
  console.log(`\nWrote ${join(BACKTEST_DATA_DIR, 'structure-patterns-report.md')}`);
}

try {
  main();
} catch (err: any) {
  console.error('Structure patterns report failed:', err);
  process.exit(1);
}
