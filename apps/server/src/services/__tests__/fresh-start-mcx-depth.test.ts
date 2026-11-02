import { describe, expect, it } from 'vitest';
import { FreshSharedFeed, FRESH_MCX_DEPTH_MIN_SAMPLES } from '../fresh-start/feed.js';

function setup() {
  let now = Date.parse('2026-11-02T08:00:00Z'), emit: (ticks: any[]) => void = () => {};
  const manager = { onTick: (f: any) => { emit = f; return () => {}; }, onRecovering: () => () => {}, subscribe: async () => {}, unsubscribe: () => {} };
  const feed = new FreshSharedFeed(manager as any, () => now);
  feed.start();
  const tick = (token: string, bidQty: number, askQty: number) => ({ token, exchange: 'MCX', exchangeSegment: 'MCX_FO', exchangeTimestamp: now, timestamp: now, ltp: 500, bid: 499.9, ask: 500.1, bidQty, askQty });
  return { feed, send: (token: string, b: number, a: number) => { now += 10; emit([tick(token, b, a)]); }, at: () => now };
}

describe('MCX depth unit inference (2 Nov: no MCX book ever qualified)', () => {
  it('reads depth as zero until the unit is known, so nothing qualifies on an unproven reading', async () => {
    const { feed, send } = setup();
    await feed.reserve([{ token: '1', exchange: 'MCX', exchangeSegment: 'MCX_FO' }], 250);
    feed.registerMcxDepth('MCX_FO:1', 'CRUDEOIL', 100);
    send('1', 300, 500);
    expect(feed.mcxDepthMode('CRUDEOIL')).toBe('UNKNOWN');
    expect(feed.quote('MCX_FO:1', 0.1)).toMatchObject({ bidUnits: 0, askUnits: 0 });
  });
  it('one quantity that is not a multiple of the lot proves the broker reports lots, and depth is scaled to units', async () => {
    const { feed, send } = setup();
    await feed.reserve([{ token: '1', exchange: 'MCX', exchangeSegment: 'MCX_FO' }], 250);
    feed.registerMcxDepth('MCX_FO:1', 'CRUDEOIL', 100);
    send('1', 7, 12);
    expect(feed.mcxDepthMode('CRUDEOIL')).toBe('LOTS');
    expect(feed.quote('MCX_FO:1', 0.1)).toMatchObject({ bidUnits: 700, askUnits: 1200, tick: 0.1 });
  });
  it('enough whole-lot multiples read as units, unscaled', async () => {
    const { feed, send } = setup();
    await feed.reserve([{ token: '1', exchange: 'MCX', exchangeSegment: 'MCX_FO' }], 250);
    feed.registerMcxDepth('MCX_FO:1', 'CRUDEOILM', 10);
    for (let i = 0; i < FRESH_MCX_DEPTH_MIN_SAMPLES / 2; i++) send('1', 20 + 10 * (i % 3), 30);
    expect(feed.mcxDepthMode('CRUDEOILM')).toBe('UNITS');
    expect(feed.quote('MCX_FO:1', 0.05)).toMatchObject({ bidUnits: 20 + 10 * ((FRESH_MCX_DEPTH_MIN_SAMPLES / 2 - 1) % 3), askUnits: 30 });
    expect(feed.mcxDepthModes().CRUDEOILM).toMatchObject({ mode: 'UNITS', nonMultiple: 0 });
  });
  it('leaves NSE/BSE books untouched', async () => {
    const { feed, at } = setup();
    let emit: any;
    const manager = { onTick: (f: any) => { emit = f; return () => {}; }, onRecovering: () => () => {}, subscribe: async () => {}, unsubscribe: () => {} };
    const nse = new FreshSharedFeed(manager as any, at);
    nse.start();
    await nse.reserve([{ token: '9', exchange: 'NSE', exchangeSegment: 'NSE_FO' }], 250);
    emit([{ token: '9', exchange: 'NSE', exchangeSegment: 'NSE_FO', exchangeTimestamp: at(), timestamp: at(), ltp: 100, bid: 99.9, ask: 100.1, bidQty: 7, askQty: 13 }]);
    expect(nse.quote('NSE_FO:9', 0.05)).toMatchObject({ bidUnits: 7, askUnits: 13 });
    feed.close();
    nse.close();
  });
});
