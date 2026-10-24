import { describe, it, expect } from 'vitest';
import {
  alignFootprintsToReference, buildFootprint, detectOrderBlocks, orderBlockSignalAt, evaluateOf1, volumeShareBeyond,
  type Of1Bar, type Of1Location,
} from '@fno/analytics';

const T = Date.parse('2026-10-06T09:15:00+05:30'), M = 900_000;
const bar = (k: number, open: number, high: number, low: number, close: number): Of1Bar => ({ time: T + k * M, open, high, low, close });
const base = () => Array.from({ length: 20 }, (_, k) => k % 2 ? bar(k, 100, 105, 95, 101) : bar(k, 101, 105, 95, 100));
const scenario = () => [...base(), bar(20, 100, 101, 94, 95), bar(21, 96, 113, 95, 112), bar(22, 112, 115, 106, 114), bar(23, 106, 107, 100, 104)];
const mirror = (b: Of1Bar): Of1Bar => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close });
const shiftBar = (b: Of1Bar, d: number): Of1Bar => ({ ...b, open: b.open + d, high: b.high + d, low: b.low + d, close: b.close + d });
const block = (bs: Of1Bar[]) => detectOrderBlocks(bs).find(b => b.blockIndex === 20)!;

describe.each(['BULLISH', 'BEARISH'] as const)('OB held chronology: %s', dir => {
  const orient = (bs: Of1Bar[]) => dir === 'BULLISH' ? bs : bs.map(mirror);
  it('failure then later recovery stays failed (independent review reproducer)', () => {
    const failed = [...scenario(), bar(24, 103, 104, 92, 93)];
    expect(block(orient(failed)).reaction?.held).toBe(false);
    const recovered = orient([...failed, bar(25, 93, 118, 92, 117)]);
    expect(block(recovered)).toMatchObject({ state: 'MITIGATED', mitigatedIndex: 24, reaction: { held: false } });
    // Full-window excursion remains descriptive, not a held/tradable outcome.
    expect(block(recovered).reaction!.mfeAtr).toBeGreaterThan(1);
  });
  it('a one-ATR reaction before a later failure stays held', () => {
    expect(block(orient([...scenario(), bar(24, 104, 118, 103, 117), bar(25, 117, 118, 92, 93)])))
      .toMatchObject({ state: 'MITIGATED', reaction: { held: true } });
  });
  it('a reaction on the mitigation candle precedes its failure CLOSE', () => {
    expect(block(orient([...scenario(), bar(24, 104, 118, 92, 93)])).reaction?.held).toBe(true);
  });
  it('failure on the first-touch close cannot later become held', () => {
    const bs = orient([...scenario().slice(0, 23), bar(23, 106, 107, 92, 93), bar(24, 93, 118, 92, 117)]);
    expect(block(bs).reaction?.held).toBe(false);
    expect(orderBlockSignalAt(bs, 23)).toBeNull();
  });
  it('undecided is null; eight bars without a reaction is false', () => {
    expect(block(orient(scenario())).reaction?.held).toBeNull();
    const bs = [...scenario(), ...Array.from({ length: 8 }, (_, k) => bar(24 + k, 104, 105, 103, 104))];
    expect(block(orient(bs)).reaction?.held).toBe(false);
  });
});

const contract = { instrument: 'TEST_OCT_FUT', expiry: '2026-10-27' };
function fixture(offset: number, bearish = false) {
  let bars = [...base(), bar(20, 100, 105, 99, 104)];
  if (bearish) bars = bars.map(mirror);
  const t = bars[20].time;
  const p1 = (bearish ? 101 : 99) + offset, p2 = (bearish ? 96 : 104) + offset;
  const fp = buildFootprint([
    { time: t + 1, price: p1, qty: 60, side: bearish ? 'SELL' : 'BUY' },
    { time: t + 2, price: p2, qty: 40, side: bearish ? 'BUY' : 'SELL' },
  ], t, M, 1, 'INFERRED');
  fp.sourceInstrument = contract.instrument;
  const locations: Of1Location[] = [
    { kind: bearish ? 'PDH' : 'PDL', price: 100, role: bearish ? 'RESISTANCE' : 'SUPPORT' },
    { kind: bearish ? 'PDL' : 'PDH', price: bearish ? 80 : 120, role: bearish ? 'SUPPORT' : 'RESISTANCE' },
  ];
  return { bars, fp, raw: new Map([[t, fp]]), futures: bars.map(b => shiftBar(b, offset)), t, locations };
}

describe.each([20, -20])('OF1 basis %s', offset => {
  for (const bearish of [false, true]) {
    it('preserves manual 40% acceptance and delta: ' + (bearish ? 'bearish' : 'bullish'), () => {
      const f = fixture(offset, bearish);
      const before = JSON.stringify([...f.raw]);
      const aligned = alignFootprintsToReference(f.bars, f.raw, f.futures, contract, 'SPOT', f.t + M);
      const fp = aligned.get(f.t)!;
      expect(fp.priceAlignment).toMatchObject({ status: 'ALIGNED', basis: offset, reference: 'SPOT', method: 'BAR_CLOSE_BASIS_ESTIMATE' });
      expect(volumeShareBeyond(fp, 100, bearish ? 'BELOW' : 'ABOVE')).toBe(0.4);
      expect(fp.deltaPct).toBe(bearish ? -0.2 : 0.2);
      expect(evaluateOf1(f.bars, 20, aligned, f.locations, true)).toEqual([]);
      expect(JSON.stringify([...f.raw])).toBe(before);
    });
  }
});

describe('OF1 alignment boundaries', () => {
  const f = fixture(20);
  const run = (future = f.futures, c: typeof contract | null = contract, at = f.t + M, raw = f.raw) =>
    alignFootprintsToReference(f.bars, raw, future, c, 'SPOT', at).get(f.t)!;
  it('raw prices reproduce the old extra confirmation; production refuses them', () => {
    expect(evaluateOf1(f.bars, 20, f.raw, f.locations)[0].evidence).toEqual(['DELTA', 'ACCEPTANCE']);
    expect(evaluateOf1(f.bars, 20, f.raw, f.locations, true)).toEqual([]);
  });
  it('missing, stale and duplicate futures candles are unavailable', () => {
    for (const fs of [[], f.futures.slice(0, -1), [...f.futures, f.futures[20]]])
      expect(run(fs).priceAlignment).toMatchObject({ status: 'UNAVAILABLE', reason: 'MATCHING_FUTURES_BAR_UNAVAILABLE' });
  });
  it('missing contract and rollover cannot borrow another contract basis', () => {
    expect(run(f.futures, null).priceAlignment?.status).toBe('UNAVAILABLE');
    expect(run(f.futures, { ...contract, instrument: 'TEST_NOV_FUT' }).priceAlignment).toMatchObject({ reason: 'CONTRACT_MISMATCH' });
    expect(run(f.futures, contract, f.t + M, new Map([[f.t, { ...f.fp, sourceInstrument: undefined }]])).priceAlignment).toMatchObject({ reason: 'CONTRACT_MISMATCH' });
  });
  it.each([NaN, Infinity, 0, -1])('rejects invalid futures close %s', close => {
    expect(run(f.futures.map((b, i) => i === 20 ? { ...b, close } : b)).priceAlignment?.status).toBe('UNAVAILABLE');
  });
  it('unclosed bars, invalid footprint prices and double alignment are refused', () => {
    expect(run(f.futures, contract, f.t + M - 1).priceAlignment?.status).toBe('UNAVAILABLE');
    expect(run(f.futures, contract, f.t + M, new Map([[f.t, { ...f.fp, levels: [{ ...f.fp.levels[0], price: NaN }] }]])).priceAlignment?.status).toBe('UNAVAILABLE');
    expect(run(f.futures, contract, f.t + M, new Map([[f.t, run()]])).priceAlignment).toMatchObject({ reason: 'ALREADY_ALIGNED' });
  });
  it('appending future candles does not change the decision', () => {
    expect(run([...f.futures, shiftBar(bar(21, 1000, 1001, 999, 1000), 20)])).toEqual(run());
  });
  it('MCX same-contract flow stays in futures price space', () => {
    const aligned = alignFootprintsToReference(f.futures, f.raw, [], contract, 'FUTURES', f.t + M).get(f.t)!;
    expect(aligned.levels).toEqual(f.fp.levels);
    expect(aligned.priceAlignment).toMatchObject({ reference: 'FUTURES', method: 'SAME_CONTRACT', basis: 0 });
  });
  it('a genuine two-evidence setup survives alignment', () => {
    const strong = buildFootprint([99, 100, 101, 102, 103].map((p, k) => ({ time: f.t + k, price: p + 20, qty: 100, side: 'BUY' as const })), f.t, M, 1, 'INFERRED');
    strong.sourceInstrument = contract.instrument;
    const aligned = alignFootprintsToReference(f.bars, new Map([[f.t, strong]]), f.futures, contract, 'SPOT', f.t + M);
    expect(evaluateOf1(f.bars, 20, aligned, f.locations, true)[0].evidence).toEqual(expect.arrayContaining(['DELTA', 'IMBALANCE']));
  });
});
