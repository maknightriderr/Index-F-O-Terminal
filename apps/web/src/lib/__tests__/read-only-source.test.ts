import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Page loads must only read recorded data. The legacy GET /api/market/bias/:symbol runs the decision engine
// (it can mint trades and write decision rows), so no web source may call it; the UI reads /bias-snapshot instead.

const SRC = join(__dirname, '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

describe('web source is read-only on page load', () => {
  // comments may name the old route to explain why it is not used
  const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const all = files(SRC).map((p) => [p, code(readFileSync(p, 'utf8'))] as const);

  it('never calls the legacy decision-engine bias route', () => {
    const offenders = all.filter(([p, s]) => !p.endsWith('api.ts') && (/\/api\/market\/bias\//.test(s) || /\bgetMarketBias\s*\(/.test(s))).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it('api.ts only keeps getMarketBias as a deprecated export', () => {
    const api = all.find(([p]) => p.endsWith('lib\\api.ts') || p.endsWith('lib/api.ts'))![1];
    expect(readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8')).toMatch(/@deprecated/);
    expect(api).toBeTruthy();
  });

  it('the only POST to the market scanner is the explicit run, never a mount-time call', () => {
    const calls = all.filter(([, s]) => /runMarketScan\s*\(/.test(s)).map(([p]) => p.replace(/\\/g, '/').split('/src/')[1]);
    expect(calls.sort()).toEqual(['lib/api.ts', 'lib/use-market-scanner.ts']);
    const hook = all.find(([p]) => p.endsWith('use-market-scanner.ts'))![1];
    // runScan is returned for a button; no effect invokes it
    const effects = hook.match(/useEffect\([\s\S]*?\}, \[/g) ?? [];
    for (const e of effects) expect(e).not.toMatch(/runScan|runMarketScan/);
  });
});
