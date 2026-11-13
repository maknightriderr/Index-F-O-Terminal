// Approved implementation pack; pure functions only. Time, calendars and data provenance are injected.
import { atr, ema } from '../indicators/index.js';
import { freshOrderFlowEvidence, type FreshOrderFlowInput } from './order-flow-evidence.js';
import { detectOrderBlocks } from '../market-structure/index.js';
import { flowCoverage, FLOW_MIN_SAMPLED_COVERAGE } from '../order-flow/index.js';
export const FRESH_PACK_VERSION = 'NEW-INTRADAY-2.2';
/** Minimum underlying reward / risk for a target, and the furthest target in 5-minute ATR before it is capped (1.5). */
/**
 * 1.5 regime filter: the trend strategies (ORB, VWAP pullback, opening pullback) stand aside on a choppy day, where a
 * naked option buyer loses most. Choppy = repeated VWAP crosses without a strong 15-minute trend, or a 5-minute
 * Kaufman efficiency ratio (|net move| ÷ path length) below FRESH_MIN_EFFICIENCY over the last FRESH_EFFICIENCY_BARS.
 */
/** 5 Nov: lowered from 0.3. On 4 Nov the filter stood the trend strategies aside on >50% of evaluations; 0.2-0.3
 * (moderate trend) now reaches the setup rules, below 0.2 (a real see-saw) is still refused. */
export const FRESH_MIN_EFFICIENCY = 0.2;
export const FRESH_EFFICIENCY_BARS = 12;
/** Earlier sessions needed for relative volume (rvol) at a slot and for the opening-volume reference. */
export const FRESH_MIN_VOLUME_SESSIONS = 15;
/** VWAP pullback runs only from 75 minutes after the open (10:30 on NSE), after the ORB and opening-pullback window. */
export const FRESH_VWAP_START_MS = 75 * 60000;
export const FRESH_MIN_TARGET_R = 1.5;
/**
 * How long a candidate may wait for an executable option book (6 Nov: was 2 s). Options trade every few seconds, so
 * a 2 s window let 6 of 7 setups in two days expire before one fresh book arrived. The entry is still taken only on
 * a book observed after arrival (<= 2 s old), and assessFreshPlan's EXTENDED_ENTRY guard refuses it if the
 * underlying has run more than 0.25 ATR past the signal close in the meantime.
 */
export const FRESH_ENTRY_WINDOW_MS = 20_000;
export const FRESH_MAX_TARGET_ATR = 3;
export const FRESH_STRATEGIES = ['NEW_ORB_RETEST_V1', 'NEW_VWAP_PULLBACK_V1', 'NEW_PREVIOUS_SESSION_SWEEP_V1', 'NEW_FIRST_OPENING_PULLBACK_V1', 'NEW_MOMENTUM_BREAKOUT_V1', 'NEW_TREND_FLAG_V1', 'NEW_EVENT_BREAKOUT_V1'] as const;
/**
 * Strategies evaluated and recorded but never sent to the adapter (their candidates are stored as SHADOW_STRATEGY).
 * 2.0 (7 Nov) put the seven 1.x strategies here; 2.2 (owner, 12 Nov: "enable every disabled strategy") makes them
 * active paper strategies again, unchanged, beside the 2.0 ones. The mechanism stays for a later shadow strategy.
 */
export const FRESH_SHADOW_STRATEGIES: ReadonlySet<string> = new Set<string>();
/**
 * 1.8 trend-following pack (owner request, 5 Nov 2026: a 740-point CRUDEOIL fall that none of the four pullback /
 * reversal strategies could take). These three ride a move instead of waiting for a retest, so they exit on a
 * trailing stop rather than a fixed target (exitProfile 'TREND', see paper.ts advanceFreshPosition).
 */
export const FRESH_TREND_STRATEGIES: readonly string[] = ['NEW_MOMENTUM_BREAKOUT_V1', 'NEW_TREND_FLAG_V1', 'NEW_EVENT_BREAKOUT_V1'];
/** Momentum breakout: efficiency over the last FRESH_EFFICIENCY_BARS needed (a trend day, not a drift). */
export const FRESH_MOMENTUM_MIN_EFFICIENCY = 0.4;
/**
 * Pullback strategies (1.12): in a strong 15-minute trend they skip the 1-hour efficiency (choppy) test, which the
 * pullback itself fails (6 Nov NIFTY: a VWAP pullback after 10:30 refused EFFICIENCY_00/10PCT for 30 minutes).
 */
export const FRESH_PULLBACK_STRATEGIES: ReadonlySet<string> = new Set(['NEW_VWAP_PULLBACK_V1', 'NEW_FIRST_OPENING_PULLBACK_V1', 'NEW_TREND_FLAG_V1']);
/**
 * ORB retest (1.10, 5 Nov): a breakout of the opening range is taken all session (up to the entry cutoff), not only in
 * the first two hours after the anchor - a range that holds for hours and then breaks and runs was never captured.
 *
 * 1.11 (owner, 5 Nov): after FRESH_ORB_EARLY_WINDOW_MS a late breakout is either
 *  - the FIRST close beyond the level since the range formed (a range expansion), or
 *  - a STOP-HUNT re-break: an earlier break closed back inside the range (failed, trapping breakout traders), and this
 *    breakout closes beyond that failed attempt's extreme (the trap's stops are gone) on rvol >= FRESH_ORB_REBREAK_MIN_RVOL.
 * Earlier closes beyond the level that never returned inside are the same move, not a re-break, and are refused.
 * The retest confirmation (hold of the level within 3 bars, a confirming bar) applies to every ORB entry.
 */
export const FRESH_ORB_EARLY_WINDOW_MS = 7200000;
export const FRESH_ORB_REBREAK_MIN_RVOL = 2;
/**
 * Momentum breakout: how far the breakout close may sit from VWAP, in 5-minute ATR (1.11, was 3). On a trend day price
 * holds 4-6 ATR from VWAP, so 3 refused the strongest days (5 Nov CRUDEOIL: MOM_EXTENDED_OR_CHASED). The chase rule
 * (<= 1 earlier new-extreme close in the last 30 minutes) and the 2-ATR risk cap still keep late entries out.
 */
export const FRESH_MOMENTUM_MAX_VWAP_ATR = 5;
/**
 * Momentum breakout bar (1.9, 5 Nov): range >= 0.9 ATR, body >= 50% of range, close in the outer 35%. Was 1.2 ATR / 60% /
 * 70%: NIFTY's breakouts of the day's high on 5 Nov were refused MOM_BAR_QUALITY four times in an hour. Owner-approved
 * paper loosening; outcomes are compared against 1.8 by pack version.
 */
export const FRESH_MOMENTUM_BAR_MIN_RANGE_ATR = 0.9;
export const FRESH_MOMENTUM_BAR_MIN_BODY = 0.5;
export const FRESH_MOMENTUM_BAR_MIN_CLOSE_LOCATION = 0.65;
/** Momentum breakout: breakout bar volume against the same slot on earlier sessions. */
export const FRESH_MOMENTUM_MIN_RVOL = 2;
/** Trend strategies: the widest initial underlying risk accepted, in 5-minute ATRs (a wider stop only buys fewer lots). */
export const FRESH_TREND_MAX_RISK_ATR = 2;
/** Event breakout: the post-release range is the first 15 minutes; entries until 90 minutes after the release. */
export const FRESH_EVENT_RANGE_MS = 15 * 60000;
export const FRESH_EVENT_WINDOW_MS = 90 * 60000;
/** Trend exits: trailing distance behind the best underlying price (ATRs) and the nominal admission target (R). */
export const FRESH_TREND_TRAIL_ATR = 2;
export const FRESH_TREND_NOMINAL_R = 2.5;
/** A major level (opening range, previous day) closer than this many R ahead blocks a trend entry outright. */
export const FRESH_TREND_MIN_ROOM_R = 0.5;
/** 2.0 strategies that trade (the 1.x list above runs in shadow). */
export const FRESH_ACTIVE_STRATEGIES = ['NEW_RS_STOCK_V1', 'NEW_INDEX_BREADTH_V1', 'NEW_MCX_FLOW_V1'] as const;
/** Every strategy the engine evaluates: 1.x (shadow) and 2.0 (active). */
export const FRESH_ALL_STRATEGIES = [...FRESH_STRATEGIES, ...FRESH_ACTIVE_STRATEGIES] as const;
export type FreshStrategy = typeof FRESH_ALL_STRATEGIES[number];
/**
 * 2.0 stock-in-play inputs from the F&O universe scan (all ~200 stocks, refreshed every 150 s), as of `at`.
 * relativeStrength / sectorRelativeStrength: today's % change minus NIFTY's (percentage points).
 * atmSpreadPct: ATM bid-ask spread as % of mid. ivRank: 0-100, null when the history is short.
 */
export interface FreshStockIntel {
    at: number;
    relativeStrength: number;
    oiInterpretation: string;
    sectorRelativeStrength: number | null;
    atmSpreadPct: number | null;
    ivRank: number | null;
}
/** 2.0 NEW_RS_STOCK_V1 parameters (paper hypothesis; every gate is counted in the decision summary). */
export const FRESH_INTEL_MAX_AGE_MS = 6 * 60000;
export const FRESH_RS_START_MS = 45 * 60000;
export const FRESH_RS_MIN_PCT = 0.7;
export const FRESH_RS_SECTOR_TOLERANCE_PCT = 0.3;
export const FRESH_RS_MAX_SPREAD_PCT = 1;
export const FRESH_RS_MAX_IV_RANK = 80;
export const FRESH_RS_TOUCH_ATR = 0.25;
export const FRESH_RS_BASE_MAX_ATR = 0.9;
export const FRESH_RS_MAX_RISK_ATR = 1.5;
/**
 * 2.1 (owner, 11 Nov: "design the strategies so that trades come"). In a week of 2.0 the three active strategies found
 * no setup at all: each asked for seven or eight conditions at once and the entry trigger was the narrowest of them.
 * 2.1 keeps the direction filters (relative strength, breadth, order flow, the 15-minute trend, VWAP side, option
 * liquidity, the risk cap) and widens the entry: a pullback may be up to five bars back and need not be a perfect
 * touch, the resumption bar needs average (not above-average) volume, a base may be wider, and a plain continuation
 * (a close beyond the last six bars) is a third trigger. Paper hypothesis: more entries, not a claim of better ones.
 */
export const FRESH_HOLD_WINDOW_BARS = 5;
export const FRESH_HOLD_CLOSE_LOCATION = 0.55;
export const FRESH_HOLD_RVOL = 1.0;
export const FRESH_BASE_RVOL = 1.2;
export const FRESH_BASE_BODY = 0.4;
/** Of the last six five-minute closes, how many may be on the wrong side of VWAP. */
export const FRESH_VWAP_MISSES = 2;
export const FRESH_CONTINUATION_BARS = 6;
export const FRESH_CONTINUATION_RVOL = 1.2;
/** One option-chain OI sample (nearest expiry), as of `at`. */
export interface FreshOiSample { at: number; expiry?: string; strikes: ReadonlyArray<{ strike: number; callOi: number | null; putOi: number | null }> }
/**
 * 2.0 index inputs, as of `at`. breadth: the weight share (0-1) of the index's heavyweights trading above their own
 * VWAP (null when under 70% of the weight has data). futuresOi: the index future's 30-minute price / OI read
 * (LONG_BUILDUP, SHORT_BUILDUP, SHORT_COVERING, LONG_UNWINDING, NEUTRAL) or null. oiNow / oiBefore: chain OI now and
 * ~15 minutes earlier.
 */
export interface FreshIndexIntel {
    at: number;
    breadth: number | null;
    breadthCoverage: number;
    futuresOi: string | null;
    oiNow: FreshOiSample | null;
    oiBefore: FreshOiSample | null;
}
/** 2.0 NEW_INDEX_BREADTH_V1 parameters (paper hypothesis). */
export const FRESH_IDX_BREADTH_BULL = 0.6;
export const FRESH_IDX_BREADTH_BEAR = 0.4;
export const FRESH_IDX_MIN_ROOM_R = 1.0;
/** A strike is an OI wall when its OI is at least this share of the largest OI on that side of the chain. */
export const FRESH_IDX_WALL_SHARE = 0.6;
/** A wall break needs the wall's own OI down at least this much over ~15 minutes (writers covering). */
export const FRESH_IDX_WALL_UNWIND = 0.05;
export const FRESH_IDX_OI_MAX_AGE_MS = 3 * 60000;
export const FRESH_IDX_OI_LOOKBACK_MS: readonly [number, number] = [12 * 60000, 20 * 60000];
export const FRESH_IDX_WALL_BREAK_MAX_RISK_ATR = 1.5;
/** The last closed 15-minute footprint of the instrument's flow contract (relative reads only: no price levels). */
export interface FreshFootprintRead { barTime: number; deltaPct: number | null; buyImbalances: number; sellImbalances: number; trades: number }
/** 2.0 NEW_MCX_FLOW_V1 parameters (paper hypothesis). Flow sides are INFERRED by the feed, never exact. */
export const FRESH_MCX_FLOW_BARS = 3;
export const FRESH_MCX_FLOW_MIN_DELTA = 0.08;
export const FRESH_MCX_TRIGGER_DELTA = 0.08;
export const FRESH_MCX_BREAK_DELTA = 0.12;
/** An order block counts as "at the entry" within this many ATR (shadow tag only). */
export const FRESH_OB_NEAR_ATR = 0.5;
const RS_BULLISH_OI: ReadonlySet<string> = new Set(['LONG_BUILDUP', 'SHORT_COVERING']);
const RS_BEARISH_OI: ReadonlySet<string> = new Set(['SHORT_BUILDUP', 'LONG_UNWINDING']);
export type FreshDirection = 'BULLISH' | 'BEARISH';
export interface FreshBar {
    time: number;
    availableAt: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface FreshLevel {
    price: number;
    knownAt: number;
    role: 'SUPPORT' | 'RESISTANCE';
    kind: string;
}
export interface FreshContext {
    now: number;
    session: string;
    sessionOpen: number;
    sessionClose: number;
    instrument: string;
    sourceEpoch: string;
    bars5: readonly FreshBar[];
    bars15: readonly FreshBar[];
    bars1: readonly FreshBar[];
    /** Historical volumes from the same elapsed-session slot; point-in-time builder supplies prior sessions only. */
    rvolReferences: Readonly<Record<number, readonly number[]>>;
    openingVolumeReferences: readonly number[];
    /** Opening-range anchors: the session open, plus MCX's evening anchor (NYMEX/COMEX open). Default: session open. */
    openingAnchors?: ReadonlyArray<{ at: number; volumeReferences: readonly number[] }>;
    /** 1.8: release instants (epoch ms, confirmed times) of scheduled events relevant to this instrument's market. */
    recentReleases?: readonly number[];
    /** 1.8 shadow: five-minute inferred buy/sell volume of the instrument's flow contract (tags candidates only). */
    orderFlow?: FreshOrderFlowInput;
    levels: readonly FreshLevel[];
    previousHigh: number;
    previousLow: number;
    /** BENCHMARK when the rvol references borrow the exchange benchmark's intraday volume shape (own level). */
    volumeShape?: 'OWN' | 'BENCHMARK';
    /** Which live reference was stale when referenceVerified is false (diagnostics only). */
    referenceDetail?: string;
    referenceVerified: boolean;
    /** Entry permitted under the declared event policy; complete coverage is separate immutable evidence. */
    eventClear: boolean;
    eventEvidence?: Record<string,unknown>;
    calendarVerified: boolean;
    /** 2.0: the stock's universe-scan inputs (undefined for an index / commodity, null when no fresh scan row). */
    stockIntel?: FreshStockIntel | null;
    /** 2.0: the index's breadth / futures OI / chain OI inputs (undefined for a stock / commodity). */
    indexIntel?: FreshIndexIntel | null;
    /** 2.0: true for an MCX commodity reference (NEW_MCX_FLOW_V1). */
    commodity?: boolean;
    /** 2.0: the last closed 15-minute footprint of the flow contract, or null when unavailable. */
    footprint15?: FreshFootprintRead | null;
}
/** Dhan engine v2 setups paper-traded through the same adapter / store (phase 4). Not evaluated by this module. */
export const FRESH_EXTERNAL_STRATEGIES = ['DHAN_A_SWEEP_ABSORPTION', 'DHAN_B_IMBALANCE_BREAKOUT', 'DHAN_C_FAILED_AUCTION_CVD', 'DHAN_D_VWAP_PROFILE_REJECTION', 'DHAN_E_ORDER_FLOW', 'DHAN_E1_VALUE_REENTRY', 'DHAN_E_ORDER_FLOW_5M', 'DHAN_EXPIRY_GAMMA', 'HTA_HUMAN_TA_V1'] as const;
export type FreshExternalStrategy = typeof FRESH_EXTERNAL_STRATEGIES[number];
/** Every strategy whose paper trades the performance report covers (fresh-start + Dhan engine, separate books). */
export const FRESH_REPORTED_STRATEGIES = [...FRESH_ALL_STRATEGIES, ...FRESH_EXTERNAL_STRATEGIES] as const;
/**
 * A premium-defined exit (owner, 8 Nov, expiry gamma): the position is risked and closed on its OPTION premium only —
 * a stop at stopFraction below the entry premium, a time exit at exitAt — with no underlying target, structural
 * invalidation, trailing, no-progress or max-hold exit. Entries are allowed until entryUntil (not the usual one hour
 * before the session cutoff) on the expiry-day contract, with |delta| in [minAbsDelta, maxAbsDelta]. The candidate's
 * stop / target are then model levels for the premium model only (never exits).
 */
export interface FreshPremiumExit { stopFraction: number; exitAt: number; entryUntil: number; minAbsDelta: number; maxAbsDelta: number; expiryDay: string; allowedStrikes?: readonly number[] }
export interface FreshCandidate {
    id: string;
    parentId: string;
    version: string;
    strategy: FreshStrategy | FreshExternalStrategy;
    direction: FreshDirection;
    instrument: string;
    sourceEpoch: string;
    session: string;
    at: number;
    referenceEntry: number;
    stop: number;
    target: number;
    atr: number;
    expiresAt: number;
    /** 'TREND' (1.8): no fixed-target exit; a trailing stop trailAtr ATRs behind the best underlying price instead.
     *  'STRUCTURE' (Dhan engine, master prompt Part 14): structural stop on a 5-minute close, the setup's target, no
     *  breakeven move at +1R, from +1.5R a stop 1R behind the best price (5-minute close), no max-hold / no-progress exit. */
    exitProfile?: 'TARGET' | 'TREND' | 'STRUCTURE';
    trailAtr?: number;
    premiumExit?: FreshPremiumExit;
    /** Strikes the setup itself chose (Human TA: by its own Greeks); the adapter prices only these, still under every admission rule. */
    allowedStrikes?: readonly number[];
    /** How long before the session cutoff new entries stop (default one hour; the Dhan engine uses 45 minutes, its
     *  master prompt Part 17 secondary window ending 14:45 on NSE / BSE). Never under 10 minutes. */
    lastEntryBeforeCutoffMs?: number;
    origin: number;
    evidence: Record<string, unknown>;
}
export interface FreshEvaluation {
    candidates: FreshCandidate[];
    refusals: Array<{
        strategy: FreshStrategy;
        code: string;
        /** For SETUP_CONDITIONS_NOT_MET / CHOPPY_REGIME: the furthest gate the setup reached (diagnostics only). */
        detail?: string;
    }>;
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const last = <T>(a: readonly T[]) => a[a.length - 1];
const median = (v: readonly number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : NaN; };
const body = (b: FreshBar) => b.high > b.low ? Math.abs(b.close - b.open) / (b.high - b.low) : 0;
const closeLocation = (b: FreshBar, d: number) => b.high > b.low ? (d === 1 ? b.close - b.low : b.high - b.close) / (b.high - b.low) : 0;
function closed(bars: readonly FreshBar[], interval: number, now: number): FreshBar[] {
    return bars.filter(b => b.time + interval <= now && b.availableAt <= now);
}
function valid(bars: readonly FreshBar[]): boolean {
    return bars.every((b, i) => [b.time, b.availableAt, b.open, b.high, b.low, b.close, b.volume].every(finite)
        && b.time > 0 && b.availableAt >= b.time && b.low > 0 && b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close) && b.volume >= 0 && (i === 0 || b.time > bars[i - 1].time));
}
export function freshSwingLevels(bars: readonly FreshBar[], now: number): FreshLevel[] {
    const a = closed(bars, 300000, now);
    const out: FreshLevel[] = [];
    for (let i = 2; i < a.length - 2; i++) {
        const w = a.slice(i - 2, i + 3), knownAt = Math.max(a[i + 2].time + 300000, a[i + 2].availableAt);
        if (w.every((b, j) => j === 2 || b.high < a[i].high))
            out.push({ price: a[i].high, knownAt, role: 'RESISTANCE', kind: 'CONFIRMED_SWING' });
        if (w.every((b, j) => j === 2 || b.low > a[i].low))
            out.push({ price: a[i].low, knownAt, role: 'SUPPORT', kind: 'CONFIRMED_SWING' });
    }
    return out;
}
export function evaluateFreshStrategies(c: FreshContext): FreshEvaluation {
    const out: FreshEvaluation = { candidates: [], refusals: [] };
    // `detail` (diagnostics only) says which input was short, e.g. WARMUP "5M_80_15M_20" or BLOCKED_REFERENCE "SIGNAL_STALE".
    const refuseAll = (code: string, detail?: string) => {
        for (const strategy of FRESH_ALL_STRATEGIES)
            out.refusals.push(detail ? { strategy, code, detail } : { strategy, code });
        return out;
    };
    if (![c.now, c.sessionOpen, c.sessionClose].every(finite) || c.sessionClose <= c.sessionOpen || !c.instrument || !c.sourceEpoch || !c.session)
        return refuseAll('INVALID_CONTEXT');
    if (!c.referenceVerified || !c.calendarVerified)
        return refuseAll('BLOCKED_REFERENCE_OR_CALENDAR', !c.calendarVerified ? 'CALENDAR_UNVERIFIED' : c.referenceDetail);
    if (!c.eventClear)
        return refuseAll('BLOCKED_EVENT_DATA');
    if (c.now < c.sessionOpen || c.now >= c.sessionClose - 3600000)
        return refuseAll('ENTRY_WINDOW');
    if (c.bars5.length > 1000 || c.bars15.length > 1000 || c.bars1.length > 1440 || c.levels.length > 2000)
        return refuseAll('HISTORY_BUDGET_EXCEEDED');
    if (!valid(c.bars5) || !valid(c.bars15) || !valid(c.bars1))
        return refuseAll('INVALID_HISTORY');
    const b = closed(c.bars5, 300000, c.now), h = closed(c.bars15, 900000, c.now), m = closed(c.bars1, 60000, c.now);
    if (b.length < 100 || h.length < 75)
        return refuseAll('WARMUP', `5M_${b.length}_15M_${h.length}`);
    // The 15-minute trend needs a bar closed within the last ~15 minutes. In the session's first 15 minutes none of
    // today's has closed yet and the previous session's last bar is the newest one — that is the open, not a stale
    // feed (5 Nov: every MCX evaluation at 09:05/09:10 read STALE_TREND_CONTEXT). Mid-session it is still stale.
    if (c.now - (last(h).time + 900000) > 902000)
        return refuseAll(last(h).time < c.sessionOpen && c.now < c.sessionOpen + 900000 + 2000 ? 'TREND_FIRST_15M_PENDING' : 'STALE_TREND_CONTEXT');
    const today = b.filter(x => x.time >= c.sessionOpen), minute = m.filter(x => x.time >= c.sessionOpen);
    if (!today.length || !minute.length)
        return refuseAll('MISSING_SESSION_DATA');
    // Which series is broken and how (detail only; the refusal itself is unchanged): the session's first bar missing,
    // or a gap inside the session, on the 5-minute or the 1-minute series.
    const missing = today[0].time !== c.sessionOpen ? '5M_OPEN_BAR_MISSING'
        : today.some((x, i) => i > 0 && x.time - today[i - 1].time !== 300000) ? '5M_GAP'
            : minute[0].time !== c.sessionOpen ? '1M_OPEN_BAR_MISSING'
                : minute.some((x, i) => i > 0 && x.time - minute[i - 1].time !== 60000) ? '1M_GAP' : null;
    if (missing)
        return refuseAll('MISSING_BARS', missing);
    const current = last(today), decisionAt = Math.max(current.time + 300000, current.availableAt);
    // The opening range belongs to the latest anchor that has started: the session open, or for MCX the evening open of
    // the US energy/metals session (1.7). ORB retest and the first opening pullback run in the two hours after it.
    const anchors = c.openingAnchors?.length ? c.openingAnchors : [{ at: c.sessionOpen, volumeReferences: c.openingVolumeReferences }];
    const anchor = [...anchors].filter(x => x.at <= c.now).sort((x, y) => y.at - x.at)[0] ?? anchors[0];
    const day = today.filter(x => x.time >= anchor.at), sinceAnchor = c.now - anchor.at;
    if (c.now - decisionAt > 2000)
        return refuseAll('LATE_DECISION');
    if (last(minute).time + 60000 < current.time + 300000)
        return refuseAll('MISSING_MINUTE_COVERAGE');
    const atrSeries = atr(b.map(x => x.high), b.map(x => x.low), b.map(x => x.close), 14);
    const a = last(atrSeries);
    const impulseBase = day.length ? day : today, impulseAtr = atrSeries[b.findIndex(x => x.time === impulseBase[Math.min(2, impulseBase.length - 1)].time) - 14];
    const ah = last(atr(h.map(x => x.high), h.map(x => x.low), h.map(x => x.close), 14));
    if (!(a > 0 && ah > 0))
        return refuseAll('INVALID_ATR');
    const e20 = ema(h.map(x => x.close), 20), e50 = ema(h.map(x => x.close), 50);
    const bull = last(h).close > last(e20) && last(e20) > last(e50), bear = last(h).close < last(e20) && last(e20) < last(e50);
    const strong = (bull || bear) && Math.abs(last(e20) - last(e50)) >= .25 * ah && Math.abs(last(e20) - e20[e20.length - 4]) >= .1 * ah;
    function vwapAt(at: number): number { const xs = minute.filter(x => x.time + 60000 <= at), v = xs.reduce((s, x) => s + x.volume, 0); return v > 0 ? xs.reduce((s, x) => s + (x.high + x.low + x.close) / 3 * x.volume, 0) / v : NaN; }
    function rvol(bar: FreshBar): number { const refs = c.rvolReferences[(bar.time - c.sessionOpen) / 300000] ?? []; const usable = refs.filter(x => finite(x) && x > 0).slice(-20); return usable.length >= FRESH_MIN_VOLUME_SESSIONS ? bar.volume / median(usable) : NaN; }
    const vwap = vwapAt(current.time + 300000);
    if (!finite(vwap))
        return refuseAll('NO_VOLUME');
    // Every setup needs relative volume; without enough earlier sessions say so instead of a generic "no setup".
    if (!finite(rvol(current)))
        return refuseAll('RVOL_HISTORY_INSUFFICIENT', `SESSIONS_${(c.rvolReferences[(current.time - c.sessionOpen) / 300000] ?? []).filter(x => finite(x) && x > 0).length}`);
    const signs = today.slice(-6).map(x => Math.sign(x.close - vwapAt(x.time + 300000)));
    const crosses = signs.reduce((n, x, i) => n + (i > 0 && x !== 0 && signs[i - 1] !== 0 && x !== signs[i - 1] ? 1 : 0), 0), range = !strong && crosses >= 2;
    const levels = [...c.levels, ...freshSwingLevels(b, c.now)].filter(x => finite(x.price) && x.price > 0 && x.knownAt <= decisionAt);
    const sessionOpening = today.slice(0, 3);
    if (sessionOpening.length === 3)
        levels.push({ price: Math.max(...sessionOpening.map(x => x.high)), role: 'RESISTANCE', kind: 'ORH', knownAt: sessionOpening[2].availableAt }, { price: Math.min(...sessionOpening.map(x => x.low)), role: 'SUPPORT', kind: 'ORL', knownAt: sessionOpening[2].availableAt });
    const opening = day[0]?.time === anchor.at ? day.slice(0, 3) : [], orh = Math.max(...opening.map(x => x.high)), orl = Math.min(...opening.map(x => x.low));
    if (anchor.at !== c.sessionOpen && opening.length === 3)
        levels.push({ price: orh, role: 'RESISTANCE', kind: 'EVENING_ORH', knownAt: opening[2].availableAt }, { price: orl, role: 'SUPPORT', kind: 'EVENING_ORL', knownAt: opening[2].availableAt });
    if (c.previousHigh > c.previousLow && c.previousLow > 0)
        levels.push({ price: c.previousHigh, role: 'RESISTANCE', kind: 'PDH', knownAt: c.sessionOpen }, { price: c.previousLow, role: 'SUPPORT', kind: 'PDL', knownAt: c.sessionOpen });
    const recent = today.slice(-FRESH_EFFICIENCY_BARS), path = recent.reduce((sum, x, i) => sum + (i > 0 ? Math.abs(x.close - recent[i - 1].close) : 0), 0);
    const efficiency = recent.length >= 4 && path > 0 ? Math.abs(last(recent).close - recent[0].close) / path : 1;
    const choppy = range || efficiency < FRESH_MIN_EFFICIENCY;
    const directions = [1, -1] as const;
    // 2.0 shadow tag: the nearest unmitigated order block of the trade's side within FRESH_OB_NEAR_ATR of the entry (OB-2.0
    // detector on the closed five-minute bars). Recorded for outcome comparison only; it never refuses or alters a trade.
    let blocks: ReturnType<typeof detectOrderBlocks> | null = null;
    const obTag = (d: number, price: number, atrNow: number) => {
        blocks ??= detectOrderBlocks(b);
        const near = blocks.filter(x => x.type === (d === 1 ? 'BULLISH' : 'BEARISH') && x.state !== 'MITIGATED')
            .map(x => ({ x, dist: price > x.top ? price - x.top : price < x.bottom ? x.bottom - price : 0 }))
            .sort((p, q) => p.dist - q.dist)[0];
        return near && near.dist <= FRESH_OB_NEAR_ATR * atrNow ? { near: true, state: near.x.state, top: near.x.top, bottom: near.x.bottom, distanceAtr: Math.round(near.dist / atrNow * 100) / 100 } : { near: false };
    };
    const ema5 = new Map<number, number>(); { const e = ema(b.map(x => x.close), 20); b.forEach((x, i) => { if (finite(e[i])) ema5.set(x.time, e[i]); }); }
    for (const strategy of FRESH_ALL_STRATEGIES) {
        let emitted = false;
        // Furthest gate reached by this strategy in either direction: the funnel behind "no setup" (diagnostics only).
        let gate = -1, gateName = 'NOT_REACHED';
        const reach = (n: number, name: string) => { if (n > gate) { gate = n; gateName = name; } };
        // The sweep is a reversal and the momentum / event breakouts carry their own regime rules, so only the
        // pullback-style trend strategies (and the flag) stand aside on a choppy tape.
        // 1.12 (6 Nov, owner): a pullback lowers the last hour's efficiency by its own shape (up, back to VWAP, bounce),
        // so in a STRONG 15-minute trend the pullback strategies skip the efficiency test (FRESH_PULLBACK_STRATEGIES); the
        // VWAP-range (chop around VWAP) test still applies to them, and both tests still apply to the ORB retest.
        const pullbackInTrend = strong && FRESH_PULLBACK_STRATEGIES.has(strategy);
        if ((range || (choppy && !pullbackInTrend)) && strategy !== 'NEW_PREVIOUS_SESSION_SWEEP_V1' && strategy !== 'NEW_MOMENTUM_BREAKOUT_V1' && strategy !== 'NEW_EVENT_BREAKOUT_V1' && strategy !== 'NEW_RS_STOCK_V1' && strategy !== 'NEW_INDEX_BREADTH_V1' && strategy !== 'NEW_MCX_FLOW_V1') {
            out.refusals.push({ strategy, code: 'CHOPPY_REGIME', detail: range ? 'VWAP_RANGE' : `EFFICIENCY_${Math.min(9, Math.floor(efficiency * 10))}0PCT` });
            continue;
        }
        for (const d of directions) {
            const directional = d === 1 ? bull : bear, direction: FreshDirection = d === 1 ? 'BULLISH' : 'BEARISH';
            const favorable = (x: number, y: number) => d * (x - y) > 0, vw = (x: FreshBar) => vwapAt(x.time + 300000);
            const confirms = (x: FreshBar, min = .5) => d * (x.close - x.open) > 0 && body(x) >= min;
            const lo = (xs: readonly FreshBar[]) => d === 1 ? Math.min(...xs.map(x => x.low)) : Math.max(...xs.map(x => x.high));
            let stop: number | undefined, origin: number | undefined, profile: 'TARGET' | 'TREND' = 'TARGET', indexTrigger: Record<string, unknown> | undefined;
            if (strategy === 'NEW_ORB_RETEST_V1') reach(0, opening.length === 3 && day.length >= 5 ? 'ORB_NO_TREND' : 'ORB_OUTSIDE_WINDOW');
            if (strategy === 'NEW_ORB_RETEST_V1' && directional && opening.length === 3 && day.length >= 5) {
                const level = d === 1 ? orh : orl, width = orh - orl;
                reach(1, 'ORB_RANGE_WIDTH');
                if (width >= .5 * impulseAtr && width <= 3 * impulseAtr)
                    for (let i = Math.max(3, day.length - 4); i < day.length - 1; i++) {
                        const breakout = day[i], retests = day.slice(i + 1), first = retests.find(x => (d === 1 ? x.low : x.high) >= level - .15 * a && (d === 1 ? x.low : x.high) <= level + .15 * a && favorable(x.close, level) && confirms(x) && closeLocation(x, d) >= .7);
                        reach(2, 'ORB_NO_BREAKOUT');
                        if (!favorable(breakout.close, level + d * .05 * a)) continue;
                        // Late (>= 2 h after the anchor): first break, or a stop-hunt re-break (see FRESH_ORB_REBREAK_MIN_RVOL).
                        let minBreakoutRvol = 1.5;
                        if (breakout.time - anchor.at >= FRESH_ORB_EARLY_WINDOW_MS) {
                            const since = day.slice(3, i), lastBeyond = since.map(x => favorable(x.close, level)).lastIndexOf(true);
                            if (lastBeyond >= 0) {
                                reach(2.5, 'ORB_LATE_LEVEL_ALREADY_BROKEN');
                                if (!since.slice(lastBeyond + 1).some(x => d * (x.close - level) < 0)) continue;
                                reach(2.6, 'ORB_REBREAK_NOT_BEYOND_TRAP');
                                const trap = d === 1 ? Math.max(...since.map(x => x.high)) : Math.min(...since.map(x => x.low));
                                if (!favorable(breakout.close, trap)) continue;
                                minBreakoutRvol = FRESH_ORB_REBREAK_MIN_RVOL;
                            }
                        }
                        reach(3, 'ORB_BREAKOUT_QUALITY');
                        if (!(body(breakout) >= .6 && closeLocation(breakout, d) >= .75 && favorable(breakout.close, vw(breakout)))) continue;
                        reach(4, 'ORB_BREAKOUT_RVOL');
                        if (!(rvol(breakout) >= minBreakoutRvol)) continue;
                        reach(5, 'ORB_NO_RETEST_TRIGGER');
                        if (retests.length <= 3 && first === current && !retests.some(x => d * (x.close - level) < -.15 * a)) {
                            stop = lo(retests) - d * .1 * a;
                            origin = opening[0].time;
                            break;
                        }
                    }
            }
            if (strategy === 'NEW_VWAP_PULLBACK_V1') reach(0, c.now - c.sessionOpen >= FRESH_VWAP_START_MS ? 'VWAP_NO_TREND' : 'VWAP_BEFORE_10_30');
            if (strategy === 'NEW_VWAP_PULLBACK_V1' && directional && c.now - c.sessionOpen >= FRESH_VWAP_START_MS) {
                reach(1, 'VWAP_NO_IMPULSE');
                for (let start = Math.max(3, today.length - 5); start <= today.length - 2; start++) {
                    const impulse = today.slice(start - 3, start), pull = today.slice(start), prev = today[start - 1], initial = today[start];
                    const pivot = levels.filter(x => x.kind === 'CONFIRMED_SWING' && x.knownAt <= prev.time + 300000 && x.role === (d === 1 ? 'RESISTANCE' : 'SUPPORT')).sort((x, y) => y.knownAt - x.knownAt)[0];
                    const behind = levels.filter(x => x.kind === 'CONFIRMED_SWING' && x.knownAt <= initial.time && x.role === (d === 1 ? 'SUPPORT' : 'RESISTANCE')).sort((x, y) => y.knownAt - x.knownAt)[0];
                    const move = d * (prev.close - impulse[0].open), depth = d * (prev.close - lo(pull));
                    // The pullback starts at the first counter close after a three-bar impulse in which at least two of the
                    // three bars close in the trade's direction (5 Nov: was "no counter close at all", which refused 159 of
                    // 4 Nov's VWAP evaluations at VWAP_NO_IMPULSE). Its size (>= 0.75 ATR) and volume (rvol >= 1.2) stay.
                    const cleanImpulse = impulse.filter(x => d * (x.close - x.open) > 0).length >= 2;
                    if (pull.length < 3 || pull.length > 5 || !cleanImpulse || move < .75 * a || d * (initial.close - prev.close) >= 0)
                        continue;
                    reach(2, 'VWAP_NO_SWING_PIVOT');
                    if (!pivot || !behind || !favorable(prev.close, pivot.price))
                        continue;
                    reach(3, 'VWAP_IMPULSE_RVOL');
                    if (!impulse.some(x => rvol(x) >= 1.2))
                        continue;
                    reach(4, 'VWAP_PULLBACK_SHAPE');
                    // At least two pullback bars precede the confirmation bar.
                    const firstTrigger = pull.find((x, j) => j >= 2 && confirms(x) && favorable(x.close, d === 1 ? pull[j - 1].high : pull[j - 1].low) && favorable(x.close, vw(x)));
                    const invalid = pull.some((x, i) => i > 0 && d * (x.close - vw(x)) < 0 && d * (pull[i - 1].close - vw(pull[i - 1])) < 0);
                    if (depth <= .6 * move && favorable(lo(pull), behind.price) && pull.some(x => Math.abs((d === 1 ? x.low : x.high) - vw(x)) <= .2 * a)
                        && median(pull.map(x => x.volume)) < .8 * median(impulse.map(x => x.volume)) && !invalid) reach(5, 'VWAP_NO_TRIGGER');
                    if (depth <= .6 * move && favorable(lo(pull), behind.price) && pull.some(x => Math.abs((d === 1 ? x.low : x.high) - vw(x)) <= .2 * a)
                        && median(pull.map(x => x.volume)) < .8 * median(impulse.map(x => x.volume)) && !invalid && firstTrigger === current && confirms(current) && favorable(current.close, d === 1 ? today[today.length - 2].high : today[today.length - 2].low) && favorable(current.close, vwap)) {
                        stop = lo(pull) - d * .1 * a;
                        origin = impulse[0].time;
                        break;
                    }
                }
            }
            if (strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1') reach(0, c.previousHigh > c.previousLow && c.previousLow > 0 ? (c.now - c.sessionOpen >= 1800000 ? 'SWEEP_AGAINST_TREND' : 'SWEEP_FIRST_30_MIN') : 'SWEEP_NO_PREVIOUS_SESSION');
            if (strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1' && (range || !strong || (d === 1 ? bull : bear)) && c.now - c.sessionOpen >= 1800000 && c.previousHigh > c.previousLow && c.previousLow > 0) {
                const level = d === 1 ? c.previousLow : c.previousHigh;
                // Only the session's first breach of the level qualifies, and its depth is the deepest extreme from that breach through the reclaim.
                const firstBreach = today.findIndex(x => d * (level - (d === 1 ? x.low : x.high)) > 0);
                reach(1, firstBreach < 0 ? 'SWEEP_LEVEL_NOT_BREACHED' : 'SWEEP_BREACH_NOT_RECENT');
                for (let i = Math.max(0, today.length - 5); i < today.length - 1; i++) {
                    if (i !== firstBreach)
                        continue;
                    const sweep = today[i];
                    reach(2, 'SWEEP_NO_RECLAIM');
                    if (today.findIndex((x, j) => j >= i && j <= i + 2 && favorable(x.close, level) && closeLocation(x, d) >= .7) >= 0) reach(3, 'SWEEP_RECLAIM_RVOL');
                    const reclaimIndex = today.findIndex((x, j) => j >= i && j <= i + 2 && favorable(x.close, level) && closeLocation(x, d) >= .7 && rvol(x) >= 1.2);
                    if (reclaimIndex < 0)
                        continue;
                    const extreme = lo(today.slice(i, reclaimIndex + 1)), depth = d * (level - extreme);
                    reach(4, 'SWEEP_DEPTH');
                    if (depth < .05 * a || depth > .75 * a)
                        continue;
                    reach(5, 'SWEEP_NO_TRIGGER');
                    const after = today.slice(reclaimIndex + 1), reclaim = today[reclaimIndex];
                    const trigger = after.find(x => confirms(x) && favorable(x.close, d === 1 ? reclaim.high : reclaim.low));
                    if (after.length >= 1 && after.length <= 2 && trigger === current && favorable(lo(today.slice(i)), extreme - d * 1e-9)) {
                        stop = extreme - d * .1 * a;
                        origin = sweep.time;
                        break;
                    }
                }
            }
            if (strategy === 'NEW_FIRST_OPENING_PULLBACK_V1') reach(0, opening.length === 3 && day.length >= 5 && sinceAnchor <= 7200000 ? 'OPEN_NO_TREND' : 'OPEN_OUTSIDE_WINDOW');
            if (strategy === 'NEW_FIRST_OPENING_PULLBACK_V1' && directional && opening.length === 3 && day.length >= 5 && sinceAnchor <= 7200000) {
                const net = d * (opening[2].close - opening[0].open), refs = anchor.volumeReferences.filter(x => finite(x) && x > 0).slice(-20), vol = opening.reduce((s, x) => s + x.volume, 0);
                const openRange = { ...opening[2], high: orh, low: orl };
                const first = day.findIndex((x, i) => i >= 3 && d * (x.close - day[i - 1].close) < 0);
                reach(1, 'OPEN_IMPULSE_WEAK');
                if (net >= 1.5 * impulseAtr && closeLocation(openRange, d) >= .8 && favorable(opening[2].close, vw(opening[2]))) reach(2, 'OPEN_VOLUME');
                if (net >= 1.5 * impulseAtr && closeLocation(openRange, d) >= .8 && favorable(opening[2].close, vw(opening[2])) && refs.length >= FRESH_MIN_VOLUME_SESSIONS && vol / median(refs) >= 1.5) reach(3, 'OPEN_NO_PULLBACK');
                if (net >= 1.5 * impulseAtr && closeLocation(openRange, d) >= .8 && favorable(opening[2].close, vw(opening[2])) && refs.length >= FRESH_MIN_VOLUME_SESSIONS && vol / median(refs) >= 1.5 && first >= 3) {
                    reach(4, 'OPEN_PULLBACK_SHAPE');
                    // Retracement is measured from the impulse extreme reached before the first counter close, not the third bar's close.
                    const pre = day.slice(0, first), peak = d === 1 ? Math.max(...pre.map(x => x.high)) : Math.min(...pre.map(x => x.low));
                    const span = d * (peak - opening[0].open), pull = day.slice(first), depth = d * (peak - lo(pull));
                    const firstTrigger = pull.find((x, j) => j > 0 && confirms(x) && favorable(x.close, d === 1 ? day[first + j - 1].high : day[first + j - 1].low) && favorable(x.close, vw(x)));
                    if (pull.length <= 4 && depth >= .2 * span && depth <= .5 * span && median(pull.map(x => x.volume)) < .8 * median(opening.map(x => x.volume))) reach(5, 'OPEN_NO_TRIGGER');
                    if (pull.length <= 4 && depth >= .2 * span && depth <= .5 * span && median(pull.map(x => x.volume)) < .8 * median(opening.map(x => x.volume)) && firstTrigger === current) {
                        stop = lo(pull) - d * .1 * a;
                        origin = opening[0].time;
                    }
                }
            }
            // ---- 1.8 MOMENTUM BREAKOUT: a strong close through the session extreme on expanding range and volume ----
            // The breakout is itself the trend signal, so it needs only the last 15-minute close on its side of the 15-minute
            // EMA20, not the full EMA20/EMA50 stack: on a reversal day the stack lags the move by hours (review, 5 Nov).
            const momentumSide = d * (last(h).close - last(e20)) > 0;
            if (strategy === 'NEW_MOMENTUM_BREAKOUT_V1') reach(0, c.now - c.sessionOpen >= 1800000 ? 'MOM_AGAINST_15M_EMA20' : 'MOM_FIRST_30_MIN');
            if (strategy === 'NEW_MOMENTUM_BREAKOUT_V1' && momentumSide && c.now - c.sessionOpen >= 1800000 && today.length >= 7) {
                reach(1, 'MOM_LOW_EFFICIENCY');
                if (efficiency >= FRESH_MOMENTUM_MIN_EFFICIENCY) {
                    const prior = today.slice(0, -1), extreme = d === 1 ? Math.max(...prior.map(x => x.high)) : Math.min(...prior.map(x => x.low));
                    reach(2, 'MOM_NO_NEW_EXTREME');
                    if (favorable(current.close, extreme + d * .05 * a)) {
                        // Not a chase: at most one earlier bar in the last half hour already closed at a new session extreme.
                        let chased = 0;
                        for (let j = Math.max(1, today.length - 7); j < today.length - 1; j++) {
                            const before = today.slice(0, j), ext = d === 1 ? Math.max(...before.map(x => x.high)) : Math.min(...before.map(x => x.low));
                            if (favorable(today[j].close, ext)) chased++;
                        }
                        reach(3, 'MOM_BAR_QUALITY');
                        if (current.high - current.low >= FRESH_MOMENTUM_BAR_MIN_RANGE_ATR * a && body(current) >= FRESH_MOMENTUM_BAR_MIN_BODY && closeLocation(current, d) >= FRESH_MOMENTUM_BAR_MIN_CLOSE_LOCATION) {
                            reach(4, 'MOM_VOLUME');
                            if (rvol(current) >= FRESH_MOMENTUM_MIN_RVOL) {
                                reach(5, 'MOM_EXTENDED_OR_CHASED');
                                if (favorable(current.close, vwap) && Math.abs(current.close - vwap) <= FRESH_MOMENTUM_MAX_VWAP_ATR * a && chased <= 1) {
                                    reach(6, 'MOM_RISK_TOO_WIDE');
                                    // Beyond the breakout bar itself: if price comes back through it, the breakout failed.
                                    const s = (d === 1 ? current.low : current.high) - d * .1 * a;
                                    if (d * (current.close - s) > 0 && d * (current.close - s) <= FRESH_TREND_MAX_RISK_ATR * a) {
                                        stop = s;
                                        origin = current.time;
                                        profile = 'TREND';
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // ---- 1.8 TREND FLAG: a tight pause after a strong pole, entered on the break in the trend's direction ----
            if (strategy === 'NEW_TREND_FLAG_V1') reach(0, c.now - c.sessionOpen >= 2700000 ? 'FLAG_NO_STRONG_TREND' : 'FLAG_FIRST_45_MIN');
            if (strategy === 'NEW_TREND_FLAG_V1' && directional && strong && c.now - c.sessionOpen >= 2700000 && today.length >= 9) {
                reach(1, 'FLAG_NO_POLE');
                for (let len = 3; len <= 8 && stop == null; len++) {
                    const end = today.length - 2 - len; // last bar of the pole; the flag is the len bars after it, then the current bar
                    if (end < 2) break;
                    const flag = today.slice(end + 1, today.length - 1);
                    for (let k = 3; k <= 6 && stop == null; k++) {
                        const start = end - k + 1;
                        if (start < 0) break;
                        const pole = today.slice(start, end + 1), move = d * (pole[pole.length - 1].close - pole[0].open);
                        const top = d === 1 ? Math.max(...pole.map(x => x.high)) : Math.min(...pole.map(x => x.low));
                        if (move < 2 * a || pole.filter(x => d * (x.close - x.open) > 0).length < Math.ceil(.6 * k)) continue;
                        reach(2, 'FLAG_SHAPE');
                        const fHi = Math.max(...flag.map(x => x.high)), fLo = Math.min(...flag.map(x => x.low));
                        const flagEdge = d === 1 ? fHi : fLo, flagFloor = d === 1 ? fLo : fHi;
                        if (fHi - fLo > Math.min(.5 * move, 1.5 * a) || d * (top - flagFloor) > .5 * move || d * (flagEdge - top) > .1 * a || flag.some(x => !favorable(x.close, vw(x)))) continue;
                        reach(3, 'FLAG_VOLUME');
                        if (!(median(flag.map(x => x.volume)) < median(pole.map(x => x.volume)))) continue;
                        reach(4, 'FLAG_NO_TRIGGER');
                        if (favorable(current.close, flagEdge + d * .05 * a) && body(current) >= .5 && closeLocation(current, d) >= .7 && rvol(current) >= 1.2 && favorable(current.close, vwap)) {
                            reach(5, 'FLAG_RISK_TOO_WIDE');
                            const s = flagFloor - d * .1 * a;
                            if (d * (current.close - s) > 0 && d * (current.close - s) <= FRESH_TREND_MAX_RISK_ATR * a) {
                                stop = s;
                                origin = pole[0].time;
                                profile = 'TREND';
                            }
                        }
                    }
                }
            }
            // ---- 1.8 EVENT BREAKOUT: the first close out of the 15-minute range after a scheduled release ----
            if (strategy === 'NEW_EVENT_BREAKOUT_V1') {
                const release = (c.recentReleases ?? []).filter(t => finite(t) && t >= c.sessionOpen && c.now - t >= FRESH_EVENT_RANGE_MS && c.now - t <= FRESH_EVENT_WINDOW_MS).sort((x, y) => y - x)[0];
                reach(0, release == null ? 'EVENT_NO_RECENT_RELEASE' : 'EVENT_RANGE_INCOMPLETE');
                if (release != null) {
                    const rs = release - (((release - c.sessionOpen) % 300000) + 300000) % 300000, range = today.filter(x => x.time >= rs && x.time < rs + FRESH_EVENT_RANGE_MS);
                    if (range.length === 3 && range.every((x, i) => x.time === rs + i * 300000)) {
                        const rHi = Math.max(...range.map(x => x.high)), rLo = Math.min(...range.map(x => x.low)), width = rHi - rLo;
                        reach(1, 'EVENT_RANGE_WIDTH');
                        if (width >= .5 * a && width <= 4 * a) {
                            const after = today.filter(x => x.time >= rs + FRESH_EVENT_RANGE_MS), edge = d === 1 ? rHi : rLo;
                            const firstOut = after.find(x => x.close > rHi + .05 * a || x.close < rLo - .05 * a);
                            reach(2, 'EVENT_NO_BREAKOUT');
                            if (firstOut === current && favorable(current.close, edge + d * .05 * a)) {
                                reach(3, 'EVENT_BAR_QUALITY');
                                if (body(current) >= .5 && closeLocation(current, d) >= .7 && rvol(current) >= 1.5 && favorable(current.close, vwap)) {
                                    reach(4, 'EVENT_RISK_TOO_WIDE');
                                    const far = (d === 1 ? rLo : rHi) - d * .1 * a, mid = (rHi + rLo) / 2 - d * .1 * a;
                                    const fits = (x: number) => d * (current.close - x) > 0 && d * (current.close - x) <= FRESH_TREND_MAX_RISK_ATR * a;
                                    const s = fits(far) ? far : fits(mid) ? mid : null;
                                    if (s != null) {
                                        stop = s;
                                        origin = release;
                                        profile = 'TREND';
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // ---- 2.0 STOCK IN PLAY (relative strength): a stock leading / lagging NIFTY with aligned futures OI, entered on a
            // hold of VWAP / EMA20 or a break out of a tight base. It reads the stock's own chart, not the index regime, so
            // it is exempt from the choppy filter (a choppy index day is exactly when a stock in play matters).
            if (strategy === 'NEW_RS_STOCK_V1') {
                const intel = c.stockIntel;
                const fresh = intel != null && finite(intel.at) && intel.at <= c.now && c.now - intel.at <= FRESH_INTEL_MAX_AGE_MS;
                reach(0, intel === undefined ? 'RS_NOT_A_STOCK' : !fresh ? 'RS_INTEL_STALE' : 'RS_BEFORE_10_00');
                if (fresh && c.now - c.sessionOpen >= FRESH_RS_START_MS) {
                    reach(1, 'RS_WEAK');
                    if (d * intel!.relativeStrength >= FRESH_RS_MIN_PCT) {
                        reach(2, 'RS_OI_NOT_ALIGNED');
                        if ((d === 1 ? RS_BULLISH_OI : RS_BEARISH_OI).has(intel!.oiInterpretation)) {
                            reach(3, 'RS_SECTOR_AGAINST');
                            if (intel!.sectorRelativeStrength == null || d * intel!.sectorRelativeStrength >= -FRESH_RS_SECTOR_TOLERANCE_PCT) {
                                reach(4, 'RS_LIQUIDITY_OR_IV');
                                if (intel!.atmSpreadPct != null && intel!.atmSpreadPct <= FRESH_RS_MAX_SPREAD_PCT && (intel!.ivRank == null || intel!.ivRank < FRESH_RS_MAX_IV_RANK)) {
                                    reach(5, 'RS_15M_AGAINST');
                                    if (!(d === 1 ? bear : bull)) {
                                        reach(6, 'RS_NOT_HOLDING_VWAP');
                                        const last6 = today.slice(-6);
                                        if (last6.length === 6 && last6.filter(x => d * (x.close - vw(x)) < 0).length <= FRESH_VWAP_MISSES && favorable(current.close, vwap)) {
                                            reach(7, 'RS_NO_TRIGGER');
                                            const prior = today[today.length - 2];
                                            // A: a pullback in the last three bars touched VWAP or the 5-minute EMA20 (within 0.15 ATR, close not
                                            // more than 0.15 ATR through it), and this bar resumes: closes past the prior bar, in its outer 35%,
                                            // with relative volume >= 1.2.
                                            const touches = (x: FreshBar) => [vw(x), ema5.get(x.time)].some(L => L != null && finite(L) && d * ((d === 1 ? x.low : x.high) - L) <= FRESH_RS_TOUCH_ATR * a && d * (x.close - L) >= -FRESH_RS_TOUCH_ATR * a);
                                            const window3 = today.slice(-1 - FRESH_HOLD_WINDOW_BARS, -1), touchAt = window3.map(touches).lastIndexOf(true);
                                            let s: number | null = null, o: number | null = null;
                                            if (prior && touchAt >= 0 && favorable(current.close, d === 1 ? prior.high : prior.low) && confirms(current, .4) && closeLocation(current, d) >= FRESH_HOLD_CLOSE_LOCATION && rvol(current) >= FRESH_HOLD_RVOL) {
                                                const pullback = [...window3.slice(touchAt), current];
                                                s = lo(pullback) - d * .1 * a; o = window3[touchAt].time;
                                            }
                                            // B: a 3-6 bar base no wider than 0.6 ATR, and this bar closes out of it with rvol >= 1.5.
                                            if (s == null)
                                                for (const n of [6, 5, 4, 3]) {
                                                    const base = today.slice(-1 - n, -1);
                                                    if (base.length < n) continue;
                                                    const hi = Math.max(...base.map(x => x.high)), low = Math.min(...base.map(x => x.low));
                                                    if (hi - low > FRESH_RS_BASE_MAX_ATR * a) continue;
                                                    if (d * (current.close - (d === 1 ? hi : low)) > .05 * a && body(current) >= FRESH_BASE_BODY && rvol(current) >= FRESH_BASE_RVOL) {
                                                        s = (d === 1 ? low : hi) - d * .1 * a; o = base[0].time;
                                                        break;
                                                    }
                                                }
                                            // C (2.1): continuation - this bar closes beyond the last six bars' extreme with a real body and rvol >= 1.2.
                                            if (s == null && prior) {
                                                const before6 = today.slice(-1 - FRESH_CONTINUATION_BARS, -1);
                                                const edge6 = d === 1 ? Math.max(...before6.map(x => x.high)) : Math.min(...before6.map(x => x.low));
                                                if (before6.length === FRESH_CONTINUATION_BARS && d * (current.close - edge6) > .05 * a && confirms(current, .5) && rvol(current) >= FRESH_CONTINUATION_RVOL) {
                                                    s = lo([prior, current]) - d * .1 * a; o = prior.time;
                                                }
                                            }
                                            if (s != null && o != null) {
                                                reach(8, 'RS_RISK_TOO_WIDE');
                                                if (d * (current.close - s) > 0 && d * (current.close - s) <= FRESH_RS_MAX_RISK_ATR * a) {
                                                    stop = s;
                                                    origin = o;
                                                    profile = 'TREND';
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // ---- 2.0 INDEX BREADTH TREND: an index move its heavyweights agree with (>= 70% of the weight on the trade's
            // side of their own VWAP), futures OI not against it, room to the next OI wall, entered on a VWAP / EMA20 hold, a
            // tight-base break, or an OI-wall break (the wall's writers covering). Breadth is its regime: it is exempt from
            // the choppy filter, and a split tape (breadth between 30% and 70%) is refused instead.
            if (strategy === 'NEW_INDEX_BREADTH_V1') {
                const ix = c.indexIntel;
                const fresh = ix != null && finite(ix.at) && ix.at <= c.now && c.now - ix.at <= FRESH_INTEL_MAX_AGE_MS;
                reach(0, ix === undefined ? 'IDX_NOT_AN_INDEX' : !fresh ? 'IDX_INTEL_STALE' : 'IDX_BEFORE_10_00');
                if (fresh && c.now - c.sessionOpen >= FRESH_RS_START_MS) {
                    reach(1, 'IDX_BREADTH_UNAVAILABLE');
                    // 2.1: breadth missing (heavyweight data short, 95 refusals on 11 Nov) no longer ends it: the index's own
                    // 15-minute trend must then be WITH the trade (stricter than the usual "not against").
                    const breadthKnown = ix!.breadth != null && finite(ix!.breadth);
                    if (breadthKnown || (d === 1 ? bull : bear)) {
                        reach(2, 'IDX_BREADTH_SPLIT');
                        if (!breadthKnown || (d === 1 ? ix!.breadth! >= FRESH_IDX_BREADTH_BULL : ix!.breadth! <= FRESH_IDX_BREADTH_BEAR)) {
                            reach(3, 'IDX_FUTURES_OI_AGAINST');
                            if (ix!.futuresOi !== (d === 1 ? 'SHORT_BUILDUP' : 'LONG_BUILDUP')) {
                                reach(4, 'IDX_NOT_HOLDING_VWAP');
                                const last6 = today.slice(-6);
                                if (last6.length === 6 && last6.filter(x => d * (x.close - vw(x)) < 0).length <= FRESH_VWAP_MISSES && favorable(current.close, vwap)) {
                                    reach(5, 'IDX_NO_TRIGGER');
                                    const nowOi = ix!.oiNow && finite(ix!.oiNow.at) && ix!.oiNow.at <= c.now && c.now - ix!.oiNow.at <= FRESH_IDX_OI_MAX_AGE_MS ? ix!.oiNow : null;
                                    const before = nowOi?.expiry && ix!.oiBefore?.expiry === nowOi.expiry && nowOi.at - ix!.oiBefore.at >= FRESH_IDX_OI_LOOKBACK_MS[0] && nowOi.at - ix!.oiBefore.at <= FRESH_IDX_OI_LOOKBACK_MS[1] ? ix!.oiBefore : null;
                                    const side = (sample: FreshOiSample, call: boolean) => sample.strikes.flatMap(x => {
                                        const oi = call ? x.callOi : x.putOi;
                                        return finite(x.strike) && finite(oi) && oi >= 0 ? [{ strike: x.strike, oi }] : [];
                                    });
                                    const walls = (sample: FreshOiSample, call: boolean) => { const xs = side(sample, call), max = Math.max(0, ...xs.map(x => x.oi)); return max > 0 ? xs.filter(x => x.oi >= FRESH_IDX_WALL_SHARE * max) : []; };
                                    const prior = today[today.length - 2];
                                    const touches = (x: FreshBar) => [vw(x), ema5.get(x.time)].some(L => L != null && finite(L) && d * ((d === 1 ? x.low : x.high) - L) <= FRESH_RS_TOUCH_ATR * a && d * (x.close - L) >= -FRESH_RS_TOUCH_ATR * a);
                                    let s: number | null = null, o: number | null = null, maxRisk = FRESH_RS_MAX_RISK_ATR, trigger = '';
                                    // C: the 5-minute close crosses a wall (as it stood ~15 min ago) whose own OI has dropped >= 5% while the
                                    // other side's OI at that strike grew: writers covering, the move that pays an option buyer fastest.
                                    if (before && prior && rvol(current) >= 1.5 && confirms(current, .5))
                                        for (const w of walls(before, d === 1)) {
                                            const nowW = nowOi!.strikes.find(x => x.strike === w.strike), wasW = before.strikes.find(x => x.strike === w.strike);
                                            if (!nowW || !wasW) continue;
                                            const own = d === 1 ? [nowW.callOi, wasW.callOi] : [nowW.putOi, wasW.putOi], other = d === 1 ? [nowW.putOi, wasW.putOi] : [nowW.callOi, wasW.callOi];
                                            if (!own.every(finite) || !other.every(finite) || own.some(x => x < 0) || other.some(x => x < 0)) continue;
                                            if (d * (prior.close - w.strike) <= 0 && d * (current.close - w.strike) > .05 * a && own[0] <= (1 - FRESH_IDX_WALL_UNWIND) * own[1] && other[0] > other[1]) {
                                                s = lo([prior, current]) - d * .1 * a; o = prior.time; maxRisk = FRESH_IDX_WALL_BREAK_MAX_RISK_ATR; trigger = `WALL_BREAK_${w.strike}`;
                                                break;
                                            }
                                        }
                                    // A: VWAP / EMA20 hold (as NEW_RS_STOCK_V1).
                                    const window3 = today.slice(-1 - FRESH_HOLD_WINDOW_BARS, -1), touchAt = window3.map(touches).lastIndexOf(true);
                                    if (s == null && prior && touchAt >= 0 && favorable(current.close, d === 1 ? prior.high : prior.low) && confirms(current, .4) && closeLocation(current, d) >= FRESH_HOLD_CLOSE_LOCATION && rvol(current) >= FRESH_HOLD_RVOL) {
                                        s = lo([...window3.slice(touchAt), current]) - d * .1 * a; o = window3[touchAt].time; trigger = 'VWAP_HOLD';
                                    }
                                    // B: a 3-6 bar base no wider than 0.6 ATR, then a close out of it on rvol >= 1.5.
                                    if (s == null)
                                        for (const n of [6, 5, 4, 3]) {
                                            const base = today.slice(-1 - n, -1);
                                            if (base.length < n) continue;
                                            const hi = Math.max(...base.map(x => x.high)), low = Math.min(...base.map(x => x.low));
                                            if (hi - low > FRESH_RS_BASE_MAX_ATR * a) continue;
                                            if (d * (current.close - (d === 1 ? hi : low)) > .05 * a && body(current) >= FRESH_BASE_BODY && rvol(current) >= FRESH_BASE_RVOL) {
                                                s = (d === 1 ? low : hi) - d * .1 * a; o = base[0].time; trigger = 'BASE_BREAK';
                                                break;
                                            }
                                        }
                                    // C (2.1): continuation - this bar closes beyond the last six bars' extreme with a real body and rvol >= 1.2.
                                    if (s == null && prior) {
                                        const before6 = today.slice(-1 - FRESH_CONTINUATION_BARS, -1);
                                        const edge6 = d === 1 ? Math.max(...before6.map(x => x.high)) : Math.min(...before6.map(x => x.low));
                                        if (before6.length === FRESH_CONTINUATION_BARS && d * (current.close - edge6) > .05 * a && confirms(current, .5) && rvol(current) >= FRESH_CONTINUATION_RVOL) {
                                            s = lo([prior, current]) - d * .1 * a; o = prior.time; trigger = 'CONTINUATION';
                                        }
                                    }
                                    if (s != null && o != null) {
                                        reach(6, 'IDX_RISK_TOO_WIDE');
                                        const risk = d * (current.close - s);
                                        if (risk > 0 && risk <= maxRisk * a) {
                                            // Location: the next OI wall in the trade's direction (now) must be >= 1.5R away.
                                            // 2.1: 1.0R of room; a missing chain sample skips the check (recorded) instead of refusing.
                                            reach(7, 'IDX_LOCATION_NO_ROOM');
                                            const next = nowOi ? walls(nowOi, d === 1).filter(x => d * (x.strike - current.close) > 0).sort((x, y) => d * (x.strike - y.strike))[0] : undefined;
                                            if (!next || d * (next.strike - current.close) >= FRESH_IDX_MIN_ROOM_R * risk) {
                                                // Order-flow veto (owner, 7 Nov): no entry when the decision bar's flow is clearly against the
                                                // trade. Unavailable / neutral flow does not veto (SENSEX / BANKEX read NIFTY / BANKNIFTY's, proxy).
                                                reach(8, 'IDX_FLOW_OPPOSED');
                                                const flow = freshOrderFlowEvidence(c.orderFlow, direction, current.time, o);
                                                if (flow.alignment !== 'OPPOSED') {
                                                    stop = s;
                                                    origin = o;
                                                    profile = 'TREND';
                                                    indexTrigger = { trigger, breadth: ix!.breadth, futuresOi: ix!.futuresOi, nextWall: nowOi ? next?.strike ?? null : 'OI_UNAVAILABLE', flow: flow.alignment };
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // ---- 2.0 MCX ORDER FLOW: a commodity trend that the (inferred) aggressive volume confirms. The last three five-minute
            // flow bars' delta must lean the trade's way (>= 15% of classified volume) and the decision bar's must not oppose it;
            // entries are a VWAP / EMA20 hold whose resumption bar is itself bought / sold (delta >= 15%), or a tight-base break
            // on delta >= 20% that the last closed 15-minute footprint does not contradict. No flow, no trade: never a guess.
            if (strategy === 'NEW_MCX_FLOW_V1') {
                reach(0, !c.commodity ? 'MCX_NOT_A_COMMODITY' : 'MCX_BEFORE_START');
                if (c.commodity && c.now - c.sessionOpen >= FRESH_RS_START_MS) {
                    reach(1, 'MCX_FLOW_UNAVAILABLE');
                    const flowBars = c.orderFlow?.bars ?? [], fb = (t: number) => flowBars.find(x => x.time === t);
                    const recent = today.slice(-FRESH_MCX_FLOW_BARS).map(x => fb(x.time)), cur = fb(current.time);
                    const buy = recent.reduce((n, x) => n + (x?.buy ?? 0), 0), sell = recent.reduce((n, x) => n + (x?.sell ?? 0), 0), un = recent.reduce((n, x) => n + (x?.unclassified ?? 0), 0), unrec = recent.reduce((n, x) => n + (x?.unreconciled ?? 0), 0), trades = recent.reduce((n, x) => n + (x?.trades ?? 0), 0);
                    // Sampled order flow (owner, 9 Nov): classified share of the observed volume, and enough coverage.
                    const coverage = flowCoverage(buy + sell + un, unrec);
                    const delta = (x: { buy: number; sell: number } | undefined) => x && x.buy + x.sell > 0 ? d * (x.buy - x.sell) / (x.buy + x.sell) : null;
                    if (cur && recent.every(x => x != null) && buy + sell > 0 && (buy + sell) / (buy + sell + un) >= .5 && coverage != null && coverage >= FLOW_MIN_SAMPLED_COVERAGE && trades >= 3 * 5) {
                        reach(2, 'MCX_FLOW_NOT_ALIGNED');
                        const setupDelta = d * (buy - sell) / (buy + sell), barDelta = delta(cur)!;
                        if (setupDelta >= FRESH_MCX_FLOW_MIN_DELTA && barDelta > -FRESH_MCX_FLOW_MIN_DELTA) {
                            reach(3, 'MCX_15M_AGAINST');
                            if (!(d === 1 ? bear : bull)) {
                                reach(4, 'MCX_NOT_HOLDING_VWAP');
                                const last6 = today.slice(-6);
                                if (last6.length === 6 && last6.filter(x => d * (x.close - vw(x)) < 0).length <= FRESH_VWAP_MISSES && favorable(current.close, vwap)) {
                                    reach(5, 'MCX_NO_TRIGGER');
                                    const prior = today[today.length - 2];
                                    const touches = (x: FreshBar) => [vw(x), ema5.get(x.time)].some(L => L != null && finite(L) && d * ((d === 1 ? x.low : x.high) - L) <= FRESH_RS_TOUCH_ATR * a && d * (x.close - L) >= -FRESH_RS_TOUCH_ATR * a);
                                    const window3 = today.slice(-1 - FRESH_HOLD_WINDOW_BARS, -1), touchAt = window3.map(touches).lastIndexOf(true);
                                    let s: number | null = null, o: number | null = null, trigger = '';
                                    if (prior && touchAt >= 0 && barDelta >= FRESH_MCX_TRIGGER_DELTA && favorable(current.close, d === 1 ? prior.high : prior.low) && confirms(current, .4) && closeLocation(current, d) >= FRESH_HOLD_CLOSE_LOCATION && rvol(current) >= FRESH_HOLD_RVOL) {
                                        s = lo([...window3.slice(touchAt), current]) - d * .1 * a; o = window3[touchAt].time; trigger = 'FLOW_HOLD';
                                    }
                                    const fp = c.footprint15 && finite(c.footprint15.barTime) && c.footprint15.barTime + 900000 <= c.now ? c.footprint15 : null;
                                    const fpAgrees = !fp || ((fp.deltaPct == null || d * fp.deltaPct >= 0) && (d === 1 ? fp.buyImbalances >= fp.sellImbalances : fp.sellImbalances >= fp.buyImbalances));
                                    if (s == null && barDelta >= FRESH_MCX_BREAK_DELTA && fpAgrees)
                                        for (const n of [6, 5, 4, 3]) {
                                            const base = today.slice(-1 - n, -1);
                                            if (base.length < n) continue;
                                            const hi = Math.max(...base.map(x => x.high)), low = Math.min(...base.map(x => x.low));
                                            if (hi - low > FRESH_RS_BASE_MAX_ATR * a) continue;
                                            if (d * (current.close - (d === 1 ? hi : low)) > .05 * a && body(current) >= FRESH_BASE_BODY && rvol(current) >= FRESH_BASE_RVOL) {
                                                s = (d === 1 ? low : hi) - d * .1 * a; o = base[0].time; trigger = 'FLOW_BREAK';
                                                break;
                                            }
                                        }
                                    // C (2.1): continuation - this bar closes beyond the last six bars' extreme with a real body and rvol >= 1.2.
                                    if (s == null && prior && barDelta >= FRESH_MCX_BREAK_DELTA && fpAgrees) {
                                        const before6 = today.slice(-1 - FRESH_CONTINUATION_BARS, -1);
                                        const edge6 = d === 1 ? Math.max(...before6.map(x => x.high)) : Math.min(...before6.map(x => x.low));
                                        if (before6.length === FRESH_CONTINUATION_BARS && d * (current.close - edge6) > .05 * a && confirms(current, .5) && rvol(current) >= FRESH_CONTINUATION_RVOL) {
                                            s = lo([prior, current]) - d * .1 * a; o = prior.time; trigger = 'FLOW_CONTINUATION';
                                        }
                                    }
                                    if (s != null && o != null) {
                                        reach(6, 'MCX_RISK_TOO_WIDE');
                                        if (d * (current.close - s) > 0 && d * (current.close - s) <= FRESH_RS_MAX_RISK_ATR * a) {
                                            stop = s;
                                            origin = o;
                                            profile = 'TREND';
                                            indexTrigger = { trigger, setupDelta: Math.round(setupDelta * 1000) / 1000, barDelta: Math.round(barDelta * 1000) / 1000, footprint: fp ? { deltaPct: fp.deltaPct, buyImbalances: fp.buyImbalances, sellImbalances: fp.sellImbalances } : 'UNAVAILABLE' };
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (stop == null || origin == null || !favorable(current.close, stop))
                continue;
            if (profile === 'TREND') {
                // Trend entries ride the move: no fixed objective, only a sanity check that a major level is not right in
                // front of the entry. The nominal target exists for the admission payoff check; the exit trails.
                const risk = Math.abs(current.close - stop);
                const wall = levels.find(x => x.kind !== 'CONFIRMED_SWING' && x.role === (d === 1 ? 'RESISTANCE' : 'SUPPORT') && favorable(x.price, current.close) && d * (x.price - current.close) < FRESH_TREND_MIN_ROOM_R * risk);
                if (wall) {
                    out.refusals.push({ strategy, code: 'TARGET_TOO_CLOSE', detail: `${wall.kind}_WITHIN_0_5R` });
                    continue;
                }
                const targetPrice = current.close + d * FRESH_TREND_NOMINAL_R * risk, parentId = `${c.instrument}:${c.session}:${direction}:${origin}`;
                out.candidates.push({ id: `${FRESH_PACK_VERSION}:${c.sourceEpoch}:${parentId}:${strategy}:${current.time}`, parentId, version: FRESH_PACK_VERSION, strategy, direction, instrument: c.instrument, sourceEpoch: c.sourceEpoch, session: c.session, at: decisionAt, referenceEntry: current.close, stop, target: targetPrice, atr: a, origin, expiresAt: Math.min(decisionAt + FRESH_ENTRY_WINDOW_MS, c.sessionClose - 3600000), exitProfile: 'TREND', trailAtr: FRESH_TREND_TRAIL_ATR, evidence: { ...(c.eventEvidence ? { eventCalendar: c.eventEvidence } : {}), ...(c.stockIntel ? { stockIntel: c.stockIntel } : {}), ...(indexTrigger ? { [strategy === 'NEW_MCX_FLOW_V1' ? 'mcxFlow' : 'index']: indexTrigger } : {}), ...(strategy === 'NEW_RS_STOCK_V1' || strategy === 'NEW_INDEX_BREADTH_V1' || strategy === 'NEW_MCX_FLOW_V1' ? { orderBlock: obTag(d, current.close, a) } : {}), orderFlow: freshOrderFlowEvidence(c.orderFlow, direction, current.time, origin), rvol: finite(rvol(current)) ? rvol(current) : 'UNAVAILABLE', volumeShape: c.volumeShape ?? 'OWN', vwap, reference: 'BAR_VWAP_PROXY', efficiency, targetKind: 'TRAILING_STOP', targetR: FRESH_TREND_NOMINAL_R, trailAtr: FRESH_TREND_TRAIL_ATR } });
                emitted = true;
                continue;
            }
            const ahead = levels.filter(x => x.role === (d === 1 ? 'RESISTANCE' : 'SUPPORT') && favorable(x.price, current.close));
            if (strategy === 'NEW_PREVIOUS_SESSION_SWEEP_V1') {
                const price = (c.previousHigh + c.previousLow) / 2;
                if (favorable(price, current.close))
                    ahead.push({ price, role: d === 1 ? 'RESISTANCE' : 'SUPPORT', kind: 'PREVIOUS_MID', knownAt: c.sessionOpen });
            }
            ahead.sort((x, y) => d * (x.price - y.price));
            if (!ahead.length) {
                out.refusals.push({ strategy, code: 'NO_TARGET' });
                continue;
            }
            // 1.5: the target is the first level that pays at least FRESH_MIN_TARGET_R × the underlying risk. A minor
            // confirmed swing closer than that is passed over; a major level (opening range, previous day, external
            // reference) closer than that blocks the trade, because price must break it first. A target further than
            // FRESH_MAX_TARGET_ATR × ATR is not reachable inside the one-hour hold and is refused too.
            const risk = Math.abs(current.close - stop);
            const reward = (x: FreshLevel) => d * (x.price - current.close);
            const blocking = ahead.find(x => x.kind !== 'CONFIRMED_SWING' && reward(x) < FRESH_MIN_TARGET_R * risk);
            const chosen = ahead.find(x => reward(x) >= FRESH_MIN_TARGET_R * risk);
            if (blocking || !chosen) {
                out.refusals.push({ strategy, code: 'TARGET_TOO_CLOSE' });
                continue;
            }
            // A level further than FRESH_MAX_TARGET_ATR × ATR is not reachable inside the one-hour hold: aim at the cap
            // instead, as long as the cap itself still pays the minimum reward.
            const cap = FRESH_MAX_TARGET_ATR * a;
            const capped = reward(chosen) > cap;
            if (capped && cap < FRESH_MIN_TARGET_R * risk) {
                out.refusals.push({ strategy, code: 'TARGET_OUT_OF_REACH' });
                continue;
            }
            const targetPrice = capped ? current.close + d * cap : chosen.price, targetKind = capped ? 'ATR_CAP' : chosen.kind;
            const parentId = `${c.instrument}:${c.session}:${direction}:${origin}`;
            out.candidates.push({ id: `${FRESH_PACK_VERSION}:${c.sourceEpoch}:${parentId}:${strategy}:${current.time}`, parentId, version: FRESH_PACK_VERSION, strategy, direction, instrument: c.instrument, sourceEpoch: c.sourceEpoch, session: c.session, at: decisionAt, referenceEntry: current.close, stop, target: targetPrice, atr: a, origin, expiresAt: Math.min(decisionAt + FRESH_ENTRY_WINDOW_MS, c.sessionClose - 3600000), evidence: { ...(c.eventEvidence?{eventCalendar:c.eventEvidence}:{}), orderFlow: freshOrderFlowEvidence(c.orderFlow, direction, current.time, origin), rvol: finite(rvol(current)) ? rvol(current) : 'UNAVAILABLE', volumeShape: c.volumeShape ?? 'OWN', vwap, reference: 'BAR_VWAP_PROXY', efficiency, targetKind, targetR: d * (targetPrice - current.close) / risk } });
            emitted = true;
        }
        if (!emitted && !out.refusals.some(x => x.strategy === strategy))
            out.refusals.push({ strategy, code: 'SETUP_CONDITIONS_NOT_MET', detail: gateName });
    }
    return out;
}

// ---- MCX flow diagnostic (owner, 9 Nov): the numbers behind NEW_MCX_FLOW_V1's flow checks, for the log only. ----
// Same inputs and windows as the strategy (closed five-minute bars of today's session, the last FRESH_MCX_FLOW_BARS
// flow bars, the decision bar's own flow); it decides nothing and never feeds a candidate.
export interface FreshMcxFlowDiagnostic {
    trend: 'BULL' | 'BEAR' | 'NONE';
    lastClose: number | null;
    sessionChangePct: number | null;
    vwapDistanceAtr: number | null;
    /** (buy − sell) ÷ (buy + sell) over the last three flow bars, in %, + = buying. */
    setupDeltaPct: number | null;
    /** The decision (current) bar's own delta in %. */
    barDeltaPct: number | null;
    classifiedSharePct: number | null;
    coveragePct: number | null;
    trades: number;
    /** The flow check for a trade in the trend's direction (no trend: the flow's side): 'PASS' or the first failing reason. */
    flowCheck: string;
}
export function freshMcxFlowDiagnostic(c: FreshContext): FreshMcxFlowDiagnostic {
    const pct = (x: number) => Math.round(x * 1000) / 10;
    const b = closed(c.bars5, 300000, c.now), h = closed(c.bars15, 900000, c.now), m = closed(c.bars1, 60000, c.now);
    const today = b.filter(x => x.time >= c.sessionOpen), minute = m.filter(x => x.time >= c.sessionOpen), current = today.length ? last(today) : null;
    let trend: FreshMcxFlowDiagnostic['trend'] = 'NONE';
    if (h.length >= 50) {
        const e20 = ema(h.map(x => x.close), 20), e50 = ema(h.map(x => x.close), 50);
        trend = last(h).close > last(e20) && last(e20) > last(e50) ? 'BULL' : last(h).close < last(e20) && last(e20) < last(e50) ? 'BEAR' : 'NONE';
    }
    const v = minute.reduce((s, x) => s + x.volume, 0), vwap = v > 0 ? minute.reduce((s, x) => s + (x.high + x.low + x.close) / 3 * x.volume, 0) / v : NaN;
    const a = b.length >= 15 ? last(atr(b.map(x => x.high), b.map(x => x.low), b.map(x => x.close), 14)) : NaN;
    const flowBars = c.orderFlow?.bars ?? [], fb = (t: number) => flowBars.find(x => x.time === t);
    const recent = today.slice(-FRESH_MCX_FLOW_BARS).map(x => fb(x.time)), cur = current ? fb(current.time) : undefined;
    const buy = recent.reduce((n, x) => n + (x?.buy ?? 0), 0), sell = recent.reduce((n, x) => n + (x?.sell ?? 0), 0), un = recent.reduce((n, x) => n + (x?.unclassified ?? 0), 0);
    const unrec = recent.reduce((n, x) => n + (x?.unreconciled ?? 0), 0), trades = recent.reduce((n, x) => n + (x?.trades ?? 0), 0);
    const coverage = flowCoverage(buy + sell + un, unrec), share = buy + sell + un > 0 ? (buy + sell) / (buy + sell + un) : null;
    const setup = buy + sell > 0 ? (buy - sell) / (buy + sell) : null, bar = cur && cur.buy + cur.sell > 0 ? (cur.buy - cur.sell) / (cur.buy + cur.sell) : null;
    // The strategy tries both sides unless the 15-minute trend opposes one; without a trend, the flow's own side.
    const d = trend === 'BULL' ? 1 : trend === 'BEAR' ? -1 : Math.sign(setup ?? 0);
    const flowCheck = !c.orderFlow ? 'NO_FLOW_SOURCE' : !cur || recent.some(x => x == null) ? 'FLOW_BARS_MISSING' : !(buy + sell > 0) || (share ?? 0) < .5 ? 'LOW_CLASSIFIED_SHARE'
        : coverage == null || coverage < FLOW_MIN_SAMPLED_COVERAGE ? 'LOW_COVERAGE' : trades < 3 * 5 ? 'FEW_TRADES' : d === 0 ? 'FLOW_FLAT'
        : d * setup! < FRESH_MCX_FLOW_MIN_DELTA ? 'SETUP_DELTA_BELOW_MIN' : !(d * (bar ?? 0) > -FRESH_MCX_FLOW_MIN_DELTA) ? 'BAR_DELTA_OPPOSES' : 'PASS';
    return {
        trend, lastClose: current?.close ?? null, sessionChangePct: current && today[0].open > 0 ? Math.round((current.close / today[0].open - 1) * 10000) / 100 : null,
        vwapDistanceAtr: current && finite(vwap) && a > 0 ? Math.round((current.close - vwap) / a * 100) / 100 : null,
        setupDeltaPct: setup == null ? null : pct(setup), barDeltaPct: bar == null ? null : pct(bar), classifiedSharePct: share == null ? null : pct(share),
        coveragePct: coverage == null ? null : pct(coverage), trades, flowCheck,
    };
}
