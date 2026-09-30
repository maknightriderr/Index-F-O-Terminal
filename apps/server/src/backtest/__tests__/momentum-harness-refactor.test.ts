// ============================================================
// The backtest harness refactor must not change momentum-break
// ============================================================
// 1. Data-free: a seeded synthetic year replayed through replaySymbol for all
//    four momentum variants. The snapshot was written by the harness BEFORE
//    it was generalised into a strategy interface; any drift fails here.
// 2. With the saved 15m history present (apps/server/backtest-data/, not in
//    git): the rendered momentum report is byte-identical to the committed
//    reference copy of the report the momentum PR shipped.
// ============================================================

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOMENTUM_BREAK_VARIANTS } from '@fno/analytics';
import { replaySymbol, statsOf } from '../momentum-backtest.js';
import { syntheticSymbol } from './fixtures/synthetic.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('momentum harness — unchanged by the refactor', () => {
  it('synthetic replay, every variant, matches the pre-refactor snapshot', () => {
    const loaded = syntheticSymbol();
    const window = { from: '2026-01-01', to: '2026-12-31' };
    const out = MOMENTUM_BREAK_VARIANTS.map((v) => {
      const trades = replaySymbol(loaded, v, window);
      return { variant: v.id, stats: statsOf(trades), trades };
    });
    expect(out.reduce((n, r) => n + r.trades.length, 0)).toBeGreaterThan(0);
    expect(out).toMatchSnapshot();
    // ~2.4s alone, >5s (vitest's default) when the full suite runs in parallel.
  }, 30_000);

  const dataDir = join(HERE, '../../../backtest-data');
  const reference = join(HERE, '__fixtures__/momentum-report.reference.md');
  const haveData = existsSync(join(dataDir, 'NIFTY_INDEX.json')) && existsSync(join(dataDir, 'CRUDEOIL.json'));
  it.skipIf(!haveData)('the momentum report rendered from the saved history is byte-identical to the shipped one', async () => {
    const { renderMomentumReport } = await import('../momentum-report.js');
    const { lines } = renderMomentumReport(dataDir, { inSampleOnly: false, quiet: true });
    expect(lines.join('\n')).toBe(readFileSync(reference, 'utf8'));
  }, 600_000);
});
