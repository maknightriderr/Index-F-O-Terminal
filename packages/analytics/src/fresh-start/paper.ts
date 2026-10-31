import {freshPremiumForNet,freshRoundTripFees,type FreshFeePolicy} from './pricing.js';
import type { FreshCandidate } from './strategies.js';
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
}
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
    correlatedPositionOpen: boolean;
    entriesToday: number;
    barsSinceLastClose: number | null;
}, planning = false): FreshAdmission {
    const { candidate: c, contract: k, quote: q, account: a } = args, refuse = (code: string): FreshAdmission => ({ ok: false, code });
    if (!args.calendarVerified || !args.eventClear || !k.metadataVerified || !k.modelVerified || !k.feesVerified)
        return refuse('BLOCKED_REQUIRED_CAPABILITY');
    if (k.market !== 'NSE_INDEX_OPTIONS' && k.market !== 'NSE_STOCK_OPTIONS' && !(k.market === 'BSE_VERIFIED_OPTIONS' && k.marketPolicy === 'BSE_INDEX_1_10_PAPER_V1') && !(k.market === 'MCX_VERIFIED_FUTURES_OPTIONS' && k.marketPolicy === 'MCX_EXACT_FUTURE_3_15_PAPER_V1'))
        return refuse('MARKET_DISCOVERY_ONLY');
    if (!Number.isSafeInteger(k.expiryTradableSessions) || k.expiryTradableSessions < ((k.market === 'NSE_STOCK_OPTIONS' || k.market === 'MCX_VERIFIED_FUTURES_OPTIONS') ? 3 : 1) || k.expiryTradableSessions > ((k.market === 'NSE_STOCK_OPTIONS' || k.market === 'MCX_VERIFIED_FUTURES_OPTIONS') ? 15 : 10))
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
    if (args.legacyPositionOpen || args.correlatedPositionOpen || args.parentAlreadyTraded || args.entriesToday >= 2 || (args.barsSinceLastClose != null && args.barsSinceLastClose < 3))
        return refuse('EXPOSURE_OR_PARENT');
    if (!a.marksComplete || a.capital <= 0 || a.equity <= 0 || a.reservedRisk < 0 || a.reservedPremium < 0 || a.openPositions >= 2 || a.dailyNet <= -.01 * a.capital || a.consecutiveNetLosses >= 3)
        return refuse('ACCOUNT_PAUSED');
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
    const budget=Math.min(.0025*a.capital,.005*a.capital-a.reservedRisk,.01*a.capital+a.dailyNet-a.reservedRisk);
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
    return {ok:true,entry,emergencyStop,quantity,lots,initialRiskPerUnit:initialRiskCurrency/units,initialRiskCurrency,premiumCurrency:entry*units,riskRewardNet:rr,explicitCostPerUnit:riskFees/units};
}
export type FreshAdmissionInput=Parameters<typeof assessFreshPaper>[0];
/** Indicative selection only. Never use this result as a fill authorization. */
export function assessFreshPlan(args:FreshAdmissionInput){return assessFreshPaper(args,true);}
export function admitFreshPaper(args:FreshAdmissionInput){return assessFreshPaper(args,false);}

export interface FreshPaperPosition {
    id: string;
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
}): FreshPaperPosition {
    if (p.state === 'CLOSED' || e.at <= p.lastEventAt || !Number.isFinite(e.at))
        return p;
    if (!Number.isFinite(e.cutoff) || !Number.isSafeInteger(e.barsSinceFill) || e.barsSinceFill < 0)
        return p;
    const n = { ...p, lastEventAt: e.at }, d = p.candidate.direction === 'BULLISH' ? 1 : -1;
    const underlyingFresh = e.underlying != null && Number.isFinite(e.underlying) && e.underlying > 0 && e.underlyingAt != null && e.underlyingAt <= e.at && e.at - e.underlyingAt <= 2000;
    const q = e.quote, quoteFresh = q && freshQuoteCode(q, p.contract.id, p.contract.source, e.monitorEpoch ?? p.contract.sourceEpoch, e.at) === null;
    if (underlyingFresh)
        n.maxUnderlyingFavorable = Math.max(n.maxUnderlyingFavorable, d * (e.underlying! - p.candidate.referenceEntry));
    const beforeStop = n.currentStop;
    if (quoteFresh) {
        // Trailing requires a credible liquidation quote for the full held quantity.
        if (q!.bidUnits >= n.quantity) {
            n.highBid = Math.max(n.highBid, q!.bid);
            if (e.trail) {
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
        const reachedStop = quoteFresh && q!.bidUnits >= n.quantity && q!.bid <= beforeStop;
        const invalid = underlyingFresh && d * (e.underlying! - n.candidate.stop) <= 0;
        const target = underlyingFresh && d * (e.underlying! - n.candidate.target) >= 0;
        const noProgress = e.barsSinceFill >= 3 && n.maxUnderlyingFavorable < .25 * Math.abs(n.candidate.referenceEntry - n.candidate.stop) && underlyingFresh && d * (e.underlying! - n.candidate.referenceEntry) < 0;
        const reason = e.at >= e.cutoff - 600000 ? 'SESSION_CUTOFF' : reachedStop ? 'PREMIUM_STOP' : invalid ? 'STRUCTURAL_INVALIDATION' : target ? 'UNDERLYING_TARGET' : e.barsSinceFill >= 12 ? 'MAX_HOLD' : noProgress ? 'NO_PROGRESS' : null;
        if (reason) {
            n.state = 'EXIT_PENDING';
            n.exitTriggeredAt = e.at;
            n.exitReason = reason;
        }
    }
    if (n.state === 'EXIT_PENDING' && quoteFresh && q!.receivedAt >= n.exitTriggeredAt! + 250 && q!.eventAt >= n.exitTriggeredAt! + 250 && q!.bidUnits >= n.quantity) {
        n.state = 'CLOSED';
        n.exitPrice = Math.max(0, q!.bid - q!.tick);
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
