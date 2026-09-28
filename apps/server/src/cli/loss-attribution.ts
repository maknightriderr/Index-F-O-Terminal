// ============================================================
// CLI — LOSS ATTRIBUTION (Phase 1, read-only)
// ============================================================
//   npm run loss-attribution -- report   the 12 pre-built questions
//   npm run loss-attribution -- exits    exit-reason mix, overall and by
//                                        strategy / symbol / DTE / delta / regime
//   npm run loss-attribution -- dead     trades trade-health flagged dead:
//                                        did they recover?
//   npm run loss-attribution -- split    in-sample vs out-of-sample, split at
//                                        DATA_QUALITY_CUTOVER_AT
//   npm run loss-attribution -- gates    per-gate pass/fail from gate_diagnostics
//   npm run loss-attribution -- json     the full report as JSON
//
// Phase 2:
//   npm run loss-attribution -- shadow-comparison
//                                        shadow strike / ask-execution / gamma-theta
//                                        target vs what the live engine did
//   npm run loss-attribution -- invalidation
//                                        outcomes by which close branch fired
//                                        (premium stop/target vs bias reversal)
//   npm run loss-attribution -- exposure outcomes by concurrent same-direction /
//                                        correlated paper exposure at creation
//
// Phase 3:
//   npm run loss-attribution -- opening-hour
//                                        the opening 60 minutes broken into
//                                        15-minute sub-windows x opening
//                                        environment label
//   npm run loss-attribution -- cooldown-effectiveness
//                                        outcomes re-bucketed by minutes since
//                                        the last recoverable stop-loss
//
// Options: --since YYYY-MM-DD  --until YYYY-MM-DD  --refusals (grade refused
// decisions instead of taken paper trades)  --all (both)
//
// Every figure is a SIMULATED paper-trade outcome. Nothing here is account
// P&L, and nothing here changes what the engine does.
// ============================================================

import { sql } from '../lib/db.js';
import {
  loadAttributionRows,
  lossAttributionReport,
  lossAttributionSplitReport,
  gateFailureSummary,
  shadowComparisonReport,
  openingHourReport,
  cooldownEffectivenessReport,
  type AttributionQuery,
  type DecisionScope,
} from '../services/loss-attribution.js';
import {
  groupBy,
  buckets,
  SIMULATION_NOTE,
  type AttributionReport,
  type GroupStats,
  type OpeningHourReport,
  type CooldownEffectivenessReport,
} from '../services/loss-attribution-model.js';
import type { ShadowComparisonReport } from '../services/shadow-comparison-model.js';

const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
const rpad = (s: unknown, n: number) => String(s ?? '').padStart(n);
const rule = (n = 96) => '-'.repeat(n);
const fmt = (v: number | null, d = 2) => (v == null ? '—' : v.toFixed(d));

function head(title: string): void {
  console.log(`\n${title}`);
  console.log(rule());
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function query(): AttributionQuery {
  const since = argValue('--since');
  const until = argValue('--until');
  const decision: DecisionScope = process.argv.includes('--all') ? 'ALL' : process.argv.includes('--refusals') ? 'REFUSE' : 'TAKE';
  return {
    since: since ? new Date(`${since}T00:00:00+05:30`) : null,
    until: until ? new Date(`${until}T00:00:00+05:30`) : null,
    decision,
  };
}

function printGroups(groups: GroupStats[], keyWidth = 34): void {
  console.log(
    `${pad('group', keyWidth)} ${rpad('n', 5)} ${rpad('sample', 13)} ${rpad('win%', 7)} ${rpad('avg simR', 9)} ${rpad('tot simR', 9)} ${rpad('premR n', 8)} ${rpad('avg premR', 10)}`
  );
  for (const g of groups) {
    console.log(
      `${pad(g.key.slice(0, keyWidth), keyWidth)} ${rpad(g.n, 5)} ${rpad(g.sample, 13)} ${rpad(fmt(g.winRate, 1), 7)} ${rpad(fmt(g.avgSimR), 9)} ${rpad(fmt(g.totalSimR), 9)} ${rpad(g.premiumR.n, 8)} ${rpad(fmt(g.premiumR.avg), 10)}`
    );
  }
}

function printExitMix(groups: GroupStats[], keyWidth = 30): void {
  console.log(`${pad('group', keyWidth)} ${rpad('n', 5)} ${rpad('TARGET%', 8)} ${rpad('STOP%', 7)} ${rpad('TIME%', 7)} ${rpad('INVAL%', 7)} ${rpad('OTHER%', 7)}`);
  for (const g of groups) {
    const p = g.exitReasonPct;
    const other = p.OTHER == null ? null : (p.OTHER ?? 0) + (p.EXPIRY ?? 0) + (p.MANUAL_TEST_EXIT ?? 0);
    console.log(
      `${pad(g.key.slice(0, keyWidth), keyWidth)} ${rpad(g.n, 5)} ${rpad(fmt(p.TARGET, 1), 8)} ${rpad(fmt(p.STOP, 1), 7)} ${rpad(fmt(p.TIME_EXIT, 1), 7)} ${rpad(fmt(p.INVALIDATED, 1), 7)} ${rpad(fmt(other, 1), 7)}`
    );
  }
}

function printReport(report: AttributionReport): void {
  console.log(`\n${report.note}`);
  console.log(`Population: ${report.population.rows} rows (${report.population.graded} graded), ${report.population.from ?? '—'} → ${report.population.to ?? '—'}`);
  head('OVERALL');
  printGroups([report.overall]);
  for (const q of report.questions) {
    head(`${q.id}. ${q.question}   [by ${q.dimension}]`);
    printGroups(q.groups);
  }
  head('MAE (how far trades went against the thesis)');
  printGroups(report.mae);
}

function printShadowComparison(r: ShadowComparisonReport): void {
  console.log(`\n${r.note}`);
  console.log(`Population: ${r.population.rows} taken paper trades with shadow data, ${r.population.from ?? '—'} → ${r.population.to ?? '—'}`);
  console.log('\nCAVEATS');
  for (const c of r.caveats) console.log(`  - ${c}`);
  if (r.population.rows === 0) {
    console.log('\nNo shadow data yet — the shadow columns populate only for decisions recorded after the Phase 2 deploy.');
  }

  head('STRIKE — shadow candidate scorer vs live ATM pick');
  console.log(
    `${pad('dte bucket', 12)} ${rpad('n', 5)} ${rpad('sample', 13)} ${rpad('differs', 8)} ${rpad('differs%', 9)} ${rpad('liveR agreed (n)', 18)} ${rpad('liveR differed (n)', 19)}`
  );
  for (const g of [r.strike.overall, ...r.strike.byDte]) {
    console.log(
      `${pad(g.key, 12)} ${rpad(g.n, 5)} ${rpad(g.sample, 13)} ${rpad(g.differs, 8)} ${rpad(fmt(g.differsPct, 1), 9)} ${rpad(`${fmt(g.livePremiumRWhenAgreed.avg)} (${g.livePremiumRWhenAgreed.n})`, 18)} ${rpad(`${fmt(g.livePremiumRWhenDiffered.avg)} (${g.livePremiumRWhenDiffered.n})`, 19)}`
    );
  }

  head('EXECUTION — ask entry (shadow) vs mid entry (live), same stop/target');
  console.log(
    `${pad('dte bucket', 12)} ${rpad('n', 5)} ${rpad('sample', 13)} ${rpad('degraded', 9)} ${rpad('live netR', 10)} ${rpad('shadow netR', 12)} ${rpad('R delta', 9)} ${rpad('slip %', 8)}`
  );
  for (const g of [r.execution.overall, ...r.execution.byDte]) {
    console.log(
      `${pad(g.key, 12)} ${rpad(g.n, 5)} ${rpad(g.sample, 13)} ${rpad(g.degraded, 9)} ${rpad(fmt(g.avgLiveNetR), 10)} ${rpad(fmt(g.avgShadowNetR), 12)} ${rpad(fmt(g.avgNetRDelta), 9)} ${rpad(fmt(g.avgEntrySlippagePct), 8)}`
    );
  }

  head('TARGET — gamma/theta target v2 (shadow) vs delta-only target (live)');
  console.log(
    `${pad('dte bucket', 12)} ${rpad('n', 5)} ${rpad('sample', 13)} ${rpad('div pts', 8)} ${rpad('div %entry', 11)} ${rpad('v2<live %', 10)} ${rpad('v2 netR', 8)} ${rpad('live netR', 10)} ${rpad('hit% v2<live (n)', 17)} ${rpad('hit% v2>=live (n)', 18)}`
  );
  for (const g of [r.target.overall, ...r.target.byDte]) {
    const lo = g.liveTargetHitRate.v2Below;
    const hi = g.liveTargetHitRate.v2AtOrAbove;
    console.log(
      `${pad(g.key, 12)} ${rpad(g.n, 5)} ${rpad(g.sample, 13)} ${rpad(fmt(g.avgDivergencePts), 8)} ${rpad(fmt(g.avgDivergencePctOfEntry), 11)} ${rpad(fmt(g.v2BelowLivePct, 1), 10)} ${rpad(fmt(g.avgShadowExpectedNetRV2), 8)} ${rpad(fmt(g.avgLiveNetR), 10)} ${rpad(`${fmt(lo.pct, 1)} (${lo.n})`, 17)} ${rpad(`${fmt(hi.pct, 1)} (${hi.n})`, 18)}`
    );
  }
}

function printOpeningHour(r: OpeningHourReport): void {
  console.log(`\n${r.note}`);
  head('OVERALL — opening window (0-60m)');
  printGroups([r.overall]);
  head('BY 15-MINUTE SUB-WINDOW');
  printGroups(r.byWindow);
  head('BY OPENING ENVIRONMENT');
  printGroups(r.byEnvironment);
  head('SUB-WINDOW x OPENING ENVIRONMENT');
  printGroups(r.byWindowAndEnvironment, 46);
}

function printCooldownEffectiveness(r: CooldownEffectivenessReport): void {
  console.log(`\n${r.note}`);
  head('OVERALL — followed a recoverable recent loss');
  printGroups([r.overall]);
  head('BY BUCKET');
  printGroups(r.byBucket, 46);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const q = query();
  console.log(`LOSS ATTRIBUTION — scope: ${q.decision === 'TAKE' ? 'taken paper trades' : q.decision === 'REFUSE' ? 'refused decisions (hypothetical)' : 'all decisions'}`);

  switch (cmd) {
    case 'report':
      printReport(await lossAttributionReport(q));
      break;
    case 'exits': {
      const rows = await loadAttributionRows(q);
      console.log(`\n${SIMULATION_NOTE}`);
      head('EXIT REASONS — overall');
      printExitMix(groupBy(rows, () => 'ALL'));
      head('EXIT REASONS — by strategy');
      printExitMix(groupBy(rows, (r) => r.strategy));
      head('EXIT REASONS — by symbol');
      printExitMix(groupBy(rows, (r) => r.symbol));
      head('EXIT REASONS — by DTE');
      printExitMix(groupBy(rows, (r) => buckets.dte(r.dte)));
      head('EXIT REASONS — by delta');
      printExitMix(groupBy(rows, (r) => buckets.delta(r.delta)));
      head('EXIT REASONS — by regime');
      printExitMix(groupBy(rows, (r) => r.regime ?? 'UNKNOWN'));
      break;
    }
    case 'dead': {
      const report = await lossAttributionReport(q);
      head('DEAD-TRADE ANALYTICS');
      console.log(report.deadTrades.note);
      printGroups([report.deadTrades.flaggedDead, report.deadTrades.neverFlagged]);
      console.log(`\nRecovered (premium close above zero) after being flagged dead: ${fmt(report.deadTrades.recoveredPct, 1)}%`);
      head('EXIT MIX — dead vs never flagged');
      printExitMix([report.deadTrades.flaggedDead, report.deadTrades.neverFlagged]);
      break;
    }
    case 'split': {
      const split = await lossAttributionSplitReport(q);
      console.log(`\nSplit at ${split.splitAt}\n${split.splitReason}`);
      console.log('Sample sizes are stated per group. A difference between the halves on INSUFFICIENT or LOW groups is not evidence.');
      console.log('\n==================== IN-SAMPLE (before cutover) ====================');
      printReport(split.inSample);
      console.log('\n==================== OUT-OF-SAMPLE (after cutover) ====================');
      printReport(split.outOfSample);
      break;
    }
    case 'gates': {
      const rows = await gateFailureSummary(q);
      head('GATE DIAGNOSTICS — each gate evaluated independently (observation only)');
      console.log(`${pad('gate', 22)} ${rpad('pass', 7)} ${rpad('fail', 7)} ${rpad('n/e', 7)} ${rpad('deciding', 9)} ${rpad('also-failed', 12)}`);
      for (const r of rows) {
        console.log(`${pad(r.gate, 22)} ${rpad(r.pass, 7)} ${rpad(r.fail, 7)} ${rpad(r.notEvaluated, 7)} ${rpad(r.decidingCount, 9)} ${rpad(r.failedButNotDeciding, 12)}`);
      }
      if (rows.length === 0) console.log('No gate diagnostics recorded yet — they are written from Phase 1 onward.');
      break;
    }
    case 'json':
      console.log(JSON.stringify(await lossAttributionReport(q), null, 2));
      break;
    case 'shadow-comparison':
      // Always taken paper trades: shadow models are recorded on TAKE rows only.
      printShadowComparison(await shadowComparisonReport(q));
      break;
    case 'invalidation': {
      const report = await lossAttributionReport(q);
      console.log(`\n${SIMULATION_NOTE}`);
      head('OUTCOMES BY CLOSE BRANCH — premium stop/target (checked first) vs underlying bias reversal');
      console.log('Labelled from Phase 2 onward; earlier rows group as NOT_RECORDED.');
      printGroups(report.invalidation);
      break;
    }
    case 'exposure': {
      const report = await lossAttributionReport(q);
      head('OUTCOMES BY CONCURRENT PAPER EXPOSURE AT CREATION');
      console.log(report.exposure.note);
      printGroups(report.exposure.sameDirection);
      console.log('');
      printGroups(report.exposure.correlated);
      break;
    }
    case 'opening-hour':
      printOpeningHour(await openingHourReport(q));
      break;
    case 'cooldown-effectiveness':
      printCooldownEffectiveness(await cooldownEffectivenessReport(q));
      break;
    default:
      console.log(
        'usage: npm run loss-attribution -- <report|exits|dead|split|gates|json|shadow-comparison|invalidation|exposure|opening-hour|cooldown-effectiveness> ' +
          '[--since YYYY-MM-DD] [--until YYYY-MM-DD] [--refusals|--all]'
      );
      process.exitCode = 1;
  }

  await sql.end({ timeout: 5 });
}

main().catch((err: any) => {
  console.error(`loss-attribution CLI failed: ${err.message}`);
  process.exitCode = 1;
  void sql.end({ timeout: 5 });
});
