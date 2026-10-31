/** Approved paper hypothesis: user accepted the presented 3–15 session / 1.5% spread proposal
 * with "merge, deploy and start next phase" on 31-Oct-2026. Data/unit/event gates remain mandatory. */
export const FRESH_MCX_PAPER_PROPOSAL=Object.freeze({id:'MCX_EXACT_FUTURE_3_15_PAPER_V1' as const,status:'APPROVED_PAPER_HYPOTHESIS',products:Object.freeze(['CRUDEOIL','NATURALGAS','GOLD','SILVER']),minimumExpirySessions:3,maximumExpirySessions:15,maximumSpreadFraction:.015,zeroDte:false});
export function freshMcxPaperPolicyApproved():boolean{return true;}
