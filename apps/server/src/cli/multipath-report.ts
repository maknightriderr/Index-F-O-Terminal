// ============================================================
// CLI: multi-path event engine research report (research only, read-only)
// ============================================================
// npm run multipath-report --workspace=@fno/server [-- --unseal=A2,B4]
//
// Writes apps/server/backtest-data/multipath-report.{json,md}. Touches no
// live code path, flag or gate.
//
// OUT-OF-SAMPLE IS SEALED BY DEFAULT. Performance is reported on the
// in-sample period only (the first ⅔ of the NIFTY calendar). With 18
// candidate rules, picking the best in-sample number is selection; the
// out-of-sample period is the one honest check, and it is spent one
// pre-registered trigger at a time with --unseal=<ids>. Counts, timing,
// move potential and the major-move diagnosis carry no outcome and cover the
// whole period.
// ============================================================

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRIGGER_REGISTRY, EVENT_RULES, EVENT_ENGINE_TRIGGER_IDS, arbitrateParents, type TriggerCandidate } from '@fno/analytics';
import { BACKTEST_SYMBOLS, loadSymbol, splitDate } from '../backtest/harness.js';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { runMultiPath, gradeTrigger, gradeCandidate, type MultiPathRun, type GradedCandidate } from '../research/multipath.js';
import { loadVix, loadChainCalibration, makeOptionCoster } from '../research/research-cost.js';
import { profitFactor, maxDrawdown } from '../services/diagnostics-metrics.js';
import { gradePath } from '../services/grade-path.js';
import { round, mean } from '../research/stats.js';

const FLAT_COST_R = 0.1;
const GROUPS: Record<string, string[]> = { INDEX: ['NIFTY', 'BANKNIFTY', 'SENSEX'], MCX: ['CRUDEOIL', 'GOLD'] };
const groupOf = (symbol: string) => (GROUPS.MCX.includes(symbol) ? 'MCX' : 'INDEX');

interface Row extends GradedCandidate {
  session: string;
  group: string;
  netFlatR: number;
  netModelledR: number | null;
  costR: number | null;
  liveWouldRefuse: boolean | null;
}

function stats(rows: Row[], key: 'grossR' | 'netFlatR' | 'netModelledR') {
  const chrono = rows.filter((r) => r[key] != null).sort((a, b) => a.candidate.decisionTime - b.candidate.decisionTime);
  const vals = chrono.map((r) => r[key] as number);
  if (vals.length === 0) return { n: 0, winRate: null, avgR: null, pf: null, maxDD: null, lowN: true };
  return {
    n: vals.length,
    winRate: round(vals.filter((v) => v > 0).length / vals.length),
    avgR: round(mean(vals)),
    pf: profitFactor(vals),
    maxDD: maxDrawdown(vals),
    lowN: vals.length < 30,
  };
}

const dist = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});

function monthAdd(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function main() {
  const unsealArg = process.argv.find((a) => a.startsWith('--unseal='));
  const unseal = new Set((unsealArg?.split('=')[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const vix = loadVix();
  const chainCal = loadChainCalibration();

  const runs: MultiPathRun[] = [];
  for (const spec of BACKTEST_SYMBOLS) {
    const loaded = loadSymbol(BACKTEST_DATA_DIR, spec);
    if (!loaded) continue;
    const t0 = Date.now();
    runs.push(runMultiPath(spec.symbol, loaded, spec.exchange));
    console.log(`${spec.symbol}: ${runs[runs.length - 1].candidates.length} candidates in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const nifty = runs.find((r) => r.symbol === 'NIFTY');
  if (!nifty) throw new Error('NIFTY snapshot required for the IS/OOS calendar split');
  const dates = [...nifty.ctx.series.sessionDates].sort();
  const splitAt = splitDate(dates);
  const [firstSession, lastSession] = [dates[0], dates[dates.length - 1]];
  const windows: Array<{ testStart: string; testEnd: string }> = [];
  for (let ts = monthAdd(firstSession, 4); ts < lastSession; ts = monthAdd(ts, 2)) windows.push({ testStart: ts, testEnd: monthAdd(ts, 2) > lastSession ? lastSession : monthAdd(ts, 2) });

  const costers = new Map(runs.map((r) => [r.symbol, makeOptionCoster(r.symbol, r.ctx.series, vix, chainCal[r.symbol])]));
  const toRow = (g: GradedCandidate): Row => {
    const c = g.candidate;
    const cost = costers.get(g.symbol)!({ session: c.session, entry: c.entry, atr: c.atr, stopPoints: Math.abs(c.entry - c.stop), direction: c.direction });
    return { ...g, session: c.session, group: groupOf(g.symbol), netFlatR: round(g.grossR - FLAT_COST_R), netModelledR: cost ? round(g.grossR - cost.costR) : null, costR: cost?.costR ?? null, liveWouldRefuse: cost?.liveWouldRefuse ?? null };
  };

  // ---- Per trigger ----
  // S1 is the structure engine itself (its own backtest: backtest-structure); the rest are event-engine rules.
  const triggers = TRIGGER_REGISTRY.filter((def) => EVENT_ENGINE_TRIGGER_IDS.includes(def.triggerId)).map((def) => {
    const all: TriggerCandidate[] = runs.flatMap((r) => r.candidates.filter((c) => c.triggerId === def.triggerId));
    const trades: Row[] = [];
    const rejected: Row[] = [];
    for (const run of runs) {
      const g = gradeTrigger(run, def.triggerId);
      trades.push(...g.trades.map(toRow));
      rejected.push(...g.rejected.map(toRow));
    }
    const tradeCands = all.filter((c) => c.bucket === 'TRADE');
    const is = (rows: Row[]) => rows.filter((r) => r.session < splitAt);
    const oos = (rows: Row[]) => rows.filter((r) => r.session >= splitAt);
    const perGroup = (rows: Row[]) =>
      Object.fromEntries(Object.entries(GROUPS).map(([g]) => [g, { gross: stats(rows.filter((r) => r.group === g), 'grossR'), flat: stats(rows.filter((r) => r.group === g), 'netFlatR'), modelled: stats(rows.filter((r) => r.group === g), 'netModelledR') }]));
    const unsealed = unseal.has(def.triggerId);
    let oosBlock: unknown = 'SEALED';
    if (unsealed) {
      const pass = Object.fromEntries(
        Object.keys(GROUPS).map((g) => {
          const o = stats(oos(trades).filter((r) => r.group === g), 'netModelledR');
          const w = windows.map((win) => stats(trades.filter((r) => r.group === g && r.session >= win.testStart && r.session < win.testEnd), 'netModelledR').avgR).filter((v): v is number => v != null);
          const pos = w.filter((v) => v > 0).length;
          const ok = (o.avgR ?? -1) >= 0.1 && (o.pf ?? 0) >= 1.2 && o.n >= 100 && w.length > 0 && pos / w.length >= 2 / 3;
          return [g, { pass: ok, oos: o, windowsPositive: `${pos}/${w.length}` }];
        })
      );
      oosBlock = { perGroup: perGroup(oos(trades)), passBar: pass };
    }
    return {
      triggerId: def.triggerId,
      family: def.family,
      name: def.name,
      status: def.status,
      priorEvidence: def.priorEvidence ?? null,
      candidates: all.length,
      buckets: dist(all.map((c) => c.bucket)),
      perSession: round(all.length / Math.max(1, runs.reduce((a, r) => a + r.logs.size, 0)), 3),
      timing: dist(tradeCands.map((c) => c.timing.class)),
      movePotential: dist(tradeCands.map((c) => c.movePotential.class)),
      marketState: dist(tradeCands.map((c) => c.marketState)),
      medianRToT1: tradeCands.length ? round([...tradeCands.map((c) => c.rToT1!)].sort((a, b) => a - b)[Math.floor(tradeCands.length / 2)]) : null,
      liveWouldRefusePct: trades.length ? round(trades.filter((t) => t.liveWouldRefuse).length / trades.length) : null,
      inSample: { trades: perGroup(is(trades)), rejected: perGroup(is(rejected)) },
      inSampleBySymbol: Object.fromEntries(runs.map((run) => [run.symbol, { gross: stats(is(trades).filter((t) => t.symbol === run.symbol), 'grossR'), modelled: stats(is(trades).filter((t) => t.symbol === run.symbol), 'netModelledR') }])),
      outOfSample: oosBlock,
    };
  });

  // ---- The arbitrated book: one selected setup per parent move, one trade at a time per symbol (in-sample) ----
  // Retired rules are left out (their evidence is already on record); eligibility at decision time = TRADE geometry.
  const arbitratedRows: Row[] = [];
  for (const run of runs) {
    const live = run.candidates.map((c) => TRIGGER_REGISTRY.find((t) => t.triggerId === c.triggerId)?.status !== 'RETIRED');
    const decisions = arbitrateParents(run.parents, run.candidates, (idx) => ({ eligible: run.candidates[idx].bucket === 'TRADE', ineligibleReason: run.candidates[idx].bucket, stageAllowed: live[idx], netR: null }));
    const selected = [...decisions.entries()].filter(([, d]) => d.role === 'SELECTED').map(([idx]) => run.candidates[idx]).sort((a, b) => a.decisionIndex - b.decisionIndex);
    let busyUntil = -1;
    for (const c of selected) {
      if (c.decisionIndex <= busyUntil) continue;
      const g = gradeCandidate(run, c);
      if (!g) continue;
      arbitratedRows.push(toRow(g));
      busyUntil = c.decisionIndex + g.barsHeld;
    }
  }
  const arbitrated = Object.fromEntries(
    Object.keys(GROUPS).map((g) => {
      const rows = arbitratedRows.filter((r) => r.group === g && r.session < splitAt);
      return [g, { gross: stats(rows, 'grossR'), modelled: stats(rows, 'netModelledR'), selectedBy: dist(rows.map((r) => r.candidate.triggerId)) }];
    })
  );

  // ---- Parent setups and entry stages (in-sample, gross) ----
  const stageRows: Record<string, number[]> = { firstAvailable: [], bos: [], displacement: [], retest: [] };
  let parentCount = 0;
  let multiFamily = 0;
  let candidatesInParents = 0;
  for (const run of runs) {
    const bars = run.ctx.series.bars;
    for (const p of run.parents) {
      parentCount++;
      candidatesInParents += p.candidates.length;
      if (p.families.length > 1) multiFamily++;
      if (p.session >= splitAt) continue;
      const first = p.candidates.map((k) => run.candidates[k]).sort((a, b) => a.decisionIndex - b.decisionIndex).find((c) => c.bucket === 'TRADE');
      if (!first || !first.t1) continue;
      const s = run.ctx.series.sessionDates.indexOf(p.session);
      const end = run.ctx.sessionEnd(s);
      const dir: 1 | -1 = first.direction === 'BULLISH' ? 1 : -1;
      for (const [stage, idx] of Object.entries(p.stages)) {
        if (idx == null || idx < first.anchorIndex) continue;
        const entry = bars[idx].close;
        const risk = (entry - first.stop) * dir;
        if (!(risk > 0) || (first.t1.price - entry) * dir <= 0) continue;
        const path = gradePath(bars.slice(idx + 1, end + 1), dir, entry, first.stop, first.t1.price);
        stageRows[stage].push(round(path.settledR));
      }
    }
  }
  const entryStages = Object.fromEntries(Object.entries(stageRows).map(([k, v]) => [k, { n: v.length, avgGrossR: v.length ? round(mean(v)) : null, pf: profitFactor(v) }]));

  // ---- Events, states, coverage, major moves (whole period, no outcomes) ----
  const perSymbol = runs.map((run) => {
    const sessions = Math.max(1, run.logs.size);
    const evCounts = dist([...run.logs.values()].flatMap((l) => l.events.map((e) => e.type)));
    const states = dist(run.ctx.series.bars.map((_, i) => run.ctx.stateAt(i)));
    return {
      symbol: run.symbol,
      sessions: run.logs.size,
      coverage: dist([...run.coverage.values()].map((c) => c.coverage)),
      eventsPerSession: Object.fromEntries(Object.entries(evCounts).map(([k, v]) => [k, round(v / sessions, 2)])),
      marketStateShare: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, round(v / run.ctx.series.bars.length, 3)])),
      majorMoves: {
        count: run.majorMoves.length,
        classification: dist(run.majorMoves.map((m) => m.classification)),
        familiesRecognized: dist(run.majorMoves.flatMap((m) => m.familiesRecognized)),
        firstEventType: dist(run.majorMoves.map((m) => m.firstEvent?.type ?? 'NONE')),
        // Why no actionable setup on RISK_REJECTED moves: the buckets of the candidates that did fire during them.
        riskRejectedBuckets: dist(
          run.majorMoves
            .filter((m) => m.classification === 'RISK_REJECTED')
            .flatMap((m) => run.candidates.filter((c) => c.session === m.move.session && c.direction === m.move.direction && c.decisionIndex >= m.move.startIndex && c.decisionIndex <= m.move.endIndex).map((c) => c.bucket))
        ),
        avgRemainingAtFirstActionable: (() => {
          const v = run.majorMoves.map((m) => m.firstActionable?.remainingMovePct).filter((x): x is number => x != null);
          return v.length ? round(mean(v)) : null;
        })(),
      },
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    splitAt,
    firstSession,
    lastSession,
    walkForwardWindows: windows,
    unsealed: [...unseal],
    rules: EVENT_RULES,
    registry: TRIGGER_REGISTRY,
    triggers,
    arbitratedInSample: arbitrated,
    parents: { count: parentCount, multiFamilyShare: parentCount ? round(multiFamily / parentCount) : null, avgCandidatesPerParent: parentCount ? round(candidatesInParents / parentCount, 2) : null, entryStagesInSample: entryStages },
    perSymbol,
  };
  writeFileSync(join(BACKTEST_DATA_DIR, 'multipath-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'multipath-report.md'), renderMarkdown(report));
  console.log(`Wrote multipath-report.json / .md — ${triggers.reduce((a, t) => a + t.candidates, 0)} candidates, OOS ${unseal.size ? `unsealed for ${[...unseal].join(',')}` : 'sealed'}.`);
}

const fmt = (s: any) => (!s || s.n === 0 ? 'n=0' : `n=${s.n} win=${s.winRate} avgR=${s.avgR} PF=${s.pf ?? '—'} maxDD=${s.maxDD}R${s.lowN ? ' (low n)' : ''}`);

function renderMarkdown(r: any): string {
  const L: string[] = [];
  L.push('# Multi-path event engine — research report');
  L.push('');
  L.push(`Generated ${r.generatedAt}. Data ${r.firstSession} .. ${r.lastSession}. In-sample before ${r.splitAt}. Out-of-sample: ${r.unsealed.length ? `unsealed for ${r.unsealed.join(', ')}` : '**sealed**'}.`);
  L.push('');
  L.push('Every figure is a simulated outcome on the underlying, in R of the rule\'s own stop, before (gross) and after modelled option cost. With 18 rules, the best in-sample row is partly luck; only a pre-registered out-of-sample run decides anything.');
  L.push('');
  L.push('## Triggers (in-sample, modelled cost, per group)');
  L.push('');
  L.push('| Trigger | Family | Status | Candidates | TRADE | INDEX IS | MCX IS | Timing (TRADE) |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of r.triggers) {
    L.push(`| ${t.triggerId} ${t.name} | ${t.family} | ${t.status} | ${t.candidates} | ${t.buckets.TRADE ?? 0} | ${fmt(t.inSample.trades.INDEX.modelled)} | ${fmt(t.inSample.trades.MCX.modelled)} | ${Object.entries(t.timing).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  }
  L.push('');
  L.push('## Triggers (in-sample, gross before cost)');
  L.push('');
  for (const t of r.triggers) {
    L.push(`- **${t.triggerId}** INDEX ${fmt(t.inSample.trades.INDEX.gross)} · MCX ${fmt(t.inSample.trades.MCX.gross)} · median T1 ${t.medianRToT1}R · live would refuse ${t.liveWouldRefusePct}`);
    L.push(`  - by symbol (gross | modelled): ${Object.entries<any>(t.inSampleBySymbol).map(([sym, v]) => `${sym} ${v.gross.n ? `${v.gross.avgR} | ${v.modelled.avgR ?? '—'} (n=${v.gross.n})` : 'n=0'}`).join(' · ')}`);
  }
  if (r.unsealed.length) {
    L.push('');
    L.push('## Out-of-sample (unsealed triggers only)');
    for (const t of r.triggers.filter((x: any) => x.outOfSample !== 'SEALED')) {
      for (const [g, p] of Object.entries<any>(t.outOfSample.passBar)) L.push(`- **${t.triggerId} ${g}: ${p.pass ? 'PASS' : 'FAIL'}** — ${fmt(p.oos)}, windows positive ${p.windowsPositive}`);
    }
  }
  L.push('');
  L.push('## Arbitrated book: one selected setup per parent move (in-sample)');
  for (const [g, a] of Object.entries<any>(r.arbitratedInSample)) L.push(`- **${g}** gross ${fmt(a.gross)} · modelled ${fmt(a.modelled)} · selected by ${JSON.stringify(a.selectedBy)}`);
  L.push('');
  L.push('## Parent setups and entry stages (in-sample, gross)');
  L.push(`${r.parents.count} parents; ${r.parents.avgCandidatesPerParent} candidates each on average; ${r.parents.multiFamilyShare} recognised by more than one family.`);
  for (const [k, v] of Object.entries<any>(r.parents.entryStagesInSample)) L.push(`- ${k}: n=${v.n} avg gross R=${v.avgGrossR} PF=${v.pf ?? '—'}`);
  L.push('');
  L.push('## Per symbol: coverage, events, major moves (whole period, no outcomes)');
  for (const s of r.perSymbol) {
    L.push(`### ${s.symbol}`);
    L.push(`- Sessions ${s.sessions}; coverage ${JSON.stringify(s.coverage)}`);
    L.push(`- Candidates fired during RISK_REJECTED moves, by bucket: ${JSON.stringify(s.majorMoves.riskRejectedBuckets)}`);
    L.push(`- Major moves ${s.majorMoves.count}: ${JSON.stringify(s.majorMoves.classification)}; first event ${JSON.stringify(s.majorMoves.firstEventType)}; families recognising ${JSON.stringify(s.majorMoves.familiesRecognized)}; avg move left at first actionable ${s.majorMoves.avgRemainingAtFirstActionable}`);
    L.push(`- Market state share ${JSON.stringify(s.marketStateShare)}`);
  }
  L.push('');
  return L.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
