import {CM_SEGMENT,FO_SEGMENT,KNOWN_INDEX_TOKENS,SECTOR_MAP,type Exchange,type ExchangeSegment,type Instrument} from '@fno/shared';
import {resolveFreshMcxLink,type FreshMcxLink} from './mcx-contracts.js';
import {freshFeePolicyFor} from './fees.js';
import {freshContractUnits} from './contract-units.js';
import {freshBsePaperPolicyApproved} from './bse-policy.js';
import {freshMcxPaperPolicyApproved} from './mcx-policy.js';
/** 1.5: the mini energy contracts fit the INR 5,00,000 account's per-trade risk; the full-size lots never do. */
/** Option-chain names whose index token is listed under another key (NSE options say NIFTYNXT50, the index table NIFTYNEXT50). */
/** Index name comparison key: upper case, letters and digits only. */
export const freshIndexKey=(s:string|null|undefined)=>(s??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
export const FRESH_INDEX_TOKEN_ALIASES:Readonly<Record<string,string>>={NIFTYNXT50:'NIFTYNEXT50'};
/** Index option names the owner left out of scope (2 Nov): no Angel One spot row exists for them, and only SENSEX is wanted on BSE. */
export const FRESH_EXCLUDED_INDEX_NAMES:readonly string[]=['SENSEX50','NIFTYFPI','FOCIT'];
export const FRESH_MCX_PRODUCTS:readonly string[]=['CRUDEOIL','CRUDEOILM','GOLD','SILVER','NATURALGAS','NATGASMINI'];
export const FRESH_MARKETS=['NSE_INDEX_OPTIONS','NSE_STOCK_OPTIONS','BSE_VERIFIED_OPTIONS','MCX_VERIFIED_FUTURES_OPTIONS'] as const;
export type FreshMarket=typeof FRESH_MARKETS[number];
export interface FreshReference {
  id:string;name:string;signal:Instrument;spot:{token:string;exchangeSegment:ExchangeSegment};
  market:FreshMarket;riskGroup:string;exchange?:Exchange;
  /** Static capability failures are explicit; dynamic books/events are checked separately. */
  capabilityBlockers?:string[];
  mcxLinks?:FreshMcxLink[];
}
export const freshMarketExchange=(market:FreshMarket):Exchange=>market.startsWith('BSE')?'BSE':market.startsWith('MCX')?'MCX':'NSE';
export const freshReferenceExchange=(ref:FreshReference)=>ref.exchange??freshMarketExchange(ref.market);
export const freshReferenceSpotId=(ref:FreshReference)=>`${ref.spot.exchangeSegment}:${ref.spot.token}`;
export const freshOptionType=(market:FreshMarket)=>market==='NSE_STOCK_OPTIONS'?'OPTSTK':market==='MCX_VERIFIED_FUTURES_OPTIONS'?'OPTFUT':'OPTIDX';
export function freshMarketBlockers(market:FreshMarket):string[]{
  // Issuer/action coverage is dynamic and checked by the event-source adapter.
  if(market==='BSE_VERIFIED_OPTIONS')return freshBsePaperPolicyApproved()?[]:['BLOCKED_BSE_PRODUCT_AND_EXPIRY_POLICY'];
  if(market==='MCX_VERIFIED_FUTURES_OPTIONS')return ['BLOCKED_MCX_EXACT_OPTION_FUTURES_LINK','BLOCKED_MCX_BOOK_QUANTITY_UNITS',...(freshMcxPaperPolicyApproved()?[]:['BLOCKED_MCX_PRODUCT_AND_EXPIRY_POLICY'])];
  return [];
}
export function freshBookSupportsLot(instrument:Instrument,q:{bidUnits:number;askUnits:number}|null){const u=freshContractUnits(instrument);return !!q&&!!u&&Number.isSafeInteger(q.bidUnits)&&Number.isSafeInteger(q.askUnits)&&q.bidUnits>=u.lotQuantity&&q.askUnits>=u.lotQuantity;}
export const freshEventMarket=(market:FreshMarket)=>market==='NSE_STOCK_OPTIONS'?'STOCK':market==='MCX_VERIFIED_FUTURES_OPTIONS'?'COMMODITY':'INDEX';
export function freshSector(name:string):string|null {
  const matches=Object.entries(SECTOR_MAP).filter(([,symbols])=>symbols.includes(name)).map(([sector])=>sector);
  return matches.length===1?matches[0]:null;
}
export interface FreshDiscovery {references:FreshReference[];unmapped:Array<{name:string;market:FreshMarket;code:string}>;counts:Record<FreshMarket,number>;}
/** Master membership establishes today's discoverable universe, never historical membership or liquidity. */
export function discoverFreshMarkets(master:readonly Instrument[],day:string):FreshDiscovery {
  const references:FreshReference[]=[],unmapped:FreshDiscovery['unmapped']=[],counts=Object.fromEntries(FRESH_MARKETS.map(m=>[m,0])) as Record<FreshMarket,number>;
  const active=(x:Instrument)=>x.segment==='FO'&&!!x.expiry&&x.expiry>day&&Number.isSafeInteger(x.lotSize)&&x.lotSize>0&&Number.isFinite(x.tickSize)&&x.tickSize>0;
  for(const market of FRESH_MARKETS){
    const exchange=freshMarketExchange(market),optionType=freshOptionType(market),names=[...new Set(master.filter(x=>active(x)&&x.exchange===exchange&&x.instrumentType===optionType).map(x=>x.name))].sort();
    for(const name of names){
      if(market==='MCX_VERIFIED_FUTURES_OPTIONS'&&!FRESH_MCX_PRODUCTS.includes(name))continue;
      if(FRESH_EXCLUDED_INDEX_NAMES.includes(name))continue;
      counts[market]++;
      const stock=market==='NSE_STOCK_OPTIONS',commodity=exchange==='MCX';
      const candidates=master.filter(x=>x.exchange===exchange&&x.name===name&&(stock?x.segment==='CM'&&x.instrumentType==='EQ'&&x.symbol===`${name}-EQ`:active(x)&&x.instrumentType===(commodity?'FUTCOM':'FUTIDX'))).sort((a,b)=>(a.expiry??'').localeCompare(b.expiry??'')||a.token.localeCompare(b.token));
      const linkedCommodity=commodity;
      const commodityExpiries=linkedCommodity?[...new Map(master.filter(x=>active(x)&&x.exchange==='MCX'&&x.name===name&&x.instrumentType==='OPTFUT'&&['CE','PE'].includes(x.optionType??'')).map(x=>[`${x.expiry}:${x.tickSize}`,x])).values()]:[];
      const links=commodityExpiries.map(x=>resolveFreshMcxLink(x,candidates)).filter((x):x is FreshMcxLink=>x!==null);
      const linkedTokens=new Set(links.map(x=>x.futureToken));
      const signal=linkedCommodity?candidates.find(x=>linkedTokens.has(x.token)):candidates[0];
      if(linkedCommodity&&!signal){unmapped.push({name,market,code:'BLOCKED_MCX_EXACT_OPTION_FUTURES_LINK'});continue;}
      if(!signal||(stock&&candidates.length!==1)||(!stock&&candidates.filter(x=>x.expiry===signal.expiry).length!==1)){unmapped.push({name,market,code:'BLOCKED_EXACT_SIGNAL_REFERENCE'});continue;}
      // Each commodity option slice, signal history and pricing reference share its exact linked future.
      // Pricing reference, most trusted first: the verified KNOWN_INDEX_TOKENS table, then a unique master index row
      // with the same name, then a unique one whose name/symbol matches once spaces and punctuation are removed (the
      // master may list e.g. "SENSEX 50" for options named SENSEX50). Never a guessed token.
      const indexKey=FRESH_INDEX_TOKEN_ALIASES[name]??name;
      const masterIndex=(match:(x:Instrument)=>boolean)=>master.filter(x=>x.exchange===exchange&&x.segment==='CM'&&x.instrumentType==='INDEX'&&match(x));
      let spot:{token:string;exchangeSegment:ExchangeSegment}|null=null;
      if(commodity||stock)spot={token:signal.token,exchangeSegment:CM_SEGMENT[exchange]};
      else if(KNOWN_INDEX_TOKENS[indexKey])spot={token:KNOWN_INDEX_TOKENS[indexKey],exchangeSegment:CM_SEGMENT[exchange]};
      else{
        const exact=masterIndex(x=>x.name===name),loose=exact.length?exact:masterIndex(x=>freshIndexKey(x.name)===freshIndexKey(name)||freshIndexKey(x.symbol)===freshIndexKey(name));
        if(loose.length>1){unmapped.push({name,market,code:'BLOCKED_AMBIGUOUS_PRICING_REFERENCE'});continue;}
        if(loose.length===1)spot={token:loose[0].token,exchangeSegment:CM_SEGMENT[exchange]};
      }
      if(!spot){unmapped.push({name,market,code:'BLOCKED_EXACT_PRICING_REFERENCE'});continue;}
      const sector=stock?freshSector(name):null,blockers:string[]=freshMarketBlockers(market);
      if(linkedCommodity){blockers.splice(blockers.indexOf('BLOCKED_MCX_EXACT_OPTION_FUTURES_LINK'),1);if(master.filter(x=>active(x)&&x.exchange==='MCX'&&x.name===name&&x.instrumentType==='OPTFUT').some(x=>freshContractUnits(x)&&resolveFreshMcxLink(x,candidates)?.futureToken===signal.token))blockers.splice(blockers.indexOf('BLOCKED_MCX_BOOK_QUANTITY_UNITS'),1);}
      // An unmapped stock is not blocked: it shares one conservative risk group (NSE_SECTOR:UNMAPPED) with every other
      // unmapped stock, so the per-group concentration limit treats them all as one correlated sector.
      if(!freshFeePolicyFor({exchange,segment:'FO',instrumentType:optionType,name},day))blockers.push('BLOCKED_PRODUCT_SPECIFIC_FEE_POLICY');
      references.push({id:`${stock?CM_SEGMENT[exchange]:FO_SEGMENT[exchange]}:${signal.token}`,name,signal,spot,exchange,market,riskGroup:stock?`NSE_SECTOR:${sector??'UNMAPPED'}`:commodity?`MCX:${name}`:'NSE_INDEX_CORRELATED',capabilityBlockers:blockers,...(linkedCommodity?{mcxLinks:[...new Map(links.filter(x=>x.futureToken===signal.token).map(x=>[x.optionExpiry,x])).values()]}:{})});
    }
  }
  return {references:references.sort((a,b)=>FRESH_MARKETS.indexOf(a.market)-FRESH_MARKETS.indexOf(b.market)||a.name.localeCompare(b.name)),unmapped,counts};
}
/**
 * NSE stock references ordered by today's activity, most active first: the absolute % move from the previous close,
 * ties broken by traded value. Only references with a live quote (volume > 0) are ranked; the rest keep their order
 * after them. 4 Nov: round-robin gave each of ~200 F&O stocks about one hour a day, mostly not when it moved.
 */
export function freshRankStocks(refs:readonly FreshReference[],quotes:ReadonlyMap<string,{ltp:number;close:number;volume:number;percentChange?:number}>):FreshReference[]{
  const score=(r:FreshReference)=>{const q=quotes.get(r.signal.token);if(!q||!(q.volume>0)||!(q.ltp>0))return null;const pct=Number.isFinite(q.percentChange)?Math.abs(q.percentChange!):q.close>0?Math.abs((q.ltp-q.close)/q.close*100):0;return {pct,value:q.ltp*q.volume};};
  const scored=refs.map((r,i)=>({r,i,s:score(r)}));
  return scored.sort((a,b)=>a.s&&b.s?b.s.pct-a.s.pct||b.s.value-a.s.value:a.s?-1:b.s?1:a.i-b.i).map(x=>x.r);
}
/** Round-robin bounded discovery. All symbols remain in the universe; only a bounded window receives expensive history/options work. */
export function freshDiscoveryWindow(refs:readonly FreshReference[],cursor:number,limit=20){
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('INVALID_DISCOVERY_LIMIT');
  const limits:Record<FreshMarket,number>={NSE_INDEX_OPTIONS:6,NSE_STOCK_OPTIONS:7,BSE_VERIFIED_OPTIONS:3,MCX_VERIFIED_FUTURES_OPTIONS:6};
  const selected:FreshReference[]=[];
  for(const market of FRESH_MARKETS){const group=refs.filter(r=>r.market===market),n=Math.min(group.length,limits[market],limit-selected.length),start=group.length?((cursor%group.length)+group.length)%group.length:0;
    for(let i=0;i<n;i++)selected.push(group[(start+i)%group.length]);}
  return {selected,nextCursor:cursor+7};
}
/** Both sides support diagnostics/parity; selection remains at most five strikes and two expiries. */
export function freshReferenceOptions(master:readonly Instrument[],ref:FreshReference,day:string,price:number|null){
  if(price==null||!Number.isFinite(price)||price<=0)return [];
  const exchange=freshReferenceExchange(ref),rows=master.filter(x=>x.exchange===exchange&&x.segment==='FO'&&x.name===ref.name&&x.instrumentType===freshOptionType(ref.market)&&x.expiry&&x.expiry>day&&x.strike!=null&&x.strike>0&&Number.isSafeInteger(x.lotSize)&&x.lotSize>0&&Number.isFinite(x.tickSize)&&x.tickSize>0);
  const linked=ref.mcxLinks?rows.filter(x=>ref.mcxLinks!.some(link=>link.optionExpiry===x.expiry&&link.futureToken===ref.signal.token)):rows;
  const expiries=[...new Set(linked.map(x=>x.expiry!))].sort().slice(0,2),strikes=[...new Set(linked.filter(x=>expiries.includes(x.expiry!)).map(x=>x.strike!))].sort((a,b)=>Math.abs(a-price)-Math.abs(b-price)||a-b).slice(0,5);
  return linked.filter(x=>expiries.includes(x.expiry!)&&strikes.includes(x.strike!)&&['CE','PE'].includes(x.optionType??'')&&(!ref.mcxLinks||resolveFreshMcxLink(x,master)?.futureToken===ref.signal.token)).slice(0,20);
}

/** The stocks the event rules let trade now; all of them when none is clear (an issuer source down), as before. */
export function freshEventClearStocks<T>(stocks:readonly T[],isClear:(s:T)=>boolean):T[]{const clear=stocks.filter(isClear);return clear.length?clear:[...stocks];}
