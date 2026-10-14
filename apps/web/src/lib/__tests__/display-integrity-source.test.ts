import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The 11 Oct production audit found "++1.30%" still live in the Dashboard watchlist: @fno/shared's formatPercent already
// signs positive numbers, so a hand-written '+' in front of it doubles the sign. Pin it for every component.
const SRC = join(__dirname, '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

describe('percent display', () => {
  it('no component puts its own "+" in front of an already-signed percent formatter', () => {
    const doubled = /\?\s*'\+'\s*:\s*''\s*\}\s*\{?\s*(formatPercent|formatSignedPercent|formatArrowPercent)\(/;
    const offenders = files(SRC)
      .filter((p) => doubled.test(readFileSync(p, 'utf8')))
      .map((p) => p.replace(SRC, ''));
    expect(offenders).toEqual([]);
  });
  it('the shared formatter signs positives itself (so the check above is the right one)', async () => {
    const { formatPercent } = await import('@fno/shared');
    expect(formatPercent(1.3)).toBe('+1.30%');
  });
});
