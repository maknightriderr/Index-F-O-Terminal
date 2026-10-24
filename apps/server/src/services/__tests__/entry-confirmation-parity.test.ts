import { expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildFootprint, alignFootprintsToReference } from '@fno/analytics';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
const { orderFlowPaperCandidates } = await import('../order-flow-candidates.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/regression-bars.json', import.meta.url), 'utf8')).series;
const goldenPath = new URL('./fixtures/entry-confirmation-baseline.json', import.meta.url);
const baseSha = 'b1282311809c5f1234e0fa35820bb77031b559a3';

it('production candidate, geometry, parent, stage, risk and cost outputs match the deployed baseline', async () => {
  // Optional regeneration is ONLY from the old file extracted from baseSha (documented in the experiment report).
  const generate = process.env.ENTRY_GENERATE_BASELINE === '1';
  const baselineFile = '../order-flow-candidates.baseline.ts';
  const evaluate: typeof orderFlowPaperCandidates = generate ? (await import(baselineFile)).orderFlowPaperCandidates : orderFlowPaperCandidates;
  const cases: Array<{ symbol: string; prefix: number; flow: string; candidates: number; hash: string }> = [];
  for (const symbol of ['NIFTY', 'BANKNIFTY', 'CRUDEOIL']) {
    const bars = (fixture[symbol] as number[][]).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
    for (let i = 30; i < bars.length; i += 3) {
      const cut = bars.slice(0, i + 1), last = cut[i];
      // Frozen real OHLC; synthetic flow in both directions is a regression input, NOT historical OF performance.
      for (const side of ['NONE', 'BUY', 'SELL'] as const) {
        const prices = [last.low, (last.low + last.high) / 2, last.high];
        const raw = side === 'NONE' ? new Map() : new Map([[last.time, { ...buildFootprint(prices.map((price, k) => ({ time: last.time + k + 1, price, qty: 100, side })), last.time, 900_000, .05, 'INFERRED'), sourceInstrument: 'TEST_FUT' }]]);
        const footprints = alignFootprintsToReference(cut, raw, cut, { instrument: 'TEST_FUT', expiry: '2026-10-27' }, symbol === 'CRUDEOIL' ? 'FUTURES' : 'SPOT', last.time + 900_000);
        const output = evaluate({ underlying: symbol, exchange: symbol === 'CRUDEOIL' ? 'MCX' : 'NSE', bars: cut, chain: null, footprints, ob1: true, of1: true });
        // The ONLY additive field is research evidence; every production-consumed field must match byte-for-byte.
        // entryEvidence (PR #59) and orderBlock (2026-10-25) are observation / display fields no decision reads.
        const canonical = output.map(({ entryEvidence: _observation, orderBlock: _display, ...production }) => production);
        cases.push({ symbol, prefix: i + 1, flow: side, candidates: output.length, hash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') });
      }
    }
  }
  if (generate) writeFileSync(goldenPath, JSON.stringify({ baseSha, cases }, null, 2) + '\n');
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  expect(golden.baseSha).toBe(baseSha);
  expect(cases).toEqual(golden.cases);
  expect(cases.length).toBeGreaterThan(900);
  expect(cases.some((c) => c.candidates > 0)).toBe(true);
}, 120_000);
