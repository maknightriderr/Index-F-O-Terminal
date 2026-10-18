// ============================================================
// SEC-2 (audit 2026-10-18): a GET never runs the decision engine.
// GET /api/market/bias/:symbol ran buildMarketBias, which can mint a paper trade and writes decision records, so any
// page load or crawler could change the paper book. It was removed; this keeps any GET handler from doing it again.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The engine's entry points that write: a decision (and possibly a paper trade), a scan, a lifecycle advance.
const WRITERS = /\b(buildMarketBias|refreshMarketScan|runMarketScan|checkLockedSetupPriceLevels|recordTradeSetup|advanceLifecycle|computeMarketBias)\s*\(/;

/** Each route registration and the source up to the next one: `router.get('/x', ...)` → { method, path, body }. */
function routes(src: string): Array<{ method: string; path: string; body: string }> {
  const re = /\brouter\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  const hits = [...src.matchAll(re)];
  return hits.map((m, i) => ({ method: m[1].toUpperCase(), path: m[2], body: src.slice(m.index ?? 0, hits[i + 1]?.index ?? src.length) }));
}

describe('GET routes are read-only', () => {
  const files = readdirSync(API).filter((f) => f.endsWith('.ts'));
  const all = files.flatMap((f) => routes(readFileSync(path.join(API, f), 'utf8')).map((r) => ({ ...r, file: f })));

  it('finds the route files (the scan itself works)', () => {
    expect(files.length).toBeGreaterThan(15);
    expect(all.filter((r) => r.method === 'GET').length).toBeGreaterThan(30);
    // The explicit scan is a POST and does call a writer: the pattern would catch it if it were a GET.
    expect(all.find((r) => r.file === 'market-scanner.ts' && r.method === 'POST')?.body).toMatch(WRITERS);
  });

  it('no GET handler calls an engine entry point that writes', () => {
    const offenders = all.filter((r) => r.method === 'GET' && WRITERS.test(r.body)).map((r) => `${r.file} GET ${r.path}`);
    expect(offenders).toEqual([]);
  });

  it('the bias route that minted trades is gone; the read-only snapshot stays', () => {
    const market = all.filter((r) => r.file === 'market.ts').map((r) => `${r.method} ${r.path}`);
    expect(market).not.toContain('GET /bias/:symbol');
    expect(market).toContain('GET /bias-snapshot/:symbol');
    expect(readFileSync(path.join(API, 'market.ts'), 'utf8')).not.toMatch(/buildMarketBias/);
  });
});
