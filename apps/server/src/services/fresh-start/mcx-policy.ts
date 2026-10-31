/** Unvalidated paper proposal. No activation without separate parameter approval. */
export const FRESH_MCX_PAPER_PROPOSAL=Object.freeze({id:'MCX_EXACT_FUTURE_3_15_PAPER_V1' as const,status:'PROPOSED_NOT_APPROVED',products:Object.freeze(['CRUDEOIL','NATURALGAS','GOLD','SILVER']),minimumExpirySessions:3,maximumExpirySessions:15,maximumSpreadFraction:.015,zeroDte:false});
export function freshMcxPaperPolicyApproved():boolean{return false;}
