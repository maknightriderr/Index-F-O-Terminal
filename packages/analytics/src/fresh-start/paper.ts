import {freshPremiumForNet,freshRoundTripFees,type FreshFeePolicy} from './pricing.js';
import type { FreshCandidate } from './strategies.js';
/** Longest expiry a paper entry may take: a monthly-only series early in its cycle (the adapter prefers 1-10 / 3-15). */
export const FRESH_MONTHLY_MAX_EXPIRY_SESSIONS = 25;
export interface FreshQuote {
    contract: string;
    source: string;
    epoch: string;
    eventAt: number;
    receivedAt: number;
    bid: number;
    ask: number;
    bidUnits: number;
    askUnits: number;
    tick: number;
}
export interface FreshContract {
    id: string;
    sourceEpoch: string;
    source: string;
    lotQuantity: number;
    multiplier: number;
    expiryTradableSessions: number;
    market: 'NSE_INDEX_OPTIONS' | 'NSE_STOCK_OPTIONS' | 'BSE_VERIFIED_OPTIONS' | 'MCX_VERIFIED_FUTURES_OPTIONS';
    marketPolicy?: 'BSE_INDEX_1_10_PAPER_V1' | 'MCX_EXACT_FUTURE_3_15_PAPER_V1';
    delta: number;
    metadataVerified: boolean;
    modelVerified: boolean;
    feesVerified: boolean;
    /** Already repriced on the correct underlying/reference, with explicit time/IV assumptions. */
    targetPremiumScenarios: readonly number[];
    invalidationPremiumScenarios: readonly number[];
    explicitRoundTripCostPerUnit: number;
    feePolicy?: FreshFeePolicy;
    evidence?: Record<string, unknown>;
}
export interface FreshAccount {
    capital: number;
    equity: number;
    reservedRisk: number;
    reservedPremium: number;
    dailyNet: number;
    openPositions: number;
    consecutiveNetLosses: number;
    marksComplete: boolean;
    /** Cumulative realized net of this pack version across every account-day, plus today's marks. Absent = not measured (refused). */
    cohortNet?: number;
}
/** PROPOSED_NOT_APPROVED: a cumulative cohort loss of this fraction of capital pauses new entries until reviewed. */
/**
 * 1.5 risk policy for the fixed INR 5,00,000 paper account. At 0.25% (INR 1,250) the 75% emergency stop made one
 * lot unaffordable on most NSE index ATM premiums and on every MCX contract, so almost every signal was refused
 * ZERO_PERMITTED_LOTS. Per-trade risk is 0.5%; open risk stays bounded by two positions (1%), the daily loss
 * limit stays 1%, and the cohort pause keeps the same ~10-loss tolerance (5% at 0.5% per trade, was 3% at 0.25%).
 */
export const FRESH_RISK_PER_TRADE = 0.005;
export const FRESH_MAX_OPEN_RISK = 0.01;
export const FRESH_DAILY_LOSS_LIMIT = 0.01;
/** Open positions a live account would allow; paper records WOULD_BLOCK_MAX_OPEN above it (2.0). */
export const FRESH_LIVE_MAX_OPEN_POSITIONS = 2;
export const FRESH_COHORT_DRAWDOWN_FRACTION = 0.05;
export type FreshAdmission = {
    ok: false;
    code: string;
} | {
    ok: true;
    entry: number;
    initialRiskPerUnit: number;
    initialRiskCurrency: number;
    emergencyStop: number;
    quantity: number;
    lots: number;
    premiumCurrency: number;
    riskRewardNet: number;
    /** Account limits that would have refused this entry in live trading; paper records them instead (2.0). */
    riskFlags: string[];
    explicitCostPerUnit: number;
};
export function freshQuoteCode(q: FreshQuote, contract: string, source: string, epoch: string, now: number): string | null {
    if (q.contract !== contract || q.source !== source || q.epoch !== epoch)
        return 'SOURCE_OR_CONTRACT_MISMATCH';
    if (![q.bid, q.ask, q.bidUnits, q.askUnits, q.eventAt, q.receivedAt, q.tick, now].every(Number.isFinite) || q.tick <= 0 || q.bid <= 0 || q.ask < q.bid || !Number.isSafeInteger(q.bidUnits) || !Number.isSafeInteger(q.askUnits) || q.bidUnits < 0 || q.askUnits < 0)
        return 'INVALID_BOOK';
    if (q.eventAt > q.receivedAt || q.receivedAt > now || now - q.eventAt > 2000)
        return 'STALE_OR_FUTURE_QUOTE';
    return null;
}
function assessFreshPaper(args: {
    candidate: FreshCandidate;
    contract: FreshContract;
    quote: FreshQuote;
    account: FreshAccount;
    now: number;
    arrivalAt: number;
    currentUnderlying: number;
    cutoff: number;
    calendarVerified: boolean;
    eventClear: boolean;
    legacyPositionOpen: boolean;
    parentAlreadyTraded: boolean;
    /** Another open position in the same risk group (sector / index family): recorded, not refused (2.0). */
    correlatedPositionOpen: boolean;
    /** An open position on this same instrument: always refused (one position per instrument, no doubling). */
    instrumentPositionOpen?: boolean;
    /** Entries on this instrument today (recorded for evidence; no longer capped, 5 Nov). */
    entriesToday: number;
    barsSinceLastClose: number | null;
}, planning = false): FreshAdmission {
    const { candidate: c, contract: k, quote: q, account: a } = args, refuse = (code: string): FreshAdmission => ({ ok: false, code });
    if (!args.calendarVerified || !args.eventClear || !k.metadataVerified || !k.modelVerified || !k.feesVerified)
        return refuse('BLOCKED_REQUIRED_CAPABILITY');
    if (k.market !== 'NSE_INDEX_OPTIONS' && k.market !== 'NSE_STOCK_OPTIONS' && !(k.market === 'BSE_VERIFIED_OPTIONS' && k.marketPolicy === 'BSE_INDEX_1_10_PAPER_V1') && !(k.market === 'MCX_VERIFIED_FUTURES_OPTIONS' && k.marketPolicy === 'MCX_EXACT_FUTURE_3_15_PAPER_V1'))
        return refuse('MARKET_DISCOVERY_ONLY');
    if (!Number.isSafeInteger(k.expiryTradableSessions) || k.expiryTradableSessions < ((k.market === 'NSE_STOCK_OPTIONS' || k.market === 'MCX_VERIFIED_FUTURES_OPTIONS') ? 3 : 1) || k.expiryTradableSessions > FRESH_MONTHLY_MAX_EXPIRY_SESSIONS)
        return refuse('EXPIRY_INELIGIBLE');
    const qc = freshQuoteCode(q, k.id, k.source, k.sourceEpoch, args.now);
    if (qc)
        return refuse(qc);
    if (c.sourceEpoch !== k.sourceEpoch)
        return refuse('SOURCE_EPOCH_CHANGED');
    if (![c.at, c.expiresAt, c.referenceEntry, c.stop, c.target, c.atr, args.now, args.arrivalAt, args.currentUnderlying, args.cutoff, a.capital, a.equity, a.reservedRisk, a.reservedPremium, a.dailyNet, a.openPositions, a.consecutiveNetLosses, k.explicitRoundTripCostPerUnit, k.delta].every(Number.isFinite))
        return refuse('INVALID_INPUT');
    const d = c.direction === 'BULLISH' ? 1 : -1;
    if (c.atr <= 0 || c.stop <= 0 || d * (c.referenceEntry - c.stop) <= 0 || d * (c.target - c.referenceEntry) <= 0 || d * (args.currentUnderlying - c.stop) <= 0 || d * (c.target - args.currentUnderlying) <= 0)
        return refuse('INVALIDATED_OR_TARGET_REACHED');
    if ((!planning && (args.arrivalAt < c.at + 250 || args.now < args.arrivalAt || q.receivedAt < args.arrivalAt || q.eventAt < args.arrivalAt)) || (planning && args.now < c.at) || args.now > c.expiresAt || args.now >= args.cutoff - 3600000)
        return refuse('ENTRY_EXPIRED_OR_EARLY');
    if (d * (args.currentUnderlying - c.referenceEntry) > .25 * c.atr)
        return refuse('EXTENDED_ENTRY');
    // 2.0 (owner, 7 Nov): in paper the account limits RECORD instead of refusing, so a strategy keeps producing trades
    // (and its evidence) after losses. Each one a live account would have enforced is kept on the position as a
    // riskFlag (and announced). Still refused: the legacy book, a second position on the same instrument, a second
    // trade from the same parent setup, broken account state, and premium beyond the paper cash available.
    if (args.legacyPositionOpen || args.instrumentPositionOpen || args.parentAlreadyTraded)
        return refuse('EXPOSURE_OR_PARENT');
    if (!a.marksComplete || a.capital <= 0 || a.equity <= 0 || a.reservedRisk < 0 || a.reservedPremium < 0)
        return refuse('ACCOUNT_PAUSED');
    if (a.cohortNet == null || !Number.isFinite(a.cohortNet))
        return refuse('COHORT_DRAWDOWN_PAUSED');
    const riskFlags: string[] = [];
    if (args.correlatedPositionOpen) riskFlags.push('WOULD_BLOCK_CORRELATED');
    if (args.barsSinceLastClose != null && args.barsSinceLastClose < 3) riskFlags.push('WOULD_BLOCK_REENTRY_COOLDOWN');
    if (a.openPositions >= FRESH_LIVE_MAX_OPEN_POSITIONS) riskFlags.push('WOULD_BLOCK_MAX_OPEN');
    if (a.consecutiveNetLosses >= 3) riskFlags.push('WOULD_PAUSE_3_LOSSES');
    if (a.dailyNet <= -FRESH_DAILY_LOSS_LIMIT * a.capital) riskFlags.push('WOULD_PAUSE_DAILY_LOSS');
    // A run of losing days never resets the cohort: each account-day starts fresh, the cumulative drawdown does not.
    if (a.cohortNet <= -FRESH_COHORT_DRAWDOWN_FRACTION * a.capital) riskFlags.push('WOULD_PAUSE_COHORT');
    if (!Number.isSafeInteger(k.lotQuantity) || k.lotQuantity <= 0 || !Number.isFinite(k.multiplier) || k.multiplier <= 0 || Math.abs(k.delta) < .45 || Math.abs(k.delta) > .65 || (d === 1 ? k.delta <= 0 : k.delta >= 0))
        return refuse('INVALID_CONTRACT');
    if ((q.ask - q.bid) / ((q.ask + q.bid) / 2) > ((k.market === 'NSE_STOCK_OPTIONS' || k.market === 'MCX_VERIFIED_FUTURES_OPTIONS') ? .015 : .01))
        return refuse('WIDE_SPREAD');
    if (k.targetPremiumScenarios.length !== 2 || k.invalidationPremiumScenarios.length !== 2 || ![...k.targetPremiumScenarios, ...k.invalidationPremiumScenarios].every(x => Number.isFinite(x) && x >= 0) || k.explicitRoundTripCostPerUnit < 0)
        return refuse('MODEL_OR_COST_UNAVAILABLE');
    const entry = q.ask + q.tick, emergencyStop = Math.ceil(entry * .75 / q.tick - 1e-9) * q.tick;
    const explicit = k.explicitRoundTripCostPerUnit;
    // Both adverse exit tick and quantity-level flat brokerage belong in frozen initial R.
    const baseRisk = Math.max(entry - Math.max(0,Math.min(...k.invalidationPremiumScenarios)-q.tick), entry-Math.max(0,emergencyStop-q.tick));
    const targetExit=Math.max(0,Math.min(...k.targetPremiumScenarios)-q.tick),perLot=k.lotQuantity*k.multiplier;
    // Sized on the per-trade risk alone (2.0): the open-risk and daily budgets used to shrink the size to zero after a
    // loss, which refused the trade as surely as a pause. What a live account would have allowed is recorded below.
    const budget=FRESH_RISK_PER_TRADE*a.capital,liveBudget=Math.min(budget,FRESH_MAX_OPEN_RISK*a.capital-a.reservedRisk,FRESH_DAILY_LOSS_LIMIT*a.capital+a.dailyNet-a.reservedRisk);
    let fixed=0,variable=explicit*perLot;
    try { if(k.feePolicy){fixed=2*k.feePolicy.brokeragePerOrder*(1+k.feePolicy.gstFraction);variable=freshRoundTripFees(entry,entry,k.lotQuantity,k.multiplier,k.feePolicy)-fixed;} }
    catch {return refuse('MODEL_OR_COST_UNAVAILABLE');}
    const lots=Math.floor(Math.min((budget-fixed)/(baseRisk*perLot+variable),.05*a.capital/(entry*perLot),(a.equity-a.reservedPremium)/(entry*perLot),Math.min(q.askUnits,q.bidUnits)/k.lotQuantity));
    if(!Number.isFinite(lots)||lots<1)return refuse('ZERO_PERMITTED_LOTS');
    const quantity=lots*k.lotQuantity,units=quantity*k.multiplier;
    if(!Number.isSafeInteger(quantity)||!Number.isFinite(units*entry))return refuse('INVALID_SIZING_UNITS');
    const riskFees=k.feePolicy?freshRoundTripFees(entry,entry,quantity,k.multiplier,k.feePolicy):explicit*units;
    const rewardFees=k.feePolicy?freshRoundTripFees(entry,targetExit,quantity,k.multiplier,k.feePolicy):explicit*units;
    const initialRiskCurrency=baseRisk*units+riskFees,rr=((targetExit-entry)*units-rewardFees)/initialRiskCurrency;
    if(!(initialRiskCurrency>0)||!Number.isFinite(rr)||rr<1.5)return refuse('NET_PAYOFF_TOO_LOW');
    if(initialRiskCurrency>liveBudget+1e-6)riskFlags.push('WOULD_BLOCK_OPEN_RISK');
    return {ok:true,entry,emergencyStop,quantity,lots,initialRiskPerUnit:initialRiskCurrency/units,initialRiskCurrency,premiumCurrency:entry*units,riskRewardNet:rr,explicitCostPerUnit:riskFees/units,riskFlags};
}
export type FreshAdmissionInput=Parameters<typeof assessFreshPaper>[0];
/** Indicative selection only. Never use this result as a fill authorization. */
export function assessFreshPlan(args:FreshAdmissionInput){return assessFreshPaper(args,true);}
export function admitFreshPaper(args:FreshAdmissionInput){return assessFreshPaper(args,false);}

export interface FreshPaperPosition {
    id: string;
    /** Live account limits this paper entry went past (FreshAdmission.riskFlags); absent before 2.0. */
    riskFlags?: string[];
    contract: FreshContract;
    candidate: FreshCandidate;
    quantity: number;
    entry: number;
    originalRiskCurrency: number;
    emergencyStop: number;
    currentStop: number;
    highBid: number;
    openedAt: number;
    lastEventAt: number;
    state: 'OPEN' | 'EXIT_PENDING' | 'CLOSED';
    exitTriggeredAt: number | null;
    exitReason: string | null;
    exitPrice: number | null;
    netPnl: number | null;
    maxUnderlyingFavorable: number;
    sessionCutoff?: number;
    estimatedFees?: number;
}
/** PROPOSED_NOT_APPROVED research values: how long a thin two-sided book may hold an exit, and the haircut for undisplayed units. */
export const FRESH_THIN_BOOK_GRACE_MS = 60_000;
export const FRESH_THIN_BOOK_HAIRCUT = 0.10;
/** 1.8 trend exits: the longest hold in completed five-minute bars (4 hours; the session cutoff still applies). */
export const FRESH_TREND_MAX_HOLD_BARS = 48;
/**
 * 1.8: the underlying level a TREND position exits at on a five-minute close — the candidate's structural stop until
 * the best price reached is more than trailAtr ATRs beyond entry, then trailAtr ATRs behind that best price. It only
 * ever tightens (the best price is monotone), and it is null for non-trend positions.
 */
export function freshTrailingStop(p: Pick<FreshPaperPosition, 'candidate' | 'maxUnderlyingFavorable'>): number | null {
    const c = p.candidate;
    if (c.exitProfile !== 'TREND' || !(c.trailAtr! > 0) || !(c.atr > 0)) return null;
    const d = c.direction === 'BULLISH' ? 1 : -1, distance = c.trailAtr! * c.atr;
    // Inactive until the move has paid trailAtr ATRs, so the trail starts at breakeven and never sits inside entry noise.
    if (!(p.maxUnderlyingFavorable >= distance)) return null;
    const trail = c.referenceEntry + d * (p.maxUnderlyingFavorable - distance);
    return d * (trail - c.stop) > 0 ? trail : null;
}
/** Immutable observation reduction. Missing quotes never invent a fill or clear an existing pending exit. */
export function advanceFreshPosition(p: FreshPaperPosition, e: {
    at: number;
    underlying: number | null;
    underlyingAt: number | null;
    quote: FreshQuote | null;
    cutoff: number;
    barsSinceFill: number;
    trail: boolean;
    monitorEpoch?: string;
    /**
     * 1.5 (E-03): the last completed 5-minute close of the underlying. When the field is present (even null),
     * structural invalidation needs a CLOSE beyond the candidate's stop, so a wick through the level no longer exits;
     * the 75% premium emergency stop still protects intrabar. Absent (older callers/replays): the tick rule applies.
     */
    underlyingClose?: { price: number; closedAt: number } | null;
}): FreshPaperPosition {
    if (p.state === 'CLOSED' || e.at <= p.lastEventAt || !Number.isFinite(e.at))
        return p;
    if (!Number.isFinite(e.cutoff) || !Number.isSafeInteger(e.barsSinceFill) || e.barsSinceFill < 0)
        return p;
    const n = { ...p, lastEventAt: e.at }, d = p.candidate.direction === 'BULLISH' ? 1 : -1, trend = p.candidate.exitProfile === 'TREND';
    const underlyingFresh = e.underlying != null && Number.isFinite(e.underlying) && e.underlying > 0 && e.underlyingAt != null && e.underlyingAt <= e.at && e.at - e.underlyingAt <= 2000;
    const q = e.quote, quoteFresh = q && freshQuoteCode(q, p.contract.id, p.contract.source, e.monitorEpoch ?? p.contract.sourceEpoch, e.at) === null;
    if (underlyingFresh)
        n.maxUnderlyingFavorable = Math.max(n.maxUnderlyingFavorable, d * (e.underlying! - p.candidate.referenceEntry));
    const beforeStop = n.currentStop;
    if (quoteFresh) {
        // Trailing requires a credible liquidation quote for the full held quantity.
        if (q!.bidUnits >= n.quantity) {
            n.highBid = Math.max(n.highBid, q!.bid);
            // Trend positions always ratchet the premium stop (breakeven at 1R, +1R at 2R): the move is meant to run.
            if (e.trail || trend) {
                const perUnitR = n.originalRiskCurrency / (n.quantity * n.contract.multiplier), fee = n.contract.explicitRoundTripCostPerUnit;
                const policy=n.contract.feePolicy,units=n.quantity*n.contract.multiplier;
                const r = policy?((Math.max(0,q!.bid-q!.tick)-n.entry)*units-freshRoundTripFees(n.entry,Math.max(0,q!.bid-q!.tick),n.quantity,n.contract.multiplier,policy))/n.originalRiskCurrency:(q!.bid-n.entry-fee)/perUnitR;
                if (r >= 1)
                    n.currentStop = Math.max(n.currentStop, Math.ceil((policy?freshPremiumForNet(n.entry,n.quantity,n.contract.multiplier,policy,0):n.entry+fee) / q!.tick) * q!.tick);
                if (r >= 2)
                    n.currentStop = Math.max(n.currentStop, Math.ceil((policy?freshPremiumForNet(n.entry,n.quantity,n.contract.multiplier,policy,n.originalRiskCurrency):n.entry+fee+perUnitR) / q!.tick) * q!.tick);
            }
        }
    }
    if (n.state === 'OPEN') {
        // A thin book delays the fill, never the trigger: the stop fires on price alone.
        const reachedStop = quoteFresh && q!.bid <= beforeStop;
        const closeRule = e.underlyingClose !== undefined;
        const barClose = e.underlyingClose;
        const trailing = freshTrailingStop(n), exitLevel = trailing ?? n.candidate.stop;
        const invalid = closeRule
            ? barClose != null && Number.isFinite(barClose.price) && barClose.price > 0 && barClose.closedAt > p.openedAt && barClose.closedAt <= e.at && d * (barClose.price - exitLevel) <= 0
            : underlyingFresh && d * (e.underlying! - exitLevel) <= 0;
        // A trend position has no fixed objective: its nominal target only sized the admission payoff check.
        const target = !trend && underlyingFresh && d * (e.underlying! - n.candidate.target) >= 0;
        const noProgress = e.barsSinceFill >= 3 && n.maxUnderlyingFavorable < .25 * Math.abs(n.candidate.referenceEntry - n.candidate.stop) && underlyingFresh && d * (e.underlying! - n.candidate.referenceEntry) < 0;
        const maxHold = trend ? FRESH_TREND_MAX_HOLD_BARS : 12;
        const reason = e.at >= e.cutoff - 600000 ? 'SESSION_CUTOFF' : reachedStop ? 'PREMIUM_STOP' : invalid ? (trailing != null ? 'TRAILING_STOP' : 'STRUCTURAL_INVALIDATION') : target ? 'UNDERLYING_TARGET' : e.barsSinceFill >= maxHold ? 'MAX_HOLD' : noProgress ? 'NO_PROGRESS' : null;
        if (reason) {
            n.state = 'EXIT_PENDING';
            n.exitTriggeredAt = e.at;
            n.exitReason = reason;
        }
    }
    const exitQuote = n.state === 'EXIT_PENDING' && quoteFresh && q!.receivedAt >= n.exitTriggeredAt! + 250 && q!.eventAt >= n.exitTriggeredAt! + 250;
    const fullBook = exitQuote && q!.bidUnits >= n.quantity;
    // A two-sided book that stays thinner than the position is liquidated conservatively instead of pending forever:
    // displayed units at bid − 1 tick, the remainder FRESH_THIN_BOOK_HAIRCUT below the bid. Absent quotes still never fill.
    const thinBook = exitQuote && !fullBook && q!.bid > 0 && e.at - n.exitTriggeredAt! >= FRESH_THIN_BOOK_GRACE_MS;
    if (fullBook || thinBook) {
        const top = Math.max(0, q!.bid - q!.tick);
        n.state = 'CLOSED';
        if (fullBook) n.exitPrice = top;
        else {
            const shown = Math.max(0, Math.min(1, q!.bidUnits / n.quantity));
            const rest = Math.max(0, Math.floor((q!.bid * (1 - FRESH_THIN_BOOK_HAIRCUT)) / q!.tick) * q!.tick);
            n.exitPrice = shown * top + (1 - shown) * rest;
            n.exitReason = `${n.exitReason}+THIN_BOOK_HAIRCUT`;
        }
        n.estimatedFees = n.contract.feePolicy?freshRoundTripFees(n.entry,n.exitPrice,n.quantity,n.contract.multiplier,n.contract.feePolicy):n.contract.explicitRoundTripCostPerUnit*n.quantity*n.contract.multiplier;
        n.netPnl = (n.exitPrice-n.entry)*n.quantity*n.contract.multiplier-n.estimatedFees;
    }
    return n;
}
export function canonicalFreshParent(c: FreshCandidate, active: readonly {
    instrument: string;
    direction: string;
    session: string;
    origin: number;
    ended: boolean;
}[]): string {
    const parent = active.filter(x => !x.ended && x.instrument === c.instrument && x.direction === c.direction && x.session === c.session && x.origin <= c.at).sort((x, y) => x.origin - y.origin)[0];
    return `${c.instrument}:${c.session}:${c.direction}:${parent?.origin ?? c.origin}`;
}
/** Bounded shortlist only. Mandatory gates precede payoff ordering; the nearest underlying objective is immutable. */
export function selectFreshContract(base: Omit<Parameters<typeof admitFreshPaper>[0], 'contract' | 'quote'>, shortlist: readonly {
    strike: number;
    expiry: string;
    contract: FreshContract;
    quote: FreshQuote;
}[]) {
    if (shortlist.length > 10 || new Set(shortlist.map(x => x.strike)).size > 5 || new Set(shortlist.map(x => x.expiry)).size > 2)
        return { selected: null, refusals: [{ contract: '*', code: 'SHORTLIST_LIMIT' }] };
    const refusals: Array<{
        contract: string;
        code: string;
    }> = [], eligible: Array<{
        contract: FreshContract;
        quote: FreshQuote;
        admission: Extract<FreshAdmission, {
            ok: true;
        }>;
    }> = [];
    for (const x of shortlist) {
        if (!Number.isFinite(x.strike) || x.strike <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(x.expiry)) {
            refusals.push({ contract: x.contract.id, code: 'INVALID_CONTRACT_IDENTITY' });
            continue;
        }
        const a = admitFreshPaper({ ...base, contract: x.contract, quote: x.quote });
        if (a.ok)
            eligible.push({ contract: x.contract, quote: x.quote, admission: a });
        else
            refusals.push({ contract: x.contract.id, code: a.code });
    }
    const spread = (q: FreshQuote) => (q.ask - q.bid) / ((q.ask + q.bid) / 2);
    eligible.sort((a, b) => b.admission.riskRewardNet - a.admission.riskRewardNet || spread(a.quote) - spread(b.quote) || a.contract.id.localeCompare(b.contract.id));
    return { selected: eligible[0] ?? null, refusals };
}
