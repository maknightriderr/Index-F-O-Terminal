// ============================================================
// MOMENTUM-BREAK REPORT (the body of the backtest-momentum CLI)
// ============================================================
// Split out of cli/backtest-momentum.ts unchanged so the refactor test can
// render the report in memory and compare it byte for byte.
//
// Reads the snapshots in apps/server/backtest-data/ (fetch-history.ts), then:
//   1. splits the session calendar chronologically, first ⅔ in-sample;
//   2. runs the four pre-registered variants on the in-sample period only;
//   3. picks one by in-sample average net R;
//   4. runs THAT variant once on the out-of-sample ⅓ — no other variant is
//      ever run out of sample;
//   5. judges the out-of-sample result against the pre-registered go-live
//      bar and writes momentum-report.json / momentum-report.md.
// No database, no broker, no network.
// ============================================================

import { buildTradeSetup, evaluateMomentumBreak, istSlotOf, MOMENTUM_BREAK_VARIANTS, type MomentumBreakVariant } from '@fno/analytics';
import type { OptionChainLeg, OptionChainStrike } from '@fno/shared';
import {
  allowedSymbols,
  BACKTEST_SYMBOLS,
  chooseVariant,
  COST_R,
  GO_LIVE_BAR,
  groupStats,
  loadSymbol,
  passesGoLiveBar,
  replaySymbol,
  splitDate,
  statsOf,
  SYMBOL_MIN_OOS_TRADES,
  type BacktestTrade,
  type LoadedSymbol,
  type TradeStats,
} from './momentum-backtest.js';
import { TRADING_PARAM_DEFAULTS } from '../config/trading-flags.js';

const fmtR = (n: number | null) => (n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(3));
const fmtPct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtPf = (n: number | null) => (n == null ? '—' : n === Infinity ? '∞' : n.toFixed(2));
const row = (label: string, s: TradeStats) =>
  `| ${label} | ${s.trades} | ${fmtPct(s.winRate)} | ${fmtR(s.avgNetR)} | ${fmtR(s.totalNetR)} | ${fmtPf(s.profitFactor)} | ${s.maxDrawdownR.toFixed(2)} |`;
const HEADER = '| | Trades | Win % | Avg net R | Total net R | PF | Max DD (R) |\n|---|---:|---:|---:|---:|---:|---:|';

export interface MomentumReportOutput {
  lines: string[];
  report: Record<string, unknown>;
  /** True when only the in-sample half was run. */
  inSampleOnly: boolean;
}

export function renderMomentumReport(BACKTEST_DATA_DIR: string, opts: { inSampleOnly: boolean; quiet?: boolean }): MomentumReportOutput {
  const inSampleOnly = opts.inSampleOnly;
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
  const log = (s = '') => { lines.push(s); if (!opts.quiet) console.log(s); };

  log('# Momentum-break backtest');
  log();
  log(`In-sample ${inSample.from} → ${inSample.to}; out-of-sample ${outOfSample.from} → ${outOfSample.to} (chronological ⅔ / ⅓ of the ${calendar.spec.symbol} session calendar).`);
  log(`Cost ${COST_R}R per trade deducted. Go-live bar (pre-registered): OOS ≥ ${GO_LIVE_BAR.minTrades} trades, avg net R ≥ +${GO_LIVE_BAR.minAvgNetR}, PF ≥ ${GO_LIVE_BAR.minProfitFactor}. Allowed symbols: ≥ ${SYMBOL_MIN_OOS_TRADES} OOS trades and OOS avg net R ≥ 0.`);
  log();
  log('## Data');
  log();
  log('| Symbol | Bars | First bar | Last bar | Sessions | Volume coverage | Thin sessions masked | Roll dates (masked) |');
  log('|---|---:|---|---|---:|---:|---:|---|');
  for (const l of loaded) {
    const thin = [...l.masked.values()].filter((v) => v === 'THIN').length;
    const rolls = l.rolls.map((r) => `${r.date}${r.masked ? ` (gap ${r.gap}, ${r.gapAtr} ATR)` : ` (not masked, ${r.gapAtr} ATR)`}`).join('; ') || '—';
    log(`| ${l.spec.symbol} | ${l.series.bars.length} | ${l.firstBar} | ${l.lastBar} | ${l.series.sessionDates.length} | ${fmtPct(l.volumeCoverage)} | ${thin} | ${rolls} |`);
  }
  log();
  log(`Excluded: ${missing.join('; ')}.`);
  log();

  // ---- In-sample: all four variants ----
  const isResults = MOMENTUM_BREAK_VARIANTS.map((variant) => {
    const trades = loaded.flatMap((l) => replaySymbol(l, variant, inSample));
    return { variant, trades, stats: statsOf(trades) };
  });
  log('## In-sample, per variant (pooled across symbols)');
  log();
  log(HEADER);
  for (const r of isResults) log(row(r.variant.id, r.stats));
  log();
  for (const r of isResults) {
    log(`<details><summary>${r.variant.id} in-sample by symbol</summary>`);
    log();
    log(HEADER);
    for (const g of groupStats(r.trades, (t) => t.symbol)) log(row(g.key, g.stats));
    log();
    log('</details>');
    log();
  }
  const chosen = chooseVariant(isResults);
  log(`**Chosen on in-sample average net R: ${chosen.id}** (RANGE_MULT ${chosen.rangeMult}, VOL_MULT ${chosen.volMult}).`);
  log();

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    inSample,
    outOfSample,
    costR: COST_R,
    goLiveBar: GO_LIVE_BAR,
    data: loaded.map((l) => ({
      symbol: l.spec.symbol,
      bars: l.series.bars.length,
      firstBar: l.firstBar,
      lastBar: l.lastBar,
      sessions: l.series.sessionDates.length,
      volumeCoverage: l.volumeCoverage,
      masked: Object.fromEntries(l.masked),
      rolls: l.rolls,
      droppedPartial: l.droppedPartial,
      droppedOutOfSession: l.droppedOutOfSession,
    })),
    excluded: missing,
    inSampleResults: isResults.map((r) => ({ variant: r.variant, stats: r.stats, bySymbol: groupStats(r.trades, (t) => t.symbol) })),
    chosenVariant: chosen,
  };

  if (inSampleOnly) {
    log('(--in-sample-only: out-of-sample not run.)');
    return { lines, report, inSampleOnly: true };
  }

  // ---- Out-of-sample: the chosen variant, once ----
  const oosTrades = loaded.flatMap((l) => replaySymbol(l, chosen, outOfSample));
  const oos = statsOf(oosTrades);
  const bySymbol = groupStats(oosTrades, (t) => t.symbol);
  const passes = passesGoLiveBar(oos);
  const allowed = passes ? allowedSymbols(bySymbol) : [];
  log(`## Out-of-sample — ${chosen.id}, run once`);
  log();
  log(HEADER);
  log(row('**All symbols**', oos));
  for (const g of bySymbol) log(row(g.key, g.stats));
  log();
  log('### By level type');
  log();
  log(HEADER);
  for (const g of groupStats(oosTrades, (t) => t.signal.levelKind)) log(row(g.key, g.stats));
  log();
  log('### By decision hour (IST)');
  log();
  log(HEADER);
  for (const g of groupStats(oosTrades, (t) => String(t.hour).padStart(2, '0'))) log(row(`${g.key}:00`, g.stats));
  log();
  log('### By direction');
  log();
  log(HEADER);
  for (const g of groupStats(oosTrades, (t) => t.signal.direction)) log(row(g.key, g.stats));
  log();
  log('### By exit');
  log();
  log(HEADER);
  for (const g of groupStats(oosTrades, (t) => t.exit)) log(row(g.key, g.stats));
  log();
  log('## Go-live decision');
  log();
  const checks = [
    `trades ${oos.trades} ${oos.trades >= GO_LIVE_BAR.minTrades ? '≥' : '<'} ${GO_LIVE_BAR.minTrades}`,
    `avg net R ${fmtR(oos.avgNetR)} ${(oos.avgNetR ?? -Infinity) >= GO_LIVE_BAR.minAvgNetR ? '≥' : '<'} +${GO_LIVE_BAR.minAvgNetR}`,
    `PF ${fmtPf(oos.profitFactor)} ${(oos.profitFactor ?? -Infinity) >= GO_LIVE_BAR.minProfitFactor ? '≥' : '<'} ${GO_LIVE_BAR.minProfitFactor}`,
  ];
  log(`Out-of-sample: ${checks.join('; ')}.`);
  log();
  log(
    passes
      ? `**PASS.** MOMENTUM_BREAK ships default ON, limited to: ${allowed.join(', ') || '(no symbol met the per-symbol rule — effectively off)'}.`
      : `**FAIL.** The out-of-sample result does not meet the pre-registered bar. MOMENTUM_BREAK ships default OFF.`
  );
  log();

  // ---- Named case: 28 Sep CRUDEOIL 21:00-22:00 IST ----
  const named = namedCase(loaded.find((l) => l.spec.symbol === 'CRUDEOIL'), chosen, oosTrades);
  log('## Named case — 28 Sep 2026 CRUDEOIL, 21:00–22:00 IST');
  log();
  for (const l of named.lines) log(l);
  log();

  report.outOfSample = { ...outOfSample, variant: chosen, stats: oos, bySymbol, byLevel: groupStats(oosTrades, (t) => t.signal.levelKind), byHour: groupStats(oosTrades, (t) => t.hour), byDirection: groupStats(oosTrades, (t) => t.signal.direction), byExit: groupStats(oosTrades, (t) => t.exit) };
  report.decision = { passes, flagDefault: passes && allowed.length > 0, allowedSymbols: allowed };
  report.namedCase = named.data;
  report.oosTrades = oosTrades;
  return { lines, report, inSampleOnly: false };
}

/**
 * The bar-by-bar read over 28 Sep 21:00-22:00 IST with the chosen variant,
 * and — if it fired — the option leg through the real buildTradeSetup on an
 * ASSUMED ATM leg (₹460 premium, delta 0.5, ₹2 spread; the chain itself was
 * not captured), with the trigger stop passed exactly as the live path does.
 */
function namedCase(crude: LoadedSymbol | undefined, variant: MomentumBreakVariant, oosTrades: BacktestTrade[]) {
  const lines: string[] = [];
  if (!crude) return { lines: ['CRUDEOIL snapshot missing.'], data: null };
  const { series } = crude;
  const date = '2026-09-28';
  const idx = series.bars.map((b, i) => ({ b, i })).filter(({ i }) => series.sessionDates[series.sessionIdx[i]] === date);
  const inWindow = idx.filter(({ b }) => {
    const slot = istSlotOf(b.time);
    return slot >= '21:00' && slot < '22:00';
  });
  if (inWindow.length === 0) return { lines: [`No ${date} 21:00-22:00 bars in the snapshot.`], data: null };
  lines.push(`Masked session: ${crude.masked.get(date) ?? 'no'}. Variant ${variant.id}.`);
  lines.push('');
  lines.push('| Bar (IST) | O | H | L | C | Vol | Range ×ATR | Vol ×median | Close loc | Result |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  const evals = inWindow.map(({ b, i }) => {
    const ev = evaluateMomentumBreak(series, i, variant);
    lines.push(
      `| ${istSlotOf(b.time)}–${istSlotOf(b.time + 15 * 60000)} | ${b.open} | ${b.high} | ${b.low} | ${b.close} | ${b.volume} | ${ev.rangeMult?.toFixed(2) ?? '—'} | ${ev.volMult?.toFixed(2) ?? '—'} | ${ev.closeLocation?.toFixed(2) ?? '—'} | ${ev.signal ? `**FIRES ${ev.signal.direction}** through ${ev.signal.levelKind} ${ev.signal.levelPrice}` : ev.failed} |`
    );
    return { slot: istSlotOf(b.time), ev };
  });
  const fired = evals.find((e) => e.ev.signal);
  lines.push('');
  if (!fired) {
    lines.push('It would NOT have fired in this window.');
    return { lines, data: { fired: false, evals: evals.map((e) => ({ slot: e.slot, failed: e.ev.failed, rangeMult: e.ev.rangeMult, volMult: e.ev.volMult, closeLocation: e.ev.closeLocation })) } };
  }
  const sig = fired.ev.signal!;
  const decided = istSlotOf(sig.barTime + 15 * 60000);
  const trade = oosTrades.find((t) => t.symbol === 'CRUDEOIL' && t.signal.barTime === sig.barTime);
  lines.push(
    `It fires on the ${fired.slot} bar, decided at its close (${decided} IST): ${sig.direction} through ${sig.levelKind} ${sig.levelPrice}. ` +
      `Entry ${sig.entry}, stop ${sig.stop} (${Math.abs(sig.stop - sig.entry).toFixed(1)} pts), target ${sig.target} (${sig.targetKind}, ${Math.abs(sig.target - sig.entry).toFixed(1)} pts, ${sig.rUnderlying}R), ATR ${sig.atr}, quality ${sig.quality}.`
  );
  lines.push(
    trade
      ? `In the replay it exited ${trade.exit} at ${trade.exitPrice} (${istSlotOf(Date.parse(trade.exitAt))} IST): ${fmtR(trade.grossR)}R gross, ${fmtR(trade.netR)}R net.`
      : 'It is not in the out-of-sample trade list (masked session, a guard, or an open trade at the time).'
  );

  // The option leg: the live path hands the builder this exact stop.
  const premium = 460;
  const delta = 0.5;
  const stopDist = Math.abs(sig.stop - sig.entry);
  const slPremiumPct = Math.max(0.15, (delta * stopDist) / premium);
  const leg = (over: Partial<OptionChainLeg>): OptionChainLeg => ({
    token: 'ASSUMED', ltp: premium, bid: premium - 1, ask: premium + 1, volume: 20000, oi: 50000, changeOi: 0, changePercent: 0,
    iv: 0.45, delta: sig.direction === 'BEARISH' ? -delta : delta, gamma: 0.0005, theta: -6, vega: 8,
    oiInterpretation: 'NEUTRAL' as OptionChainLeg['oiInterpretation'], moneyness: 'ATM', greeksSource: 'BROKER', timestamp: 0, ...over,
  });
  const strike = Math.round(sig.entry / 50) * 50;
  const strikes: OptionChainStrike[] = [{ strike, distanceFromSpot: 0, call: leg({ delta }), put: leg({ delta: -delta }) }];
  const build = (ivVsHv: 'FAIR' | 'RICH') =>
    buildTradeSetup(strikes, strike, sig.direction, sig.quality, Math.abs(sig.target - sig.entry), slPremiumPct, null, 16, 100, sig.atr, {
      tickSize: 0.05,
      expectedHoldHours: 1.5,
      flags: { structuralStop: true, richIvRr: true },
      spot: sig.entry,
      nearestBehindLevel: sig.levelPrice,
      structuralStopBufferAtr: TRADING_PARAM_DEFAULTS.STRUCTURAL_STOP_BUFFER_ATR,
      ivVsHv,
      richIvMinRiskReward: TRADING_PARAM_DEFAULTS.RICH_IV_MIN_RISK_REWARD,
    });
  const fair = build('FAIR');
  const rich = build('RICH');
  lines.push(
    `Option leg (ASSUMED ATM ${sig.direction === 'BEARISH' ? 'PE' : 'CE'} ₹${premium}, |Δ| ${delta}, ₹2 spread, 16 DTE — the chain was not captured): ` +
      `premium stop = max(15%, |Δ|·${stopDist.toFixed(1)}/${premium}) = ${(slPremiumPct * 100).toFixed(1)}%; target move |Δ|·${Math.abs(sig.target - sig.entry).toFixed(1)} = ₹${(delta * Math.abs(sig.target - sig.entry)).toFixed(1)}.`
  );
  lines.push(`IV fair against HV (needs 1.5 after costs): ${fair.available ? `PASSES — entry ${fair.entry}, SL ${fair.stopLoss}, target ${fair.target}, R:R ${fair.riskReward}` : `REFUSED ${fair.noTradeCode} — ${fair.reason.split('. ')[0]}`}.`);
  lines.push(`IV rich against HV (needs 2.0 after costs): ${rich.available ? `PASSES — R:R ${rich.riskReward}` : `REFUSED ${rich.noTradeCode}`}.`);
  return {
    lines,
    data: {
      fired: true,
      signal: sig,
      decidedAtIst: decided,
      trade: trade ?? null,
      option: { assumed: { premium, delta, spread: 2, dte: 16 }, slPremiumPct, fair: { available: fair.available, code: fair.noTradeCode ?? null, riskReward: fair.riskReward ?? null }, rich: { available: rich.available, code: rich.noTradeCode ?? null, riskReward: rich.riskReward ?? null } },
      evals: evals.map((e) => ({ slot: e.slot, failed: e.ev.failed, rangeMult: e.ev.rangeMult, volMult: e.ev.volMult, closeLocation: e.ev.closeLocation })),
    },
  };
}
