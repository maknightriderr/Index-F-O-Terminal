import type {FreshFeePolicy} from '@fno/analytics';
/** User selected INR20/order on 31-Oct-2026. Frozen paper estimate, not their actual bill.
 * NSE/FA/73061: total exchange+IPFT3553/crore each side from 01-Mar-2026; NSE STT0.15%sell from 01-Apr-2026.
 * Sources: https://nsearchives.nseindia.com/content/circulars/FA73061.pdf
 * https://www.angelone.in/exchange-transaction-charges */
export const FRESH_NSE_FEES:Readonly<FreshFeePolicy>=Object.freeze({version:'NSE-2026-03-01+STT-2026-04-01+PAPER-BROKER20',brokeragePerOrder:20,exchangeFraction:.0003553,sebiFraction:.000001,stampBuyFraction:.00003,sellTaxFraction:.0015,gstFraction:.18});
