// Approved implementation pack; pure functions only. Time, calendars and data provenance are injected.
import { atr, ema } from '../indicators/index.js';
import { freshOrderFlowEvidence, type FreshOrderFlowInput } from './order-flow-evidence.js';
export const FRESH_PACK_VERSION = 'NEW-INTRADAY-1.12';
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
export type FreshStrategy = typeof FRESH_STRATEGIES[number];
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
}
export interface FreshCandidate {
    id: string;
    parentId: string;
    version: string;
    strategy: FreshStrategy;
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
    /** 'TREND' (1.8): no fixed-target exit; a trailing stop trailAtr ATRs behind the best underlying price instead. */
    exitProfile?: 'TARGET' | 'TREND';
    trailAtr?: number;
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
const finite = (x: number) => Number.isFinite(x);
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
        for (const strategy of FRESH_STRATEGIES)
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
    if (today[0].time !== c.sessionOpen || today.some((x, i) => i > 0 && x.time - today[i - 1].time !== 300000)
        || minute[0].time !== c.sessionOpen || minute.some((x, i) => i > 0 && x.time - minute[i - 1].time !== 60000))
        return refuseAll('MISSING_BARS');
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
    for (const strategy of FRESH_STRATEGIES) {
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
        if ((range || (choppy && !pullbackInTrend)) && strategy !== 'NEW_PREVIOUS_SESSION_SWEEP_V1' && strategy !== 'NEW_MOMENTUM_BREAKOUT_V1' && strategy !== 'NEW_EVENT_BREAKOUT_V1') {
            out.refusals.push({ strategy, code: 'CHOPPY_REGIME', detail: range ? 'VWAP_RANGE' : `EFFICIENCY_${Math.min(9, Math.floor(efficiency * 10))}0PCT` });
            continue;
        }
        for (const d of directions) {
            const directional = d === 1 ? bull : bear, direction: FreshDirection = d === 1 ? 'BULLISH' : 'BEARISH';
            const favorable = (x: number, y: number) => d * (x - y) > 0, vw = (x: FreshBar) => vwapAt(x.time + 300000);
            const confirms = (x: FreshBar, min = .5) => d * (x.close - x.open) > 0 && body(x) >= min;
            const lo = (xs: readonly FreshBar[]) => d === 1 ? Math.min(...xs.map(x => x.low)) : Math.max(...xs.map(x => x.high));
            let stop: number | undefined, origin: number | undefined, profile: 'TARGET' | 'TREND' = 'TARGET';
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
                out.candidates.push({ id: `${FRESH_PACK_VERSION}:${c.sourceEpoch}:${parentId}:${strategy}:${current.time}`, parentId, version: FRESH_PACK_VERSION, strategy, direction, instrument: c.instrument, sourceEpoch: c.sourceEpoch, session: c.session, at: decisionAt, referenceEntry: current.close, stop, target: targetPrice, atr: a, origin, expiresAt: Math.min(decisionAt + FRESH_ENTRY_WINDOW_MS, c.sessionClose - 3600000), exitProfile: 'TREND', trailAtr: FRESH_TREND_TRAIL_ATR, evidence: { ...(c.eventEvidence ? { eventCalendar: c.eventEvidence } : {}), orderFlow: freshOrderFlowEvidence(c.orderFlow, direction, current.time, origin), rvol: finite(rvol(current)) ? rvol(current) : 'UNAVAILABLE', volumeShape: c.volumeShape ?? 'OWN', vwap, reference: 'BAR_VWAP_PROXY', efficiency, targetKind: 'TRAILING_STOP', targetR: FRESH_TREND_NOMINAL_R, trailAtr: FRESH_TREND_TRAIL_ATR } });
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
