/** Concrete research proposal, not a profitability claim or activation approval.
 * Existing approved specification requires separate BSE product/expiry approval. */
export const FRESH_BSE_PAPER_PROPOSAL=Object.freeze({id:'BSE_INDEX_1_10_PAPER_V1' as const,status:'PROPOSED_NOT_APPROVED',products:['SENSEX','BANKEX','SENSEX50'] as readonly string[],minimumExpirySessions:1,maximumExpirySessions:10,zeroDte:false,maximumSpreadFraction:.01});
export function freshBsePaperPolicyApproved():boolean{return false;}
