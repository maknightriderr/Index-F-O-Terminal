import type {FreshFeePolicy} from '@fno/analytics';
import type {Instrument} from '@fno/shared';
/** User selected INR20/order on 31-Oct-2026. Frozen paper estimate, not their actual bill.
 * NSE/FA/73061: total exchange+IPFT3553/crore each side from 01-Mar-2026; NSE STT0.15%sell from 01-Apr-2026.
 * Sources: https://nsearchives.nseindia.com/content/circulars/FA73061.pdf
 * https://www.angelone.in/exchange-transaction-charges */
export const FRESH_NSE_FEES:Readonly<FreshFeePolicy>=Object.freeze({version:'NSE-2026-03-01+STT-2026-04-01+PAPER-BROKER20',brokeragePerOrder:20,exchangeFraction:.0003553,sebiFraction:.000001,stampBuyFraction:.00003,sellTaxFraction:.0015,gstFraction:.18});
const BSE_INDEX_FEES:Readonly<FreshFeePolicy>=Object.freeze({...FRESH_NSE_FEES,version:'BSE-SENSEX-BANKEX-OBSERVED-2026-10-31+PAPER-BROKER20',exchangeFraction:.000325});
const BSE_SENSEX50_FEES:Readonly<FreshFeePolicy>=Object.freeze({...BSE_INDEX_FEES,version:'BSE-SENSEX50-OBSERVED-2026-10-31+PAPER-BROKER20',exchangeFraction:.00005});
const MCX_NON_AGRI_FEES:Readonly<FreshFeePolicy>=Object.freeze({...FRESH_NSE_FEES,version:'MCX-SCOPED-NONAGRI-OBSERVED-2026-10-31+PAPER-BROKER20',exchangeFraction:.000418,sellTaxFraction:.0005});
const TARIFF_SOURCE='https://www.angelone.in/exchange-transaction-charges';
type FeeInstrument=Pick<Instrument,'exchange'|'segment'|'instrumentType'|'name'>;
/** A dated published-tariff estimate, not a contract note or authorization to trade a market.
 * Product exemptions and unknown tariffs fail closed. MCX premium units must be supplied independently. */
export function freshFeePolicyFor(instrument:FeeInstrument,session:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(session)||!Number.isFinite(Date.parse(session+'T00:00:00Z'))||new Date(session+'T00:00:00Z').toISOString().slice(0,10)!==session||session>='2027-01-01'||instrument.segment!=='FO')return null;
  let policy:Readonly<FreshFeePolicy>,tax:'STT'|'CTT'='STT',from='2026-10-31';
  if(instrument.exchange==='NSE'&&['OPTIDX','OPTSTK'].includes(instrument.instrumentType)&&instrument.name!=='NIFTYFPI'){
    from='2026-04-01';policy=FRESH_NSE_FEES;
  }else if(instrument.exchange==='BSE'&&instrument.instrumentType==='OPTIDX'){
    if(['SENSEX','BANKEX'].includes(instrument.name))policy=BSE_INDEX_FEES;
    else if(instrument.name==='SENSEX50')policy=BSE_SENSEX50_FEES;
    else return null;
  }else if(instrument.exchange==='MCX'&&instrument.instrumentType==='OPTFUT'&&['CRUDEOIL','NATURALGAS','GOLD','SILVER'].includes(instrument.name)){
    policy=MCX_NON_AGRI_FEES;tax='CTT';
  }else return null;
  if(session<from)return null;
  return {policy,evidence:{source:TARIFF_SOURCE,observedOn:'2026-10-31',from,until:'2027-01-01',exchange:instrument.exchange,product:instrument.name,tax,brokerage:'APPROVED_PAPER_FLAT_20_PER_EXECUTED_ORDER',basis:'PREMIUM_TURNOVER',rounding:'UNROUNDED_ESTIMATE',executionScope:'BUY_THEN_SELL_OPTIONS_NO_EXERCISE_OR_DEVOLVEMENT'}};
}
