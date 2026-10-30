import { describe, expect, it } from 'vitest';
import { buildChartZones, selectChartZones, type ZoneCandle } from '../chart-zones';
const t = 1792700000;
const bars = (values: number[][]): ZoneCandle[] => values.map(([open, high, low, close], i) => ({ time: t + i * 900, open, high, low, close }));
const warm = Array.from({ length: 16 }, () => [100, 101, 99, 100]);
const sample = bars([...warm, [100, 101, 98, 99], [99, 106, 99, 105], [105, 107, 104, 106]]);
const mirror = (b: ZoneCandle[]): ZoneCandle[] => b.map(c => ({ ...c, open: 200-c.open, high: 200-c.low, low: 200-c.high, close: 200-c.close }));
const allClosed = t + 100 * 900;

describe('closed-candle chart zones', () => {
  it.each([false, true])('uses real OB-2.0 bounds for mirrored directions (bear=%s)', bear => {
    const result = buildChartZones(bear ? mirror(sample) : sample, 900, allClosed);
    const zone = result.zones.find(z => z.kind === 'OB')!;
    expect(zone.direction).toBe(bear ? 'BEARISH' : 'BULLISH');
    expect([zone.bottom, zone.top]).toEqual(bear ? [99, 102] : [98, 101]);
    expect(zone.start).toBe(sample[17].time); // displacement confirms the OB, not the opposing candle
    expect(zone.active).toBe(true);
  });
  it('does not confirm a block or FVG using a still-forming displacement candle', () => {
    const before = buildChartZones(sample.slice(0,18), 900, sample[17].time + 899);
    expect(before.zones).toEqual([]);
    expect(buildChartZones(sample.slice(0,18), 900, sample[17].time + 900).zones.some(z => z.kind==='OB')).toBe(true);
  });
  it.each([false, true])('FVG starts at its third candle and exact later boundary touch ends it (bear=%s)', bear => {
    const b = bars([[100,102,99,101],[102,107,101,106],[106,108,104,107],[107,110,104,109]]);
    const zone = buildChartZones(bear ? mirror(b) : b,900,allClosed).zones.find(z=>z.kind==='FVG')!;
    expect([zone.bottom,zone.top]).toEqual(bear ? [96,98] : [102,104]);
    expect(zone.start).toBe(b[2].time);
    expect(zone.end).toBe(b[3].time);
    expect(zone.active).toBe(false);
    expect(zone.state).toBe('TOUCHED');
  });
  it('does not project a mitigated block forward as active', () => {
    const input=[...sample,{time:t+19*900,open:100,high:101,low:96,close:97}];
    const zone=buildChartZones(input,900,allClosed).zones.find(z=>z.kind==='OB' && z.direction==='BULLISH')!;
    expect(zone.state).toBe('MITIGATED');expect(zone.end).toBe(input[19].time);
    expect(selectChartZones([zone],true,true,false)).toEqual([]);
    expect(selectChartZones([zone],true,true,true)).toEqual([zone]);
  });
  it('withholds zones on invalid, non-positive, inverted or unordered history', () => {
    for(const bad of [{close:NaN},{high:97},{low:110},{open:0},{time:sample[0].time}]) {
      const input=sample.map((b,i)=>i===17?{...b,...bad}:b);
      expect(buildChartZones(input,900,allClosed).zones).toEqual([]);
      expect(buildChartZones(input,900,allClosed).reason).toContain('Invalid');
    }
  });
  it('fewer bars / invalid intervals have explicit empty states, and toggles remove a family', () => {
    expect(buildChartZones([],900,allClosed).reason).toBeTruthy();
    expect(buildChartZones(sample,NaN,allClosed).zones).toEqual([]);
    const result=buildChartZones(sample,900,allClosed);
    expect(selectChartZones(result.zones,false,false,true)).toEqual([]);
    expect(selectChartZones(result.zones,false,true,true).every(z=>z.kind==='FVG')).toBe(true);
  });
});

it('does not manufacture an intraday gap zone across missing or overnight candles', () => {
  const b = bars([[100,102,99,101],[102,107,101,106],[106,108,104,107]]);
  b[2].time += 900;
  expect(buildChartZones(b,900,allClosed).zones.filter(z=>z.kind==='FVG')).toEqual([]);
});
