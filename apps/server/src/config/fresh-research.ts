import {createHash} from 'node:crypto';
import {FRESH_PACK_VERSION,FRESH_STRATEGIES} from '@fno/analytics';
/** Prospective research periods; never an activation or profitability claim. */
export const FRESH_RESEARCH_PROTOCOL=Object.freeze({
 id:'FRESH-PROSPECTIVE-2026-11-V1',version:FRESH_PACK_VERSION,
 declaredOn:'2026-11-01',captureStart:'2026-11-02T00:00:00+05:30',
 developmentEnd:'2026-11-30T23:59:59.999+05:30',validationEnd:'2026-12-31T23:59:59.999+05:30',holdoutEnd:'2027-06-30T23:59:59.999+05:30',
 baselineTree:'76e466a8a296370f7705c56be45a56df7678253e',strategies:[...FRESH_STRATEGIES],
 scope:['NSE_INDEX_OPTIONS','NSE_STOCK_OPTIONS','BSE_VERIFIED_OPTIONS','MCX_VERIFIED_FUTURES_OPTIONS'],
 experimentBudget:'ONE_EXISTING_PARAMETER_PACK_PER_STRATEGY; NEW_VARIANTS_REQUIRE_NEW_FUTURE_PROTOCOL',
 historicalProtocol:'BLOCKED_DATASET_INVENTORY',holdoutBlindnessEnforced:false,
 criteria:{historicalTrades:200,historicalSessions:60,forwardTrades:100,forwardSessions:30,profitFactor:1.2,maxDrawdown:.05,expectancyLowerBound:0,bootstrapSeed:1731,bootstrapRepeats:2000},
 note:'Prospective periods are fixed before collection; sample counts are not guaranteed. Dates do not verify future exchange calendars. Existing visible paper outcomes cannot be assumed untouched. No automatic promotion or trading-rule changes.',
});
export const freshProtocolDigest=()=>createHash('sha256').update(JSON.stringify(FRESH_RESEARCH_PROTOCOL)).digest('hex');
Object.freeze(FRESH_RESEARCH_PROTOCOL.strategies);
Object.freeze(FRESH_RESEARCH_PROTOCOL.scope);
Object.freeze(FRESH_RESEARCH_PROTOCOL.criteria);
