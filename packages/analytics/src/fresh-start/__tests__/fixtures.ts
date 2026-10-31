import {admitFreshPaper,type FreshPaperPosition} from '../paper.js';
import {FRESH_PACK_VERSION,type FreshCandidate} from '../strategies.js';
export const at = 1800000000000;
export const candidate: FreshCandidate = { id: 'c1', parentId: 'p1', version: FRESH_PACK_VERSION, strategy: 'NEW_ORB_RETEST_V1', direction: 'BULLISH', instrument: 'NIFTY-FUT', sourceEpoch: 'e1', session: '2026-10-30', at, referenceEntry: 100, stop: 95, target: 115, atr: 4, expiresAt: at + 2000, origin: at - 100000, evidence: {} };
export function request() {
    return { candidate, contract: { id: 'option1', sourceEpoch: 'e1', source: 'ANGEL', lotQuantity: 25, multiplier: 1, expiryTradableSessions: 3, market: 'NSE_INDEX_OPTIONS' as const, delta: .55, metadataVerified: true, modelVerified: true, feesVerified: true, targetPremiumScenarios: [175, 170], invalidationPremiumScenarios: [90, 85], explicitRoundTripCostPerUnit: 1 },
        quote: { contract: 'option1', source: 'ANGEL', epoch: 'e1', eventAt: at + 300, receivedAt: at + 300, bid: 100, ask: 100.5, bidUnits: 5000, askUnits: 5000, tick: .5 }, account: { capital: 1000000, equity: 1000000, reservedRisk: 0, reservedPremium: 0, dailyNet: 0, openPositions: 0, consecutiveNetLosses: 0, marksComplete: true }, now: at + 300, arrivalAt: at + 250, currentUnderlying: 100, cutoff: at + 14400000, calendarVerified: true, eventClear: true, legacyPositionOpen: false, parentAlreadyTraded: false, correlatedPositionOpen: false, entriesToday: 0, barsSinceLastClose: null };
}
export function position(): FreshPaperPosition {
    const r = request(), a = admitFreshPaper(r);
    if (!a.ok)
        throw Error(a.code);
    return { id: 'c1', contract: r.contract, candidate, quantity: a.quantity, entry: a.entry, originalRiskCurrency: a.initialRiskCurrency, emergencyStop: a.emergencyStop, currentStop: a.emergencyStop, highBid: 100, openedAt: r.now, lastEventAt: r.now, state: 'OPEN', exitTriggeredAt: null, exitReason: null, exitPrice: null, netPnl: null, maxUnderlyingFavorable: 0 };
}
