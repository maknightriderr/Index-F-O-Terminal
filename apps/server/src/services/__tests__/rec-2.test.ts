// ============================================================
// REC-2 (audit 2026-10-18): historical record noise. The abandoned sweep's one-off "reopen" repair is gone (0 rows
// for weeks); untracked expiries are counted apart in the web headline (apps/web paper-trade-view countTrades).
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the abandoned sweep never revives a trade', () => {
  it('no UPDATE strips an outcome any more', () => {
    const src = readFileSync(path.join(SRC, 'services/backtesting.ts'), 'utf8');
    expect(src).not.toMatch(/inputs - 'outcome'/);
    expect(src).not.toMatch(/reopened/);
    // The sweep itself (mark EXPIRED after 2 / 31 days) is unchanged.
    expect(src).toMatch(/outcome: 'EXPIRED', exitPrice: null, exitTime: null, abandoned: true/);
  });
});
