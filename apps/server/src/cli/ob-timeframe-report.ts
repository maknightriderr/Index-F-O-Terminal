// ============================================================
// CLI: OB1 timeframe test, 15m blocks vs 1H blocks + 15m entry
// (pre-registered, research only, read-only)
// ============================================================
// npm run ob-timeframe-report --workspace=@fno/server
//
// Builds apps/server/backtest-data/ob-timeframe-report.{md,json} from the
// saved snapshots (never fetches). Touches no live code path, flag or gate.
// The arms and rules: src/research/ob-timeframe.ts. Costs: the sweep-close
// report's modelled option cost (src/research/option-cost.ts), unchanged.
//
// PRE-REGISTERED VERDICT, per group (INDEX = NIFTY / BANKNIFTY / SENSEX, MCX =
// CRUDEOIL / GOLD), on the out-of-sample third, modelled option cost:
//   1H PASSES only if ALL of: average net R >= +0.10, PF >= 1.2, >= 100
//   trades, positive in >= 2/3 of the walk-forward windows, and its average
//   net R beats the 15m arm's by >= +0.10R on the same dates.
//   INSUFFICIENT if it misses ONLY the trade count (the other four hold):
//   the data cannot decide, so it stays a hypothesis.
//   FAIL otherwise.
// The 15m arm is scored on the same bar (minus the comparison) for reference.
// ============================================================

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKTEST_SYMBOLS, loadSymbol, splitDate } from '../backtest/harness.js';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { runObArm, type ObArm } from '../research/ob-timeframe.js';
import type { GradedCandidate } from '../research/multipath.js';
import { computeOptionCost, hv20, type ChainCalibration } from '../research/option-cost.js';
import { round, mean, percentile } from '../research/stats.js';

const FLAT_COST_R = 0.1;
const ARMS: ObArm[] = ['15m', '1H'];
const GROUPS: Record<string, string[]> = { INDEX: ['NIFTY', 'BANKNIFTY', 'SENSEX'], MCX: ['CRUDEOIL', 'GOLD'] };

interface Row {
  arm: ObArm;
  symbol: string;
  session: string;
  time: number;
  direction: string;
  bucket: string;
  grossR: number;
  netFlatR: number;
  netModelledR: number | null;
  costR: number | null;
  liveWouldRefuse: boolean | null;
  exitKind: string;
  mfeR: number;
  maeR: number;
  barsHeld: number;
  stopAtr: number;
  rToT1: number | null;
  timing: string;
}

// --- the sweep-close report's cost inputs, unchanged ---
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
function loadChainCalibration(): Record<string, ChainCalibration> {
  const file = join(BACKTEST_DATA_DIR, 'option-chain-calibration.json');
  const cal = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (cal.SENSEX && (cal.SENSEX.spreadPct == null || Number.isNaN(cal.SENSEX.spreadPct)) && cal.NIFTY) cal.SENSEX = { ...cal.SENSEX, spreadPct: cal.NIFTY.spreadPct };
  return cal;
}
function monthAdd(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function walkForwardWindows(first: string, last: string) {
  const out: Array<{ testStart: string; testEnd: string }> = [];
  for (let start = monthAdd(first, 4); start < last; start = monthAdd(start, 2)) {
    const end = monthAdd(start, 2);
    out.push({ testStart: start, testEnd: end > last ? last : end });
  }
  return out;
}

function stats(rows: Row[], key: 'netModelledR' | 'netFlatR' | 'grossR') {
  const chrono = rows.filter((r) => r[key] != null).sort((a, b) => a.time - b.time);
  const v = chrono.map((r) => r[key] as number);
  if (!v.length) return { trades: 0, winRate: null, avgR: null, profitFactor: null, totalR: 0, maxDrawdownR: null };
  const gains = v.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -v.filter((x) => x <= 0).reduce((a, b) => a + b, 0);
  let cum = 0, peak = 0, dd = 0;
  for (const x of v) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { trades: v.length, winRate: round(v.filter((x) => x > 0).length / v.length), avgR: round(mean(v)), profitFactor: losses > 0 ? round(gains / losses) : null, totalR: round(cum), maxDrawdownR: round(dd) };
}
function shape(rows: Row[]) {
  const pct = (xs: number[]) => (xs.length ? { p25: round(percentile(xs, 25)), p50: round(percentile(xs, 50)), p75: round(percentile(xs, 75)) } : null);
  const exits: Record<string, number> = {};
  for (const r of rows) exits[r.exitKind] = (exits[r.exitKind] ?? 0) + 1;
  return {
    avgMfeR: rows.length ? round(mean(rows.map((r) => r.mfeR))) : null,
    avgMaeR: rows.length ? round(mean(rows.map((r) => r.maeR))) : null,
    avgBarsHeld: rows.length ? round(mean(rows.map((r) => r.barsHeld)), 1) : null,
    stopAtr: pct(rows.map((r) => r.stopAtr)),
    rToT1: pct(rows.map((r) => r.rToT1).filter((x): x is number => x != null)),
    exits,
    liveWouldRefusePct: rows.length ? round(rows.filter((r) => r.liveWouldRefuse).length / rows.length) : null,
  };
}

async function main() {
  const vix = loadVix();
  const chainCal = loadChainCalibration();
  const loaded = new Map(BACKTEST_SYMBOLS.map((spec) => [spec.symbol, loadSymbol(BACKTEST_DATA_DIR, spec)]));
  const nifty = loaded.get('NIFTY');
  if (!nifty) throw new Error('NIFTY snapshot required for the IS/OOS calendar split');
  const splitAt = splitDate(nifty.series.sessionDates);
  const sessions = [...nifty.series.sessionDates].sort();
  const windows = walkForwardWindows(sessions[0], sessions[sessions.length - 1]);

  const rows: Row[] = [];
  const signalCounts: Record<string, Record<string, unknown>> = {};
  for (const spec of BACKTEST_SYMBOLS) {
    const l = loaded.get(spec.symbol);
    if (!l) continue;
    const dailyCloses: number[] = [];
    for (let s = 0; s < l.series.sessionStarts.length; s++) {
      const end = (s + 1 < l.series.sessionStarts.length ? l.series.sessionStarts[s + 1] : l.series.bars.length) - 1;
      dailyCloses.push(l.series.bars[end].close);
    }
    const ordinal = new Map(l.series.sessionDates.map((d, i) => [d, i]));
    const sigmaOn = (session: string): number | null => {
      if (spec.symbol === 'NIFTY' || spec.symbol === 'BANKNIFTY') {
        const v = nearestOnOrBefore(vix, session);
        return v != null ? (v / 100) * (spec.symbol === 'NIFTY' ? 1.0 : 1.25) : null;
      }
      const idx = ordinal.get(session);
      const h = idx != null ? hv20(dailyCloses, idx) : null;
      return h != null ? h * 1.1 : null;
    };
    signalCounts[spec.symbol] = {};
    for (const arm of ARMS) {
      const r = runObArm(spec.symbol, l, spec.exchange, arm);
      signalCounts[spec.symbol][arm] = { signals: r.signals.size, ...r.skipped, candidates: r.run.candidates.length, trades: r.trades.length, rejected: r.rejected.length };
      const toRow = (g: GradedCandidate): Row => {
        const c = g.candidate;
        const sigma = sigmaOn(c.session);
        const chain = chainCal[spec.symbol];
        const cost = sigma != null && chain && Number.isFinite(chain.spreadPct)
          ? computeOptionCost({ symbol: spec.symbol, session: c.session, spot: c.entry, atr: c.atr, stopPoints: Math.abs(c.entry - c.stop), direction: c.direction, sigma, chain })
          : null;
        return {
          arm, symbol: spec.symbol, session: c.session, time: c.decisionTime, direction: c.direction, bucket: c.bucket,
          grossR: g.grossR, netFlatR: round(g.grossR - FLAT_COST_R), netModelledR: cost ? round(g.grossR - cost.costR) : null, costR: cost ? cost.costR : null,
          liveWouldRefuse: cost ? cost.liveWouldRefuse : null, exitKind: g.exitKind, mfeR: g.mfeR, maeR: g.maeR, barsHeld: g.barsHeld,
          stopAtr: round(Math.abs(c.entry - c.stop) / c.atr, 3), rToT1: c.rToT1, timing: c.timing.class,
        };
      };
      rows.push(...r.trades.map(toRow), ...r.rejected.map(toRow));
    }
  }

  const trades = rows.filter((r) => r.bucket === 'TRADE');
  const of = (arm: ObArm, symbols: string[], pred: (r: Row) => boolean = () => true) => trades.filter((r) => r.arm === arm && symbols.includes(r.symbol) && pred(r));
  const block = (rs: Row[]) => ({ modelled: stats(rs, 'netModelledR'), flat: stats(rs, 'netFlatR'), gross: stats(rs, 'grossR'), shape: shape(rs) });
  const isOos = (r: Row) => r.session >= splitAt;
  const isIs = (r: Row) => r.session < splitAt;

  const perGroup: Record<string, unknown> = {};
  const verdict: Record<string, unknown> = {};
  for (const [g, symbols] of Object.entries(GROUPS)) {
    const armReport: Record<string, any> = {};
    for (const arm of ARMS) {
      armReport[arm] = {
        all: block(of(arm, symbols)),
        is: block(of(arm, symbols, isIs)),
        oos: block(of(arm, symbols, isOos)),
        windows: windows.map((w) => ({ ...w, ...stats(of(arm, symbols, (r) => r.session >= w.testStart && r.session < w.testEnd), 'netModelledR') })),
      };
    }
    perGroup[g] = armReport;
    const judge = (arm: ObArm, withComparison: boolean) => {
      const o = armReport[arm].oos.modelled;
      const w = (armReport[arm].windows as any[]).filter((x) => x.avgR != null);
      const pos = w.filter((x) => x.avgR > 0).length;
      const base = armReport['15m'].oos.modelled.avgR;
      const checks = {
        avgNetR: { need: '>= +0.10', got: o.avgR, ok: (o.avgR ?? -Infinity) >= 0.1 },
        profitFactor: { need: '>= 1.2', got: o.profitFactor, ok: (o.profitFactor ?? 0) >= 1.2 },
        windows: { need: '>= 2/3 positive', got: `${pos}/${w.length}`, ok: w.length > 0 && pos / w.length >= 2 / 3 },
        ...(withComparison ? { beats15m: { need: '>= +0.10R over 15m', got: o.avgR != null && base != null ? round(o.avgR - base) : null, ok: o.avgR != null && base != null && o.avgR - base >= 0.1 } } : {}),
        trades: { need: '>= 100', got: o.trades, ok: o.trades >= 100 },
      };
      const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
      return { result: failed.length === 0 ? 'PASS' : failed.length === 1 && failed[0] === 'trades' ? 'INSUFFICIENT' : 'FAIL', failed, checks };
    };
    verdict[g] = { '1H': judge('1H', true), '15m (reference)': judge('15m', false) };
  }

  const perSymbol: Record<string, unknown> = {};
  for (const spec of BACKTEST_SYMBOLS) perSymbol[spec.symbol] = Object.fromEntries(ARMS.map((arm) => [arm, { all: stats(of(arm, [spec.symbol]), 'netModelledR'), oos: stats(of(arm, [spec.symbol], isOos), 'netModelledR') }]));

  const rejected: Record<string, unknown> = {};
  for (const arm of ARMS) for (const b of ['LOW_RR', 'NO_TARGET']) rejected[`${arm} ${b}`] = stats(rows.filter((r) => r.arm === arm && r.bucket === b), 'netModelledR');

  const report = { generatedAt: new Date().toISOString(), data: { first: sessions[0], last: sessions[sessions.length - 1], splitAt }, windows, signalCounts, verdict, perGroup, perSymbol, rejected };
  writeFileSync(join(BACKTEST_DATA_DIR, 'ob-timeframe-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'ob-timeframe-trades.json'), JSON.stringify(rows));
  writeFileSync(join(BACKTEST_DATA_DIR, 'ob-timeframe-report.md'), render(report));
  console.log(render(report));
}

const fmt = (s: any) => (!s || !s.trades ? 'n=0' : `n=${s.trades} win=${s.winRate} avgR=${s.avgR} PF=${s.profitFactor} total=${s.totalR}R maxDD=${s.maxDrawdownR}R`);

function render(r: any): string {
  const L: string[] = ['# OB1 timeframe test: 15m blocks vs 1H blocks + 15m entry (pre-registered, research only)', ''];
  L.push(`Data ${r.data.first} .. ${r.data.last}; out-of-sample from ${r.data.splitAt}. Modelled option cost unless stated.`, '');
  L.push('## Verdict (out-of-sample, pre-registered)');
  for (const [g, v] of Object.entries<any>(r.verdict)) for (const [arm, j] of Object.entries<any>(v)) L.push(`- **${g} ${arm}: ${j.result}**: ${Object.entries<any>(j.checks).map(([k, c]) => `${k} ${c.got} (${c.need}) ${c.ok ? 'ok' : 'MISS'}`).join('; ')}`);
  L.push('');
  for (const [g, arms] of Object.entries<any>(r.perGroup)) {
    L.push(`## ${g}`);
    for (const [arm, a] of Object.entries<any>(arms)) {
      L.push(`### ${arm}`);
      L.push(`- All: ${fmt(a.all.modelled)} | gross ${fmt(a.all.gross)}`);
      L.push(`- In-sample: ${fmt(a.is.modelled)}`);
      L.push(`- Out-of-sample: ${fmt(a.oos.modelled)} | flat 0.1R ${fmt(a.oos.flat)}`);
      L.push(`- Shape (all): MFE ${a.all.shape.avgMfeR}R, MAE ${a.all.shape.avgMaeR}R, bars ${a.all.shape.avgBarsHeld}, stop ATR p50 ${a.all.shape.stopAtr?.p50}, T1 R p50 ${a.all.shape.rToT1?.p50}, exits ${JSON.stringify(a.all.shape.exits)}, cost-refused ${a.all.shape.liveWouldRefusePct}`);
      L.push(`- Windows: ${a.windows.map((w: any) => `${w.testStart}: ${w.trades ? `${w.trades} @ ${w.avgR}R` : 'n=0'}`).join(' | ')}`);
    }
    L.push('');
  }
  L.push('## Per symbol (modelled; all / out-of-sample)');
  for (const [s, a] of Object.entries<any>(r.perSymbol)) L.push(`- **${s}** 15m ${fmt(a['15m'].all)} / ${fmt(a['15m'].oos)} || 1H ${fmt(a['1H'].all)} / ${fmt(a['1H'].oos)}`);
  L.push('', '## Rejected by the 1.5R floor (graded, never traded)');
  for (const [k, s] of Object.entries<any>(r.rejected)) L.push(`- ${k}: ${fmt(s)}`);
  L.push('', '## Signal funnel per symbol', '```', JSON.stringify(r.signalCounts, null, 1), '```');
  return L.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
