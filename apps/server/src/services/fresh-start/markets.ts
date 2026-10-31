import {CM_SEGMENT,FO_SEGMENT,KNOWN_INDEX_TOKENS,SECTOR_MAP,type Exchange,type ExchangeSegment,type Instrument} from '@fno/shared';
export const FRESH_MARKETS=['NSE_INDEX_OPTIONS','NSE_STOCK_OPTIONS','BSE_VERIFIED_OPTIONS','MCX_VERIFIED_FUTURES_OPTIONS'] as const;
export type FreshMarket=typeof FRESH_MARKETS[number];
export interface FreshReference {
  id:string;name:string;signal:Instrument;spot:{token:string;exchangeSegment:ExchangeSegment};
  market:FreshMarket;riskGroup:string;exchange?:Exchange;
  /** Static capability failures are explicit; dynamic books/events are checked separately. */
  capabilityBlockers?:string[];
}
export const freshMarketExchange=(market:FreshMarket):Exchange=>market.startsWith('BSE')?'BSE':market.startsWith('MCX')?'MCX':'NSE';
export const freshReferenceExchange=(ref:FreshReference)=>ref.exchange??freshMarketExchange(ref.market);
export const freshReferenceSpotId=(ref:FreshReference)=>`${ref.spot.exchangeSegment}:${ref.spot.token}`;
export const freshOptionType=(market:FreshMarket)=>market==='NSE_STOCK_OPTIONS'?'OPTSTK':market==='MCX_VERIFIED_FUTURES_OPTIONS'?'OPTFUT':'OPTIDX';
export function freshMarketBlockers(market:FreshMarket):string[]{
  // Issuer/action coverage is dynamic and checked by the event-source adapter.
  if(market==='BSE_VERIFIED_OPTIONS')return ['BLOCKED_BSE_PRODUCT_AND_EXPIRY_POLICY'];
  if(market==='MCX_VERIFIED_FUTURES_OPTIONS')return ['BLOCKED_MCX_EXACT_OPTION_FUTURES_LINK','BLOCKED_MCX_BOOK_QUANTITY_UNITS','BLOCKED_MCX_PRODUCT_AND_EXPIRY_POLICY'];
  return [];
}
export function freshBookSupportsLot(instrument:Instrument,q:{bidUnits:number;askUnits:number}|null){const u=instrument.contractUnits;return !!q&&u?.quantityVerified===true&&u.tickVerified&&u.brokerLotQuantity>0&&q.bidUnits>=u.brokerLotQuantity&&q.askUnits>=u.brokerLotQuantity;}
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
      if(market==='MCX_VERIFIED_FUTURES_OPTIONS'&&!['CRUDEOIL','GOLD','SILVER','NATURALGAS'].includes(name))continue;
      counts[market]++;
      const stock=market==='NSE_STOCK_OPTIONS',commodity=exchange==='MCX';
      const candidates=master.filter(x=>x.exchange===exchange&&x.name===name&&(stock?x.segment==='CM'&&x.instrumentType==='EQ'&&x.symbol===`${name}-EQ`:active(x)&&x.instrumentType===(commodity?'FUTCOM':'FUTIDX'))).sort((a,b)=>(a.expiry??'').localeCompare(b.expiry??'')||a.token.localeCompare(b.token));
      const signal=candidates[0];
      if(!signal||(stock&&candidates.length!==1)||(!stock&&candidates.filter(x=>x.expiry===signal.expiry).length!==1)){unmapped.push({name,market,code:'BLOCKED_EXACT_SIGNAL_REFERENCE'});continue;}
      // A nearest MCX future is an indicative discovery reference only, never an option-underlying link.
      const spotCandidates=commodity?[signal]:stock?[signal]:master.filter(x=>x.exchange===exchange&&x.segment==='CM'&&x.instrumentType==='INDEX'&&x.name===name);
      if(spotCandidates.length>1){unmapped.push({name,market,code:'BLOCKED_AMBIGUOUS_PRICING_REFERENCE'});continue;}
      const spot=spotCandidates.length===1?{token:spotCandidates[0].token,exchangeSegment:CM_SEGMENT[exchange]}:!stock&&!commodity&&KNOWN_INDEX_TOKENS[name]?{token:KNOWN_INDEX_TOKENS[name],exchangeSegment:CM_SEGMENT[exchange]}:null;
      if(!spot){unmapped.push({name,market,code:'BLOCKED_EXACT_PRICING_REFERENCE'});continue;}
      const sector=stock?freshSector(name):null,blockers:string[]=freshMarketBlockers(market);
      if(stock&&!sector)blockers.push('BLOCKED_SECTOR_MAPPING');
      if(name==='NIFTYFPI')blockers.push('BLOCKED_PRODUCT_SPECIFIC_FEE_POLICY');
      references.push({id:`${stock?CM_SEGMENT[exchange]:FO_SEGMENT[exchange]}:${signal.token}`,name,signal,spot,exchange,market,riskGroup:stock?`NSE_SECTOR:${sector??'UNMAPPED'}`:commodity?`MCX:${name}`:'NSE_INDEX_CORRELATED',capabilityBlockers:blockers});
    }
  }
  return {references:references.sort((a,b)=>FRESH_MARKETS.indexOf(a.market)-FRESH_MARKETS.indexOf(b.market)||a.name.localeCompare(b.name)),unmapped,counts};
}
/** Round-robin bounded discovery. All symbols remain in the universe; only a bounded window receives expensive history/options work. */
export function freshDiscoveryWindow(refs:readonly FreshReference[],cursor:number,limit=20){
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('INVALID_DISCOVERY_LIMIT');
  const limits:Record<FreshMarket,number>={NSE_INDEX_OPTIONS:6,NSE_STOCK_OPTIONS:7,BSE_VERIFIED_OPTIONS:3,MCX_VERIFIED_FUTURES_OPTIONS:4};
  const selected:FreshReference[]=[];
  for(const market of FRESH_MARKETS){const group=refs.filter(r=>r.market===market),n=Math.min(group.length,limits[market],limit-selected.length),start=group.length?((cursor%group.length)+group.length)%group.length:0;
    for(let i=0;i<n;i++)selected.push(group[(start+i)%group.length]);}
  return {selected,nextCursor:cursor+7};
}
/** Both sides support diagnostics/parity; selection remains at most five strikes and two expiries. */
export function freshReferenceOptions(master:readonly Instrument[],ref:FreshReference,day:string,price:number|null){
  if(price==null||!Number.isFinite(price)||price<=0)return [];
  const exchange=freshReferenceExchange(ref),rows=master.filter(x=>x.exchange===exchange&&x.segment==='FO'&&x.name===ref.name&&x.instrumentType===freshOptionType(ref.market)&&x.expiry&&x.expiry>day&&x.strike!=null&&x.strike>0&&Number.isSafeInteger(x.lotSize)&&x.lotSize>0&&Number.isFinite(x.tickSize)&&x.tickSize>0);
  const expiries=[...new Set(rows.map(x=>x.expiry!))].sort().slice(0,2),strikes=[...new Set(rows.filter(x=>expiries.includes(x.expiry!)).map(x=>x.strike!))].sort((a,b)=>Math.abs(a-price)-Math.abs(b-price)||a-b).slice(0,5);
  return rows.filter(x=>expiries.includes(x.expiry!)&&strikes.includes(x.strike!)&&['CE','PE'].includes(x.optionType??'')).slice(0,20);
}
