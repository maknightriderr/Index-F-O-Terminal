import { flowCoverage, FLOW_MIN_SAMPLED_COVERAGE } from '../order-flow/index.js';
// ============================================================
// ORDER-FLOW SHADOW EVIDENCE (fresh-start 1.8, 5 Nov 2026)
// ============================================================
// Owner request: use the Dhan order-flow feed to judge entries, but in SHADOW first — every candidate is still
// traded exactly as before; this only TAGS it with what the flow said at the decision bar, so outcomes can be compared
// by tag before any gate is considered. Nothing here can refuse or alter a candidate.
//
// Sides are INFERRED by the feed (quote rule, then tick rule), never exact. A bar whose classified share is too small,
// or a missing bar, is UNAVAILABLE rather than a guess.
// ============================================================

import type { FreshDirection } from './strategies.js';

/** `unreconciled` (v2): volume between packets no observed trade explains: the observed flow is a sample of the bar while
 *  it covers at least FLOW_MIN_SAMPLED_COVERAGE of the volume (owner, 9 Nov). */
export interface FreshFlowBar { time: number; buy: number; sell: number; unclassified: number; trades: number; unreconciled?: number }
export interface FreshOrderFlowInput { source: string; instrument: string | null; proxy: boolean; bars: readonly FreshFlowBar[] }
export type FreshFlowAlignment = 'ALIGNED' | 'NEUTRAL' | 'OPPOSED' | 'UNAVAILABLE';
export interface FreshOrderFlowEvidence {
    alignment: FreshFlowAlignment;
    /** (buy − sell) / (buy + sell) of the decision bar, signed so that + means in the trade's direction. */
    barDelta: number | null;
    /** The same over the setup, from the origin bar through the decision bar. */
    setupDelta: number | null;
    classifiedShare: number | null;
    trades: number;
    source: string | null;
    instrument: string | null;
    /** True when the flow is the parent product's contract (e.g. CRUDEOIL's for CRUDEOILM). */
    proxy: boolean;
    reason: string | null;
    rule: string;
}

/** |barDelta| at or above this decides ALIGNED / OPPOSED; below is NEUTRAL. */
export const FRESH_FLOW_ALIGN = 0.15;
/** A bar needs at least this share of its volume classified, and at least FRESH_FLOW_MIN_TRADES updates. */
export const FRESH_FLOW_MIN_CLASSIFIED = 0.5;
export const FRESH_FLOW_MIN_TRADES = 5;
const RULE = `SHADOW_ONLY: decision-bar delta >= ${FRESH_FLOW_ALIGN} in direction = ALIGNED, <= -${FRESH_FLOW_ALIGN} = OPPOSED; classified >= ${FRESH_FLOW_MIN_CLASSIFIED}, trades >= ${FRESH_FLOW_MIN_TRADES}`;

const signedDelta = (buy: number, sell: number, d: number) => (buy + sell > 0 ? (d * (buy - sell)) / (buy + sell) : null);

/** Pure. `decisionBar` is the five-minute bar the candidate was decided on; `origin` the setup's first bar. */
export function freshOrderFlowEvidence(flow: FreshOrderFlowInput | undefined, direction: FreshDirection, decisionBar: number, origin: number): FreshOrderFlowEvidence {
    const base = { source: flow?.source ?? null, instrument: flow?.instrument ?? null, proxy: flow?.proxy ?? false, rule: RULE };
    const none = (reason: string): FreshOrderFlowEvidence => ({ ...base, alignment: 'UNAVAILABLE', barDelta: null, setupDelta: null, classifiedShare: null, trades: 0, reason });
    if (!flow) return none('NO_FLOW_FOR_INSTRUMENT');
    const d = direction === 'BULLISH' ? 1 : -1, bar = flow.bars.find(b => b.time === decisionBar);
    if (!bar) return none('NO_FLOW_BAR');
    // Sampled order flow (owner, 9 Nov): the classified share is of the OBSERVED volume; unreconciled volume only has to
    // leave enough coverage (FLOW_MIN_SAMPLED_COVERAGE) for the observed trades to stand as a sample.
    const observed = bar.buy + bar.sell + bar.unclassified, classifiedShare = observed > 0 ? (bar.buy + bar.sell) / observed : null;
    const coverage = flowCoverage(observed, bar.unreconciled ?? 0);
    const setup = flow.bars.filter(b => b.time >= Math.min(origin, decisionBar) && b.time <= decisionBar);
    const sb = setup.reduce((n, b) => n + b.buy, 0), ss = setup.reduce((n, b) => n + b.sell, 0);
    const out = { ...base, barDelta: signedDelta(bar.buy, bar.sell, d), setupDelta: signedDelta(sb, ss, d), classifiedShare, trades: bar.trades, reason: null as string | null };
    if (classifiedShare == null || classifiedShare < FRESH_FLOW_MIN_CLASSIFIED) return { ...out, alignment: 'UNAVAILABLE', reason: 'TOO_LITTLE_CLASSIFIED' };
    if (coverage == null || coverage < FLOW_MIN_SAMPLED_COVERAGE) return { ...out, alignment: 'UNAVAILABLE', reason: 'LOW_COVERAGE' };
    if (bar.trades < FRESH_FLOW_MIN_TRADES) return { ...out, alignment: 'UNAVAILABLE', reason: 'TOO_FEW_TRADES' };
    const x = out.barDelta!;
    return { ...out, alignment: x >= FRESH_FLOW_ALIGN ? 'ALIGNED' : x <= -FRESH_FLOW_ALIGN ? 'OPPOSED' : 'NEUTRAL' };
}
