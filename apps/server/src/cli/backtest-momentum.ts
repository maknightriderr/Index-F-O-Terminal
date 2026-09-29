// ============================================================
// CLI: momentum-break backtest
// ============================================================
// npm run backtest-momentum --workspace=@fno/server [-- --in-sample-only]
//
// Reads the snapshots in apps/server/backtest-data/ (fetch-history.ts), then:
//   1. splits the session calendar chronologically, first ⅔ in-sample;
//   2. runs the four pre-registered variants on the in-sample period only;
//   3. picks one by in-sample average net R;
//   4. runs THAT variant once on the out-of-sample ⅓ — no other variant is
//      ever run out of sample;
//   5. judges the out-of-sample result against the pre-registered go-live
//      bar and writes momentum-report.json / momentum-report.md.
// No database, no broker, no network. The report body is
// backtest/momentum-report.ts.
// ============================================================

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';
import { renderMomentumReport } from '../backtest/momentum-report.js';

const inSampleOnly = process.argv.includes('--in-sample-only');

function main() {
  const { lines, report, inSampleOnly: partial } = renderMomentumReport(BACKTEST_DATA_DIR, { inSampleOnly });
  if (partial) {
    writeFileSync(join(BACKTEST_DATA_DIR, 'momentum-report.insample.json'), JSON.stringify(report, null, 2));
    return;
  }
  writeFileSync(join(BACKTEST_DATA_DIR, 'momentum-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(BACKTEST_DATA_DIR, 'momentum-report.md'), lines.join('\n'));
  console.log(`\nWrote ${join(BACKTEST_DATA_DIR, 'momentum-report.md')}`);
}

try {
  main();
} catch (err: any) {
  console.error('Momentum backtest failed:', err);
  process.exit(1);
}
