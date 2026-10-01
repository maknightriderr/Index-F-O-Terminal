// ============================================================
// EVENT ENGINE — trigger registry and evaluation (RESEARCH only)
// ============================================================
// Each trigger is a pre-registered rule over the event log: which events,
// in which order, within how many bars, and where the stop and target go.
// A trigger is evaluated at a candidate decision bar i using only the events
// confirmed at or before i (eventsUpTo) and bars <= i. Its entry is bar i's
// close; its target is the nearest untaken opposite pool (the live engine's
// own nearestOppositePool, from pools built on bars before i); its stop is
// written in the registry. Nothing after i is read.
//
// Status: every trigger starts RESEARCH. None is wired to any live or paper
// path. A1 and F4 restate SWEEP_CLOSE (and a subset of it), which failed its
// clean out-of-sample test on 30 Sep 2026, so they are RETIRED baselines.
// ============================================================

import type { MomentumBar } from '../momentum-break/index.js';
import { nearestOppositePool } from '../structure-engine/index.js';
import { EVENT_RULES, type SeriesContext } from './context.js';
import { barRange, type SessionEventLog } from './events.js';
import type { CandidateBucket, Dir, EntryTiming, EventLevel, MarketEvent, MovePotential, TriggerCandidate, TriggerDefinition } from './types.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const COMMON = {
  version: '1.0',
  entryRule: "The decision bar's close.",
  targetRule: 'T1 = the nearest untaken opposite pool beyond the highest high / lowest low since the anchor (nearestOppositePool, pools from bars before the decision bar). T1 < 1.5R → LOW_RR; no T1 → NO_TARGET. Neither is a trade.',
  allowedDataAtDecision: 'Bars up to and including the decision bar; ATR and liquidity pools from bars before it; events confirmed at or before its close.',
  noLookAheadDefinition: 'Appending bars after the decision bar changes neither the trigger, the entry, the stop, nor the target (event-engine.test.ts).',
  status: 'RESEARCH' as const,
};

const SWEEP_CLOSE_EVIDENCE = 'Identical to SWEEP_CLOSE, which failed its pre-registered clean test on 30 Sep 2026 (OOS index −0.12R PF 0.85, MCX −0.38R PF 0.64, 0/4 windows positive). Kept as the reference baseline, not as a candidate.';

export const TRIGGER_REGISTRY: readonly TriggerDefinition[] = [
  { ...COMMON, triggerId: 'A1', family: 'LIQUIDITY_REVERSAL', name: 'Sweep + reclaim', exactRule: 'A SWEEP of an untaken pool whose bar (1-bar) or next bar (2-bar) closes back inside: RECLAIM.', decisionBar: 'The RECLAIM bar.', stopRule: 'Sweep extreme ± 0.1 ATR.', status: 'RETIRED', priorEvidence: SWEEP_CLOSE_EVIDENCE },
  { ...COMMON, triggerId: 'A2', family: 'LIQUIDITY_REVERSAL', name: 'Sweep + reclaim + micro BOS', exactRule: 'A SWEEP, then within 1–6 bars a MICRO_BOS in the same direction (close through the last confirmed 3-bar swing), with no close beyond the sweep extreme in between.', decisionBar: 'The MICRO_BOS bar.', stopRule: 'The extreme since the sweep ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'A3', family: 'LIQUIDITY_REVERSAL', name: 'Sweep + reclaim + sweep-candle break', exactRule: "A SWEEP, then within 1–4 bars the first close beyond the sweep candle(s)' opposite extreme (below their low for a bearish sweep), with no close beyond the sweep extreme in between.", decisionBar: 'The bar that closes beyond the sweep candle.', stopRule: 'The extreme since the sweep ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'A4', family: 'LIQUIDITY_REVERSAL', name: 'Sweep + failed retest', exactRule: 'A SWEEP, then 2–8 bars later price returns within 0.25 ATR of the swept level and closes back on the reversal side (RETEST_FAIL of the sweep).', decisionBar: 'The RETEST_FAIL bar.', stopRule: 'The extreme since the sweep (retest included) ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'A5', family: 'LIQUIDITY_REVERSAL', name: 'Failed auction + structure break', exactRule: 'A major-level or opening-range break that fails (FAILED_ACCEPTANCE: a close back inside within 2 bars), then within 0–6 bars a MICRO_BOS in the failure direction.', decisionBar: 'The MICRO_BOS bar.', stopRule: 'The extreme since the break ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'B1', family: 'BREAKOUT_ACCEPTANCE', name: 'Compression + breakout + acceptance', exactRule: 'A COMPRESSION box (6 bars within 1.5 ATR), a COMPRESSION_BREAK (close ≥ 0.1 ATR beyond the box), then the next 2 closes beyond the box edge.', decisionBar: 'The second accepting bar (break + 2).', stopRule: 'The opposite box edge ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'B2', family: 'BREAKOUT_ACCEPTANCE', name: 'Breakout + retest + hold', exactRule: 'An accepted break (MAJOR_LEVEL_BREAK or OPENING_RANGE_BREAK + ACCEPTANCE), then within 8 bars a RETEST_HOLD: price comes within 0.25 ATR of the level and closes beyond it.', decisionBar: 'The RETEST_HOLD bar.', stopRule: "Beyond the retest bar's extreme or the level, whichever is further, ± 0.1 ATR." },
  { ...COMMON, triggerId: 'B3', family: 'BREAKOUT_ACCEPTANCE', name: 'Opening range break + acceptance', exactRule: 'An OPENING_RANGE_BREAK (first close ≥ 0.1 ATR beyond the 30-minute range) followed by ACCEPTANCE (the next 2 closes beyond it).', decisionBar: 'The ACCEPTANCE bar.', stopRule: 'The extreme since the break ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'B4', family: 'BREAKOUT_ACCEPTANCE', name: 'Major level break + acceptance + follow-through', exactRule: "A MAJOR_LEVEL_BREAK (previous day, equal highs/lows, week or month), ACCEPTANCE, then the next bar closes beyond the accepting bar's extreme (FOLLOW_THROUGH).", decisionBar: 'The FOLLOW_THROUGH bar.', stopRule: 'The extreme since the break ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'C1', family: 'TREND_CONTINUATION', name: 'Trend + controlled pullback + micro BOS', exactRule: 'Market state TRENDING in the direction on the bar before; a PULLBACK in that trend within the last 8 bars; then a MICRO_BOS in the trend direction.', decisionBar: 'The MICRO_BOS bar.', stopRule: 'The pullback extreme (from 3 bars before the PULLBACK event to the decision) ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'C2', family: 'TREND_CONTINUATION', name: 'Impulse + retracement + continuation break', exactRule: "A DISPLACEMENT bar (the impulse); within the next 2–8 bars price retraces 38.2–78.6% of the impulse bar's range; then the first close beyond the impulse bar's extreme.", decisionBar: 'The continuation-break bar.', stopRule: 'The retracement extreme ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'C3', family: 'TREND_CONTINUATION', name: 'Trend + level retest + follow-through', exactRule: "Market state TRENDING in the direction; a RETEST_HOLD of a broken level; the next bar closes beyond the retest bar's extreme (FOLLOW_THROUGH).", decisionBar: 'The FOLLOW_THROUGH bar.', stopRule: "The retest bar's extreme ± 0.1 ATR." },
  { ...COMMON, triggerId: 'D1', family: 'VOLATILITY_EXPANSION', name: 'Compression + range expansion + continuation', exactRule: "A bar that is both a COMPRESSION_BREAK and a RANGE_EXPANSION (≥ 1.8 ATR) in one direction, then the next bar closes beyond its extreme (FOLLOW_THROUGH).", decisionBar: 'The FOLLOW_THROUGH bar.', stopRule: "The expansion bar's midpoint ± 0.1 ATR." },
  { ...COMMON, triggerId: 'D2', family: 'VOLATILITY_EXPANSION', name: 'Large expansion + structure break + controlled pullback', exactRule: "A RANGE_EXPANSION bar that is also a MICRO_BOS or MAJOR_LEVEL_BREAK in its direction; within 2–6 bars a pullback of 25–60% of its range; then the first close beyond the previous bar's extreme.", decisionBar: 'The resumption bar.', stopRule: 'The pullback extreme ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'D3', family: 'VOLATILITY_EXPANSION', name: 'Volatility burst + micro pullback + continuation', exactRule: 'A VOLATILITY_BURST (5-bar mean true range ≥ 1.6 ATR); within 2–6 bars at least one bar closes against its direction; then the first close beyond the extreme since the burst.', decisionBar: 'The continuation bar.', stopRule: 'The extreme of the pullback (bars after the burst) ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'E1', family: 'FAILED_AUCTION', name: 'Breach + no acceptance + return + retest failure', exactRule: 'A level break that fails (FAILED_ACCEPTANCE), then within 8 bars price returns within 0.25 ATR of the level and is rejected again (RETEST_FAIL).', decisionBar: 'The RETEST_FAIL bar.', stopRule: 'The extreme since the break ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'F1', family: 'GAP_OPENING', name: 'Gap continuation', exactRule: 'A GAP (open ≥ 1 ATR from the previous close) and, the same session, an OPENING_RANGE_BREAK in the gap direction.', decisionBar: 'The OPENING_RANGE_BREAK bar.', stopRule: 'The extreme of the last 3 bars ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'F2', family: 'GAP_OPENING', name: 'Gap failure', exactRule: "A GAP, then within the session's first 8 bars the first close back through the previous session's close (the gap filled).", decisionBar: 'The gap-fill bar.', stopRule: "The session's extreme in the gap direction ± 0.1 ATR." },
  { ...COMMON, triggerId: 'F3', family: 'GAP_OPENING', name: 'Opening range break', exactRule: 'The first OPENING_RANGE_BREAK of the session in a direction.', decisionBar: 'The OPENING_RANGE_BREAK bar.', stopRule: 'The extreme of the last 3 bars ± 0.1 ATR.' },
  { ...COMMON, triggerId: 'F4', family: 'GAP_OPENING', name: 'Opening range rejection', exactRule: 'A SWEEP of the opening-range high or low that closes back inside (OPENING_RANGE_REJECTION).', decisionBar: 'The reclaim bar.', stopRule: 'Sweep extreme ± 0.1 ATR.', status: 'RETIRED', priorEvidence: 'A subset of SWEEP_CLOSE (opening-range pools only), which failed its clean test on 30 Sep 2026.' },
];

export const TRIGGERS_BY_ID: ReadonlyMap<string, TriggerDefinition> = new Map(TRIGGER_REGISTRY.map((t) => [t.triggerId, t]));

/** What a rule returns at a decision bar: the sequence it saw and where its stop goes. */
export interface TriggerHit {
  direction: Dir;
  anchor: MarketEvent;
  events: MarketEvent[];
  /** Reference extreme the stop sits beyond (the buffer is added by the builder). */
  stopRef: number;
}

type Rule = (args: { ctx: SeriesContext; log: SessionEventLog; i: number; at: (type: MarketEvent['type'], dir?: Dir) => MarketEvent[]; known: (from: number, to: number, type: MarketEvent['type'], dir?: Dir) => MarketEvent[] }) => TriggerHit[];

const sign = (d: Dir) => (d === 'BULLISH' ? 1 : -1);
const opp = (d: Dir): Dir => (d === 'BULLISH' ? 'BEARISH' : 'BULLISH');
/** The extreme against the trade (low for a long) over bars [from, to]. */
const adverse = (bars: readonly MomentumBar[], d: Dir, from: number, to: number) => {
  const r = barRange(bars, from, to);
  return d === 'BULLISH' ? r.lo : r.hi;
};
const favourable = (bars: readonly MomentumBar[], d: Dir, from: number, to: number) => {
  const r = barRange(bars, from, to);
  return d === 'BULLISH' ? r.hi : r.lo;
};
/** No close beyond `extreme` against the trade over (from, to]. */
const heldExtreme = (bars: readonly MomentumBar[], d: Dir, extreme: number, from: number, to: number) => {
  for (let k = from + 1; k <= to; k++) if (d === 'BULLISH' ? bars[k].close < extreme : bars[k].close > extreme) return false;
  return true;
};

const RULES: Record<string, Rule> = {
  A1: ({ at, log }) =>
    at('RECLAIM').map((r) => {
      const sw = log.byId.get(r.parentId!)!;
      return { direction: r.direction!, anchor: sw, events: [sw, r], stopRef: Number(sw.measures?.extreme) };
    }),
  A2: ({ ctx, at, known, i }) => {
    const out: TriggerHit[] = [];
    for (const bos of at('MICRO_BOS')) {
      const d = bos.direction!;
      const sw = known(i - 6, i - 1, 'SWEEP', d).pop();
      if (!sw) continue;
      const ext = Number(sw.measures?.extreme);
      if (!heldExtreme(ctx.series.bars, d, ext, sw.barIndex, i)) continue;
      out.push({ direction: d, anchor: sw, events: [sw, bos], stopRef: adverse(ctx.series.bars, d, sw.barIndex, i) });
    }
    return out;
  },
  A3: ({ ctx, known, i }) => {
    const bars = ctx.series.bars;
    const out: TriggerHit[] = [];
    for (const sw of known(i - 4, i - 1, 'SWEEP')) {
      const d = sw.direction!;
      const first = Number(sw.measures?.bars) === 2 ? sw.barIndex - 1 : sw.barIndex;
      const candleEdge = d === 'BEARISH' ? barRange(bars, first, sw.barIndex).lo : barRange(bars, first, sw.barIndex).hi;
      const crossed = (k: number) => (d === 'BEARISH' ? bars[k].close < candleEdge : bars[k].close > candleEdge);
      if (!crossed(i) || crossed(i - 1) || !heldExtreme(bars, d, Number(sw.measures?.extreme), sw.barIndex, i)) continue;
      // First crossing only: no earlier bar since the sweep crossed.
      let earlier = false;
      for (let k = sw.barIndex + 1; k < i; k++) if (crossed(k)) earlier = true;
      if (earlier) continue;
      out.push({ direction: d, anchor: sw, events: [sw], stopRef: adverse(bars, d, sw.barIndex, i) });
    }
    return out;
  },
  A4: ({ ctx, log, at, i }) =>
    at('RETEST_FAIL')
      .map((rf) => ({ rf, parent: rf.parentId ? log.byId.get(rf.parentId) : undefined }))
      .filter((x) => x.parent?.type === 'SWEEP')
      .map(({ rf, parent }) => ({ direction: rf.direction!, anchor: parent!, events: [parent!, rf], stopRef: adverse(ctx.series.bars, rf.direction!, parent!.barIndex, i) })),
  A5: ({ ctx, log, at, known, i }) => {
    const out: TriggerHit[] = [];
    for (const bos of at('MICRO_BOS')) {
      const d = bos.direction!;
      const fa = known(i - 6, i, 'FAILED_ACCEPTANCE', d).pop();
      if (!fa) continue;
      const br = fa.parentId ? log.byId.get(fa.parentId) : undefined;
      const from = br?.barIndex ?? fa.barIndex;
      out.push({ direction: d, anchor: fa, events: [...(br ? [br] : []), fa, bos], stopRef: adverse(ctx.series.bars, d, from, i) });
    }
    return out;
  },
  B1: ({ ctx, log, known, i }) => {
    const bars = ctx.series.bars;
    const out: TriggerHit[] = [];
    for (const cb of known(i - 2, i - 2, 'COMPRESSION_BREAK')) {
      const d = cb.direction!;
      const edge = cb.level!.price;
      if (![i - 1, i].every((k) => (d === 'BULLISH' ? bars[k].close > edge : bars[k].close < edge))) continue;
      const comp = cb.parentId ? log.byId.get(cb.parentId) : undefined;
      const opposite = d === 'BULLISH' ? Number(cb.measures?.boxLo) : Number(cb.measures?.boxHi);
      out.push({ direction: d, anchor: comp ?? cb, events: [...(comp ? [comp] : []), cb], stopRef: opposite });
    }
    return out;
  },
  B2: ({ ctx, log, at, i }) =>
    at('RETEST_HOLD').map((rh) => {
      const d = rh.direction!;
      const acc = rh.parentId ? log.byId.get(rh.parentId) : undefined;
      const br = acc?.parentId ? log.byId.get(acc.parentId) : undefined;
      const bar = ctx.series.bars[i];
      const ref = d === 'BULLISH' ? Math.min(bar.low, rh.level!.price) : Math.max(bar.high, rh.level!.price);
      return { direction: d, anchor: br ?? acc ?? rh, events: [...(br ? [br] : []), ...(acc ? [acc] : []), rh], stopRef: ref };
    }),
  B3: ({ ctx, log, at, i }) =>
    at('ACCEPTANCE')
      .map((acc) => ({ acc, br: acc.parentId ? log.byId.get(acc.parentId) : undefined }))
      .filter((x) => x.br?.type === 'OPENING_RANGE_BREAK')
      .map(({ acc, br }) => ({ direction: acc.direction!, anchor: br!, events: [br!, acc], stopRef: adverse(ctx.series.bars, acc.direction!, br!.barIndex, i) })),
  B4: ({ ctx, log, at, i }) => {
    const out: TriggerHit[] = [];
    for (const ft of at('FOLLOW_THROUGH')) {
      const acc = ft.parentId ? log.byId.get(ft.parentId) : undefined;
      if (acc?.type !== 'ACCEPTANCE') continue;
      const br = acc.parentId ? log.byId.get(acc.parentId) : undefined;
      if (br?.type !== 'MAJOR_LEVEL_BREAK') continue;
      out.push({ direction: ft.direction!, anchor: br, events: [br, acc, ft], stopRef: adverse(ctx.series.bars, ft.direction!, br.barIndex, i) });
    }
    return out;
  },
  C1: ({ ctx, log, at, known, i }) => {
    const out: TriggerHit[] = [];
    for (const bos of at('MICRO_BOS')) {
      const d = bos.direction!;
      if (i - 1 < log.start || ctx.stateAt(i - 1) !== (d === 'BULLISH' ? 'TRENDING_UP' : 'TRENDING_DOWN')) continue;
      const pb = known(i - 8, i - 1, 'PULLBACK', d).pop();
      if (!pb) continue;
      out.push({ direction: d, anchor: pb, events: [pb, bos], stopRef: adverse(ctx.series.bars, d, Math.max(log.start, pb.barIndex - 3), i) });
    }
    return out;
  },
  C2: ({ ctx, known, i }) => {
    const bars = ctx.series.bars;
    const out: TriggerHit[] = [];
    for (const disp of known(i - 8, i - 2, 'DISPLACEMENT')) {
      const d = disp.direction!;
      const k = disp.barIndex;
      const imp = bars[k];
      const rng = imp.high - imp.low;
      const edge = d === 'BULLISH' ? imp.high : imp.low;
      const crossed = (x: number) => (d === 'BULLISH' ? bars[x].close > edge : bars[x].close < edge);
      if (!crossed(i)) continue;
      let earlier = false;
      for (let x = k + 1; x < i; x++) if (crossed(x)) earlier = true;
      if (earlier) continue;
      const pullExt = adverse(bars, d, k + 1, i - 1);
      const retr = d === 'BULLISH' ? (imp.high - pullExt) / rng : (pullExt - imp.low) / rng;
      if (!(rng > 0) || retr < 0.382 || retr > 0.786) continue;
      out.push({ direction: d, anchor: disp, events: [disp], stopRef: pullExt });
    }
    return out;
  },
  C3: ({ ctx, log, at, i }) => {
    const out: TriggerHit[] = [];
    for (const ft of at('FOLLOW_THROUGH')) {
      const rh = ft.parentId ? log.byId.get(ft.parentId) : undefined;
      if (rh?.type !== 'RETEST_HOLD') continue;
      const d = ft.direction!;
      if (ctx.stateAt(i - 1) !== (d === 'BULLISH' ? 'TRENDING_UP' : 'TRENDING_DOWN')) continue;
      const acc = rh.parentId ? log.byId.get(rh.parentId) : undefined;
      const br = acc?.parentId ? log.byId.get(acc.parentId) : undefined;
      const rb = ctx.series.bars[rh.barIndex];
      out.push({ direction: d, anchor: br ?? rh, events: [...(br ? [br] : []), rh, ft], stopRef: d === 'BULLISH' ? rb.low : rb.high });
    }
    return out;
  },
  D1: ({ ctx, log, at, i }) => {
    const out: TriggerHit[] = [];
    for (const ft of at('FOLLOW_THROUGH')) {
      const parent = ft.parentId ? log.byId.get(ft.parentId) : undefined;
      if (!parent || parent.barIndex !== i - 1) continue;
      const d = ft.direction!;
      const prevEvents = log.byIndex.get(i - 1) ?? [];
      const cb = prevEvents.find((e) => e.type === 'COMPRESSION_BREAK' && e.direction === d);
      const ex = prevEvents.find((e) => e.type === 'RANGE_EXPANSION' && e.direction === d);
      if (!cb || !ex || (parent.id !== cb.id && parent.id !== ex.id)) continue;
      const eb = ctx.series.bars[i - 1];
      const comp = cb.parentId ? log.byId.get(cb.parentId) : undefined;
      out.push({ direction: d, anchor: comp ?? cb, events: [...(comp ? [comp] : []), cb, ex, ft], stopRef: (eb.high + eb.low) / 2 });
    }
    // One hit per direction even when both the break and the expansion were followed through.
    return out.filter((h, idx) => out.findIndex((x) => x.direction === h.direction) === idx);
  },
  D2: ({ ctx, log, known, i }) => {
    const bars = ctx.series.bars;
    const out: TriggerHit[] = [];
    for (const ex of known(i - 6, i - 2, 'RANGE_EXPANSION')) {
      const d = ex.direction!;
      const k = ex.barIndex;
      const sameBar = log.byIndex.get(k) ?? [];
      if (!sameBar.some((e) => (e.type === 'MICRO_BOS' || e.type === 'MAJOR_LEVEL_BREAK') && e.direction === d)) continue;
      const eb = bars[k];
      const rng = eb.high - eb.low;
      const resumes = (x: number) => (d === 'BULLISH' ? bars[x].close > bars[x - 1].high : bars[x].close < bars[x - 1].low);
      if (!resumes(i)) continue;
      let earlier = false;
      for (let x = k + 2; x < i; x++) if (resumes(x)) earlier = true;
      if (earlier) continue;
      const pullExt = adverse(bars, d, k + 1, i - 1);
      const retr = d === 'BULLISH' ? (eb.high - pullExt) / rng : (pullExt - eb.low) / rng;
      if (!(rng > 0) || retr < 0.25 || retr > 0.6) continue;
      out.push({ direction: d, anchor: ex, events: [ex], stopRef: pullExt });
    }
    return out;
  },
  D3: ({ ctx, known, i }) => {
    const bars = ctx.series.bars;
    const out: TriggerHit[] = [];
    for (const burst of known(i - 6, i - 2, 'VOLATILITY_BURST')) {
      const d = burst.direction!;
      const k = burst.barIndex;
      let counter = false;
      for (let x = k + 1; x < i; x++) if (d === 'BULLISH' ? bars[x].close < bars[x].open : bars[x].close > bars[x].open) counter = true;
      if (!counter) continue;
      const ext = favourable(bars, d, k, i - 1);
      const crossed = d === 'BULLISH' ? bars[i].close > ext : bars[i].close < ext;
      if (!crossed) continue;
      let earlier = false;
      for (let x = k + 1; x < i; x++) if (d === 'BULLISH' ? bars[x].close > favourable(bars, d, k, x - 1) : bars[x].close < favourable(bars, d, k, x - 1)) earlier = true;
      if (earlier) continue;
      out.push({ direction: d, anchor: burst, events: [burst], stopRef: adverse(bars, d, k + 1, i) });
    }
    return out;
  },
  E1: ({ ctx, log, at, i }) =>
    at('RETEST_FAIL')
      .map((rf) => ({ rf, fa: rf.parentId ? log.byId.get(rf.parentId) : undefined }))
      .filter((x) => x.fa?.type === 'FAILED_ACCEPTANCE')
      .map(({ rf, fa }) => {
        const br = fa!.parentId ? log.byId.get(fa!.parentId) : undefined;
        return { direction: rf.direction!, anchor: fa!, events: [...(br ? [br] : []), fa!, rf], stopRef: adverse(ctx.series.bars, rf.direction!, br?.barIndex ?? fa!.barIndex, i) };
      }),
  F1: ({ ctx, log, at, i }) => {
    const gap = (log.byIndex.get(log.start) ?? []).find((e) => e.type === 'GAP_UP' || e.type === 'GAP_DOWN');
    if (!gap) return [];
    return at('OPENING_RANGE_BREAK', gap.direction!).map((orb) => ({ direction: orb.direction!, anchor: gap, events: [gap, orb], stopRef: adverse(ctx.series.bars, orb.direction!, Math.max(log.start, i - 2), i) }));
  },
  F2: ({ ctx, log, i }) => {
    const gap = (log.byIndex.get(log.start) ?? []).find((e) => e.type === 'GAP_UP' || e.type === 'GAP_DOWN');
    if (!gap || i - log.start >= 8 || i === log.start) return [];
    const bars = ctx.series.bars;
    const prevClose = gap.level!.price;
    const d = opp(gap.direction!);
    const filled = (k: number) => (d === 'BEARISH' ? bars[k].close < prevClose : bars[k].close > prevClose);
    if (!filled(i)) return [];
    for (let k = log.start; k < i; k++) if (filled(k)) return [];
    return [{ direction: d, anchor: gap, events: [gap], stopRef: adverse(bars, d, log.start, i) }];
  },
  F3: ({ ctx, log, at, i }) => at('OPENING_RANGE_BREAK').map((orb) => ({ direction: orb.direction!, anchor: orb, events: [orb], stopRef: adverse(ctx.series.bars, orb.direction!, Math.max(log.start, i - 2), i) })),
  F4: ({ log, at }) =>
    at('OPENING_RANGE_REJECTION').map((r) => {
      const sw = log.byId.get(r.parentId!)!;
      return { direction: r.direction!, anchor: sw, events: [sw, r], stopRef: Number(sw.measures?.extreme) };
    }),
};

/** Move potential at the decision bar: room to T1, obstacles, and how much of a typical session range is already used. */
export function movePotentialAt(ctx: SeriesContext, s: number, i: number, args: { direction: Dir; entry: number; atr: number; t1: number | null; t2: number | null; rToT1: number | null }): MovePotential {
  const start = ctx.series.sessionStarts[s];
  const r = barRange(ctx.series.bars, start, i);
  const adr = ctx.adrAt(s);
  const consumed = adr != null && adr > 0 ? (r.hi - r.lo) / adr : null;
  const remaining = consumed != null ? Math.max(0, 1 - consumed) : null;
  const lo = Math.min(args.entry, args.t1 ?? args.entry);
  const hi = Math.max(args.entry, args.t1 ?? args.entry);
  const obstacles = args.t1 == null ? 0 : ctx.researchPoolsAt(s, i).filter((p) => p.price > lo && p.price < hi).length;
  const cls: MovePotential['class'] =
    args.t1 == null || (args.rToT1 ?? 0) < EVENT_RULES.minT1R || (remaining != null && remaining < 0.25)
      ? 'LOW'
      : (args.rToT1 ?? 0) >= 2.5 && remaining != null && remaining >= 0.6
        ? 'HIGH'
        : 'NORMAL';
  return {
    t1DistanceAtr: args.t1 != null ? round3(Math.abs(args.t1 - args.entry) / args.atr) : null,
    t2DistanceAtr: args.t2 != null ? round3(Math.abs(args.t2 - args.entry) / args.atr) : null,
    obstaclesToT1: obstacles,
    moveConsumedPct: consumed != null ? round3(consumed) : null,
    remainingMovePct: remaining != null ? round3(remaining) : null,
    expectedR: args.rToT1 != null ? round3(args.rToT1) : null,
    class: cls,
  };
}

/**
 * Entry timing: how far price had already gone from the anchor when the rule
 * let you in. EARLY = decided on the anchor bar itself; then OPTIMAL ≤ 25% of
 * the anchor → T1 distance used with ≥ 2R left, ACCEPTABLE ≤ 50% with ≥ 1.5R,
 * LATE ≤ 75%, CHASING beyond that or under 1R left.
 */
export function entryTimingAt(args: { direction: Dir; anchorIndex: number; anchorPrice: number; decisionIndex: number; entry: number; atr: number; t1: number | null; rToT1: number | null }): EntryTiming {
  const sg = sign(args.direction);
  const travelled = ((args.entry - args.anchorPrice) * sg) / args.atr;
  const span = args.t1 != null ? (args.t1 - args.anchorPrice) * sg : null;
  const consumed = span != null && span > 0 ? Math.max(0, ((args.entry - args.anchorPrice) * sg) / span) : null;
  const r = args.rToT1;
  let cls: EntryTiming['class'];
  if (args.decisionIndex === args.anchorIndex) cls = 'EARLY';
  else if (r != null && r < 1) cls = 'CHASING';
  else if (consumed == null) cls = travelled <= 0.5 ? 'OPTIMAL' : travelled <= 1 ? 'ACCEPTABLE' : travelled <= 2 ? 'LATE' : 'CHASING';
  else if (consumed <= 0.25 && (r ?? 0) >= 2) cls = 'OPTIMAL';
  else if (consumed <= 0.5 && (r ?? 0) >= 1.5) cls = 'ACCEPTABLE';
  else if (consumed <= 0.75) cls = 'LATE';
  else cls = 'CHASING';
  return {
    barsSinceAnchor: args.decisionIndex - args.anchorIndex,
    travelledAtr: round3(travelled),
    moveConsumedPct: consumed != null ? round3(consumed) : null,
    currentRAvailable: r != null ? round3(r) : null,
    class: cls,
  };
}

/** Builds a candidate from a rule hit at decision bar i: entry, stop, the real target, bucket, move potential, timing. */
export function buildCandidate(ctx: SeriesContext, log: SessionEventLog, def: TriggerDefinition, hit: TriggerHit, i: number): TriggerCandidate | null {
  const bars = ctx.series.bars;
  const atr = ctx.atrAt(i);
  if (atr == null || !Number.isFinite(hit.stopRef)) return null;
  const d = hit.direction;
  const entry = bars[i].close;
  const buf = EVENT_RULES.stopBufferAtr * atr;
  const stop = d === 'BULLISH' ? hit.stopRef - buf : hit.stopRef + buf;
  const risk = (entry - stop) * sign(d);
  const anchorIndex = Math.min(hit.anchor.barIndex, i);
  const span = barRange(bars, anchorIndex, i);
  const pools = ctx.poolsAt(log.s, i)?.pools ?? [];
  const { t1, t2 } = risk > 0 ? nearestOppositePool(pools, d, entry, span.lo, span.hi) : { t1: null, t2: null };
  const rToT1 = t1 && risk > 0 ? Math.abs(t1.price - entry) / risk : null;
  const bucket: CandidateBucket = !(risk > 0) ? 'INVALID_STOP' : !t1 ? 'NO_TARGET' : rToT1! < EVENT_RULES.minT1R ? 'LOW_RR' : 'TRADE';
  const lvl = (p: typeof t1): EventLevel | null => (p ? { kind: p.kind, price: round2(p.price), rank: p.rank } : null);
  return {
    triggerId: def.triggerId,
    family: def.family,
    direction: d,
    session: log.session,
    decisionIndex: i,
    decisionTime: bars[i].time,
    entry: round2(entry),
    stop: round2(stop),
    atr: round2(atr),
    t1: lvl(t1),
    t2: lvl(t2),
    rToT1: rToT1 != null ? round3(rToT1) : null,
    bucket,
    anchorEventId: hit.anchor.id,
    anchorIndex,
    anchorPrice: hit.anchor.price,
    eventIds: hit.events.map((e) => e.id),
    marketState: ctx.stateAt(i),
    movePotential: movePotentialAt(ctx, log.s, i, { direction: d, entry, atr, t1: t1?.price ?? null, t2: t2?.price ?? null, rToT1 }),
    timing: entryTimingAt({ direction: d, anchorIndex, anchorPrice: hit.anchor.price, decisionIndex: i, entry, atr, t1: t1?.price ?? null, rToT1 }),
  };
}

/**
 * Every candidate of the given triggers at decision bar i, from the log as it
 * stood at i's close. `allowDecision` lets the caller apply session guards.
 */
export function evaluateTriggersAt(ctx: SeriesContext, log: SessionEventLog, i: number, triggerIds: readonly string[] = TRIGGER_REGISTRY.map((t) => t.triggerId)): TriggerCandidate[] {
  const known = (from: number, to: number, type: MarketEvent['type'], dir?: Dir) =>
    log.events.filter((e) => e.barIndex >= Math.max(from, log.start) && e.barIndex <= Math.min(to, i) && e.type === type && (dir == null || e.direction === dir));
  const at = (type: MarketEvent['type'], dir?: Dir) => known(i, i, type, dir);
  const out: TriggerCandidate[] = [];
  for (const id of triggerIds) {
    const def = TRIGGERS_BY_ID.get(id);
    const rule = RULES[id];
    if (!def || !rule) continue;
    for (const hit of rule({ ctx, log, i, at, known })) {
      // A rule may never read an event confirmed after its decision bar.
      if (hit.events.some((e) => e.barIndex > i)) throw new Error(`Trigger ${id} read an event after its decision bar ${i}`);
      const c = buildCandidate(ctx, log, def, hit, i);
      if (c) out.push(c);
    }
  }
  return out;
}
