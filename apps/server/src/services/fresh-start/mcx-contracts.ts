import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,type Instrument} from '@fno/shared';

/** Contract-month bounds are deliberate: January 2027 energy specifications must be requalified. */
const ENERGY_SPECS = {
  CRUDEOIL:{id:'MCX_CRUDEOIL_MAR2026',tick:.10,from:'2026-03-01',until:'2027-01-01',source:'https://www.mcxindia.com/docs/default-source/products/contract-specification/crude-oil-options/crudeoil-(100-barrels)-options-march-2026-contract-onwards4f4aed50-0f8d-46a4-8f1b-efba7c9b9479.pdf'},
  NATURALGAS:{id:'MCX_NATURALGAS_MAR2026',tick:.05,from:'2026-03-01',until:'2027-01-01',source:'https://www.mcxindia.com/docs/default-source/products/contract-specification/natural-gas-option/natural-gas-(1250-mmbtu)-options-march-2026-contract-onwards.pdf'},
} as const;
export interface FreshMcxLink {optionExpiry:string;futureToken:string;futureExpiry:string;specification:string;source:string;rule:'TWO_MCX_BUSINESS_DAYS_BEFORE_FUTURE_EXPIRY';}
const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
/** Includes evening-only MCX holidays, excludes fully closed days; unknown calendar years never default to weekdays. */
export function freshMcxEnergyOptionExpiry(futureExpiry:string):string|null {
  if(!validDay(futureExpiry)||!HOLIDAY_CALENDAR_YEARS.includes(Number(futureExpiry.slice(0,4)))||!getSessionWindow('MCX',futureExpiry))return null;
  let at=Date.parse(futureExpiry+'T12:00:00Z'),remaining=2;
  for(let i=0;i<14;i++){
    at-=86400000;const day=new Date(at).toISOString().slice(0,10);
    if(!HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4))))return null;
    if(getSessionWindow('MCX',day)&&!--remaining)return day;
  }
  return null;
}
/** Resolve a single exact master future. No nearest-month, symbol suffix or premium multiplier inference. */
export function resolveFreshMcxLink(option:Instrument,master:readonly Instrument[]):FreshMcxLink|null {
  if(option.exchange!=='MCX'||option.segment!=='FO'||option.instrumentType!=='OPTFUT'||!['CE','PE'].includes(option.optionType??'')||!option.expiry||!validDay(option.expiry))return null;
  if(option.name!=='CRUDEOIL'&&option.name!=='NATURALGAS')return null;
  const spec=ENERGY_SPECS[option.name],expiry=option.expiry;
  if(expiry<spec.from||expiry>=spec.until||!Number.isFinite(option.tickSize)||Math.abs(option.tickSize-spec.tick)>1e-9)return null;
  const matches=master.filter(x=>x.exchange==='MCX'&&x.segment==='FO'&&x.instrumentType==='FUTCOM'&&x.name===option.name&&x.token&&x.expiry&&x.expiry>expiry&&freshMcxEnergyOptionExpiry(x.expiry)===expiry);
  if(matches.length!==1)return null;
  const future=matches[0];
  return {optionExpiry:option.expiry,futureToken:future.token,futureExpiry:future.expiry!,specification:spec.id,source:spec.source,rule:'TWO_MCX_BUSINESS_DAYS_BEFORE_FUTURE_EXPIRY'};
}
