import { describe, expect, it } from 'vitest';
import { freshOrderFlowEvidence, type FreshFlowBar } from '../order-flow-evidence.js';

const t0 = 1800000000000, bar = (i: number, buy: number, sell: number, unclassified = 0, trades = 20): FreshFlowBar => ({ time: t0 + i * 300000, buy, sell, unclassified, trades });
const flow = (bars: FreshFlowBar[]) => ({ source: 'DHAN', instrument: 'NIFTY-Nov2026-FUT', proxy: false, bars });

describe('order-flow shadow evidence (5 Nov)', () => {
    it('signs the decision-bar delta by direction and tags ALIGNED / NEUTRAL / OPPOSED', () => {
        const f = flow([bar(0, 100, 100), bar(1, 300, 100)]);
        expect(freshOrderFlowEvidence(f, 'BULLISH', t0 + 300000, t0)).toMatchObject({ alignment: 'ALIGNED', barDelta: .5 });
        expect(freshOrderFlowEvidence(f, 'BEARISH', t0 + 300000, t0)).toMatchObject({ alignment: 'OPPOSED', barDelta: -.5 });
        expect(freshOrderFlowEvidence(flow([bar(1, 110, 100)]), 'BULLISH', t0 + 300000, t0)).toMatchObject({ alignment: 'NEUTRAL' });
        expect(freshOrderFlowEvidence(f, 'BULLISH', t0 + 300000, t0).setupDelta).toBeCloseTo(200 / 600, 6);
    });
    it('is UNAVAILABLE without flow, without the bar, or with too little classified volume or too few updates', () => {
        expect(freshOrderFlowEvidence(undefined, 'BULLISH', t0, t0)).toMatchObject({ alignment: 'UNAVAILABLE', reason: 'NO_FLOW_FOR_INSTRUMENT' });
        expect(freshOrderFlowEvidence(flow([bar(0, 1, 1)]), 'BULLISH', t0 + 300000, t0)).toMatchObject({ alignment: 'UNAVAILABLE', reason: 'NO_FLOW_BAR' });
        expect(freshOrderFlowEvidence(flow([bar(0, 10, 10, 100)]), 'BULLISH', t0, t0)).toMatchObject({ alignment: 'UNAVAILABLE', reason: 'TOO_LITTLE_CLASSIFIED' });
        expect(freshOrderFlowEvidence(flow([bar(0, 100, 10, 0, 2)]), 'BULLISH', t0, t0)).toMatchObject({ alignment: 'UNAVAILABLE', reason: 'TOO_FEW_TRADES' });
    });
});
