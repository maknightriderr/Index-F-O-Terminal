import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,type Instrument} from '@fno/shared';

/** Contract-month bounds are deliberate: January 2027 energy specifications must be requalified. */
const ENERGY_SPECS = {
  CRUDEOIL:{id:'MCX_CRUDEOIL_MAR2026',tick:.10,from:'2026-03-01',until:'2027-01-01',source:'https://www.mcxindia.com/docs/default-source/products/contract-specification/crude-oil-options/crudeoil-(100-barrels)-options-march-2026-contract-onwards4f4aed50-0f8d-46a4-8f1b-efba7c9b9479.pdf'},
  NATURALGAS:{id:'MCX_NATURALGAS_MAR2026',tick:.05,from:'2026-03-01',until:'2027-01-01',source:'https://www.mcxindia.com/docs/default-source/products/contract-specification/natural-gas-option/natural-gas-(1250-mmbtu)-options-march-2026-contract-onwards.pdf'},
} as const;
const GOLD_SOURCE='https://www.mcxindia.com/docs/default-source/options/gold-option-july-2026-contract-onwards8d88befa-a326-4ac6-8de1-4bfec750135e.pdf';
// Exact annexure dates in the current July specification; older circulars have different dates.
const GOLD_CALENDAR:Readonly<Record<string,string>>={'2026-07-29':'2026-08','2026-08-31':'2026-10','2026-09-25':'2026-10','2026-10-30':'2026-12','2026-11-27':'2026-12'};
const SILVER_SOURCE='https://www.mcxindia.com/docs/default-source/options/silver-(30-kilograms)-options-february-2026-contract-onwards.pdf';
const SILVER_FUTURE_SOURCE='https://www.mcxindia.com/docs/default-source/about-us/silver-september-2026-contract-onwards.pdf';
export interface FreshMcxLink {optionExpiry:string;futureToken:string;futureExpiry:string;specification:string;source:string;underlyingSource?:string;tenderStart?:string;rule:'TWO_MCX_BUSINESS_DAYS_BEFORE_FUTURE_EXPIRY'|'PUBLISHED_GOLD_LAUNCH_CALENDAR'|'THREE_MCX_BUSINESS_DAYS_BEFORE_TENDER';}
const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
/** Includes evening-only MCX holidays, excludes fully closed days; unknown calendar years never default to weekdays. */
function previousMcxBusinessDays(futureExpiry:string,count:number):string|null {
  if(!validDay(futureExpiry)||!HOLIDAY_CALENDAR_YEARS.includes(Number(futureExpiry.slice(0,4)))||!getSessionWindow('MCX',futureExpiry))return null;
  let at=Date.parse(futureExpiry+'T12:00:00Z'),remaining=count;
  for(let i=0;i<14;i++){
    at-=86400000;const day=new Date(at).toISOString().slice(0,10);
    if(!HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4))))return null;
    if(getSessionWindow('MCX',day)&&!--remaining)return day;
  }
  return null;
}
export function freshMcxEnergyOptionExpiry(futureExpiry:string):string|null{return previousMcxBusinessDays(futureExpiry,2);}
function bullionLink(option:Instrument,master:readonly Instrument[]):FreshMcxLink|null {
  const expiry=option.expiry!;
  if(!Number.isFinite(option.tickSize)||Math.abs(option.tickSize-.5)>1e-9)return null;
  const futures=master.filter(x=>x.exchange==='MCX'&&x.segment==='FO'&&x.instrumentType==='FUTCOM'&&x.name===option.name&&x.token&&x.expiry&&validDay(x.expiry)&&x.expiry>expiry&&HOLIDAY_CALENDAR_YEARS.includes(Number(x.expiry.slice(0,4)))&&getSessionWindow('MCX',x.expiry));
  if(option.name==='GOLD'){
    const month=GOLD_CALENDAR[expiry];if(!month)return null;
    const matches=futures.filter(x=>x.expiry!.slice(0,7)===month);if(matches.length!==1)return null;
    return {optionExpiry:expiry,futureToken:matches[0].token,futureExpiry:matches[0].expiry!,specification:'MCX_GOLD_JUL2026_CALENDAR',source:GOLD_SOURCE,rule:'PUBLISHED_GOLD_LAUNCH_CALENDAR'};
  }
  // September future specifications shorten tender from five to three trading days.
  // New December option / March 2027 future specifications are deliberately not inherited.
  if(expiry<'2026-02-01'||expiry>='2026-12-01')return null;
  const matches=futures.filter(x=>x.expiry!>='2026-09-01'&&x.expiry!<'2027-03-01').map(future=>({future,tenderStart:previousMcxBusinessDays(future.expiry!,2)})).filter(x=>x.tenderStart&&previousMcxBusinessDays(x.tenderStart,3)===expiry);
  if(matches.length!==1)return null;
  const {future,tenderStart}=matches[0];
  return {optionExpiry:expiry,futureToken:future.token,futureExpiry:future.expiry!,tenderStart:tenderStart!,specification:'MCX_SILVER_FEB2026_OPTION_SEP2026_FUTURE',source:SILVER_SOURCE,underlyingSource:SILVER_FUTURE_SOURCE,rule:'THREE_MCX_BUSINESS_DAYS_BEFORE_TENDER'};
}
/** Resolve a single exact master future. No nearest-month, symbol suffix or premium multiplier inference. */
export function resolveFreshMcxLink(option:Instrument,master:readonly Instrument[]):FreshMcxLink|null {
  if(option.exchange!=='MCX'||option.segment!=='FO'||option.instrumentType!=='OPTFUT'||!['CE','PE'].includes(option.optionType??'')||!option.expiry||!validDay(option.expiry))return null;
  if(option.name==='GOLD'||option.name==='SILVER')return bullionLink(option,master);
  if(option.name!=='CRUDEOIL'&&option.name!=='NATURALGAS')return null;
  const spec=ENERGY_SPECS[option.name],expiry=option.expiry;
  if(expiry<spec.from||expiry>=spec.until||!Number.isFinite(option.tickSize)||Math.abs(option.tickSize-spec.tick)>1e-9)return null;
  const matches=master.filter(x=>x.exchange==='MCX'&&x.segment==='FO'&&x.instrumentType==='FUTCOM'&&x.name===option.name&&x.token&&x.expiry&&x.expiry>expiry&&freshMcxEnergyOptionExpiry(x.expiry)===expiry);
  if(matches.length!==1)return null;
  const future=matches[0];
  return {optionExpiry:option.expiry,futureToken:future.token,futureExpiry:future.expiry!,specification:spec.id,source:spec.source,rule:'TWO_MCX_BUSINESS_DAYS_BEFORE_FUTURE_EXPIRY'};
}
