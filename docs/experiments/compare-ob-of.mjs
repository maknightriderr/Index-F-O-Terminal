// Run from the project root:
// node --import tsx docs/experiments/compare-ob-of.mjs /path/to/base-worktree
// The base worktree must be commit 804c0c7 (PR #57), with dependencies available.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const beforeRoot = resolve(process.argv[2]);
const afterRoot = process.cwd();
const baseSha = execFileSync('git', ['-C', beforeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(baseSha, '804c0c7a11e683db15f5360a4933eb8b04e406f0');
const moduleAt = (root, path) => import(pathToFileURL(resolve(root, path)).href);
const obPath = 'packages/analytics/src/market-structure/index.ts';
const ofPath = 'packages/analytics/src/order-flow/of1.ts';
const beforeOb = await moduleAt(beforeRoot, obPath), afterOb = await moduleAt(afterRoot, obPath);
const beforeOf = await moduleAt(beforeRoot, ofPath), afterOf = await moduleAt(afterRoot, ofPath);
const { buildFootprint, volumeShareBeyond } = await moduleAt(afterRoot, 'packages/analytics/src/order-flow/index.ts');
const { alignFootprintsToReference } = await moduleAt(afterRoot, 'packages/analytics/src/order-flow/alignment.ts');
const T = Date.parse('2026-10-06T09:15:00+05:30'), M = 900000;
const b = (k, open, high, low, close) => ({ time: T + k * M, open, high, low, close });
const base = Array.from({ length: 20 }, (_, k) => k % 2 ? b(k, 100, 105, 95, 101) : b(k, 101, 105, 95, 100));
const mirror = x => ({ ...x, open: 200 - x.open, high: 200 - x.low, low: 200 - x.high, close: 200 - x.close });
const failure = [...base, b(20, 100, 101, 94, 95), b(21, 96, 113, 95, 112), b(22, 112, 115, 106, 114), b(23, 106, 107, 100, 104), b(24, 103, 104, 92, 93), b(25, 93, 118, 92, 117)];
const obCases = [];
for (const bearish of [false, true]) {
  const bars = bearish ? failure.map(mirror) : failure;
  const before = beforeOb.detectOrderBlocks(bars).find(x => x.blockIndex === 20);
  const after = afterOb.detectOrderBlocks(bars).find(x => x.blockIndex === 20);
  assert.equal(before.reaction.held, true);
  assert.equal(after.reaction.held, false);
  obCases.push({ direction: bearish ? 'BEARISH' : 'BULLISH', beforeHeld: before.reaction.held, afterHeld: after.reaction.held, failedBar: after.mitigatedIndex });
}
const contract = { instrument: 'SYNTHETIC_FUT', expiry: '2026-10-27' };
const ofCases = [];
for (const bearish of [false, true]) {
  const offset = bearish ? -20 : 20;
  let bars = [...base, b(20, 100, 105, 99, 104)];
  if (bearish) bars = bars.map(mirror);
  const time = bars[20].time;
  const fp = buildFootprint([
    { time: time + 1, price: (bearish ? 101 : 99) + offset, qty: 60, side: bearish ? 'SELL' : 'BUY' },
    { time: time + 2, price: (bearish ? 96 : 104) + offset, qty: 40, side: bearish ? 'BUY' : 'SELL' },
  ], time, M, 1, 'INFERRED');
  fp.sourceInstrument = contract.instrument;
  const locations = [{ kind: bearish ? 'PDH' : 'PDL', price: 100, role: bearish ? 'RESISTANCE' : 'SUPPORT' }];
  const raw = new Map([[time, fp]]);
  const futureBars = bars.map(x => ({ ...x, open: x.open + offset, high: x.high + offset, low: x.low + offset, close: x.close + offset }));
  const aligned = alignFootprintsToReference(bars, raw, futureBars, contract, 'SPOT', time + M);
  const before = beforeOf.evaluateOf1(bars, 20, raw, locations);
  const after = afterOf.evaluateOf1(bars, 20, aligned, locations, true);
  assert.equal(before.length, 1);
  assert.equal(after.length, 0);
  const acceptance = volumeShareBeyond(aligned.get(time), 100, bearish ? 'BELOW' : 'ABOVE');
  assert.equal(acceptance, 40 / 100); // Independent expected volume share.
  ofCases.push({ direction: bearish ? 'BEARISH' : 'BULLISH', basis: offset, beforeEvidence: before[0].evidence, afterCandidates: after.length, correctedAcceptance: acceptance });
}
const fixture = JSON.parse(readFileSync('apps/server/src/services/__tests__/fixtures/regression-bars.json', 'utf8')).series;
const frozen = [];
for (const symbol of ['NIFTY', 'BANKNIFTY', 'CRUDEOIL']) {
  const bars = fixture[symbol].map(([time, open, high, low, close]) => ({ time, open, high, low, close }));
  let checks = 0, signals = 0;
  for (let i = 30; i < bars.length; i += 3) {
    const oldSignal = beforeOb.orderBlockSignalAt(bars, i);
    const newSignal = afterOb.orderBlockSignalAt(bars, i);
    assert.deepEqual(newSignal, oldSignal);
    checks++;
    if (newSignal) signals++;
  }
  frozen.push({ symbol, checkedPrefixes: checks, signals, changedSignals: 0 });
}
console.log(JSON.stringify({ baseSha, sourceSha256: Object.fromEntries([obPath, ofPath, 'packages/analytics/src/order-flow/alignment.ts'].map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])), obCases, ofCases, frozen,
  limitations: 'Synthetic OF examples and frozen real OHLC comparisons; not a historical OF trading replay, production validation or profitability study.' }, null, 2));
