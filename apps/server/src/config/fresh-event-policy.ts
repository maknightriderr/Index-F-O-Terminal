/** User approved missing economic-calendar coverage for PAPER research on 1 November 2026.
 * Known events and issuer/corporate-action, execution, quantity and account controls remain mandatory.
 * This does not attest complete coverage or authorize live execution. */
export const FRESH_PAPER_EVENT_POLICY=Object.freeze({
  id:'PAPER_EVENT_UNVERIFIED_V1',allowMissingMacroCoverage:true,
  approval:'User authorized free feeds and paper trading despite unavailable economic-calendar data; 2026-11-01',
  liveOrdersAllowed:false,
});
export type FreshEventPolicy={id:string;allowMissingMacroCoverage:boolean};
export const STRICT_FRESH_EVENT_POLICY:FreshEventPolicy=Object.freeze({id:'STRICT_EVENT_COVERAGE_V1',allowMissingMacroCoverage:false});
export const WAIVABLE_PAPER_EVENT_GAPS:readonly string[]=Object.freeze([
  'BLOCKED_EVENT_PROVIDER_CONFIGURATION','BLOCKED_EVENT_COVERAGE_CONFIRMATION',
  'BLOCKED_EVENT_PROVIDER_RESPONSE','BLOCKED_EVENT_COVERAGE','BLOCKED_COMMODITY_EVENT_COVERAGE',
]);
