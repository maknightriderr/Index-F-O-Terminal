/** Approved paper hypothesis, not a profitability claim.
 * User accepted the concrete BSE proposal with "merge, deploy and start next phase" on 31-Oct-2026. */
// zeroDte:false is the fresh-start strategies' rule. The Dhan engine's expiry-gamma module (owner, 8 Nov: 30% premium
// stop, 15:15 exit) trades the expiry-day SENSEX / NIFTY option by its own premium-exit rule (FreshCandidate.premiumExit).
export const FRESH_BSE_PAPER_PROPOSAL=Object.freeze({id:'BSE_INDEX_1_10_PAPER_V1' as const,status:'APPROVED_PAPER_HYPOTHESIS',products:['SENSEX','BANKEX','SENSEX50'] as readonly string[],minimumExpirySessions:1,maximumExpirySessions:10,zeroDte:false,maximumSpreadFraction:.01});
export function freshBsePaperPolicyApproved():boolean{return true;}
