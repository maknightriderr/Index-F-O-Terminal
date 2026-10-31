import {getSessionWindow,type Instrument} from '@fno/shared';
import {assessFreshPlan,fitFreshParity,freshPremiumScenarios,freshRoundTripFees,freshRoundTripFeeBreakdown,type FreshCandidate,type FreshQuote,type FreshContract} from '@fno/analytics';
import type {FreshQualifiedAdapter,FreshPreparedCandidate} from './runtime.js';
import {FreshSharedFeed} from './feed.js';
import {FreshEventSource} from './event-source.js';
import {FreshPaperStore,type FreshEntryRequest} from './store.js';
import {freshExpirySessions} from './context.js';
import {freshFeePolicyFor} from './fees.js';
import {freshReferenceExchange,freshReferenceSpotId,freshEventMarket,type FreshReference} from './markets.js';
export type {FreshReference} from './markets.js';

export interface FreshAdapterPorts {
  references():ReadonlyMap<string,FreshReference>;master():readonly Instrument[];capital:number;
  legacyRisk():Promise<boolean>;
  audit:FreshQualifiedAdapter['audit'];refusal(c:FreshCandidate,code:string,evidence?:Record<string,unknown>):Promise<void>;
  watch:FreshQualifiedAdapter['watch'];now?:()=>number;
}
export class FreshProductionAdapter implements FreshQualifiedAdapter {
  readonly qualified=true;
  constructor(private feed:FreshSharedFeed,private events:FreshEventSource,private store:FreshPaperStore,private ports:FreshAdapterPorts){}
  audit:FreshQualifiedAdapter['audit']=(c,e)=>this.ports.audit(c,e);
  decision=(c:FreshCandidate,code:string)=>this.ports.refusal(c,code);
  watch:FreshQualifiedAdapter['watch']=(p,o)=>this.ports.watch(p,o);
  marks(rows:Awaited<ReturnType<FreshPaperStore['recover']>>){
    const marks:Record<string,FreshQuote>={};for(const row of rows){const tick=Number(row.state.contract.evidence?.tickSize);if(!(tick>0))continue;const q=this.feed.quote(row.state.contract.id,tick);if(q)marks[row.id]=q;}return marks;
  }
  async prepare(c:FreshCandidate):Promise<FreshPreparedCandidate|null>{
    let now=(this.ports.now??Date.now)();
    const reject=async(code:string)=>{await this.ports.refusal(c,code,{eventCalendar:ref?this.events.evidence(now,freshEventMarket(ref.market),ref.name):null});return null;},ref=this.ports.references().get(c.instrument),session=ref?getSessionWindow(freshReferenceExchange(ref),c.session):null;
    if(!ref||!session||c.sourceEpoch!==this.feed.sourceEpoch)return reject('BLOCKED_EXACT_REFERENCE');
    if(ref.capabilityBlockers?.length)return reject(ref.capabilityBlockers[0]);
    if(ref.market!=='NSE_INDEX_OPTIONS'&&ref.market!=='NSE_STOCK_OPTIONS')return reject('MARKET_PRODUCT_POLICY_NOT_QUALIFIED');
    const event=this.events.clearance(now,c.session,freshEventMarket(ref.market),ref.name);if(event)return reject(event);
    if(await this.ports.legacyRisk())return reject('LEGACY_POSITION_OR_INVENTORY_UNAVAILABLE');
    let signal=this.feed.underlying(ref.id),spot=this.feed.underlying(freshReferenceSpotId(ref));if(!signal||!spot)return reject('STALE_EXACT_REFERENCE');
    const market=ref.market,universe=this.ports.master().filter(x=>x.exchange==='NSE'&&x.segment==='FO'&&x.name===ref.name&&x.instrumentType===(market==='NSE_INDEX_OPTIONS'?'OPTIDX':'OPTSTK')&&x.expiry&&x.strike&&x.strike>0&&Number.isSafeInteger(x.lotSize)&&x.lotSize>0&&x.tickSize>0);
    const expiries=[...new Set(universe.map(x=>x.expiry!))].filter(d=>{const n=freshExpirySessions(c.session,d);return n!=null&&n>=(market==='NSE_INDEX_OPTIONS'?1:3)&&n<=(market==='NSE_INDEX_OPTIONS'?10:15);}).sort().slice(0,2);
    const spotPrice=spot.price;
    const strikes=[...new Set(universe.filter(x=>expiries.includes(x.expiry!)).map(x=>x.strike!))].sort((a,b)=>Math.abs(a-spotPrice)-Math.abs(b-spotPrice)||a-b).slice(0,5);
    const rows=await this.store.recover(),marks=this.marks(rows),accountId=`${c.version}:${c.session}`,account=await this.store.accountView(accountId,this.ports.capital,marks,now),eligible:{contract:FreshContract;rr:number;spread:number;tick:number}[]=[],refusals:{contract:string;code:string}[]=[];
    now=(this.ports.now??Date.now)();signal=this.feed.underlying(ref.id);spot=this.feed.underlying(freshReferenceSpotId(ref));if(!signal||!spot||now>c.expiresAt)return reject('STALE_PLAN_INPUTS');
    for(const expiry of expiries){
      const exact=(strike:number,side:string)=>{const xs=universe.filter(x=>x.expiry===expiry&&x.strike===strike&&x.optionType===side);return xs.length===1?xs[0]:null;};
      const pairs=strikes.flatMap(strike=>{const call=exact(strike,'CE'),put=exact(strike,'PE');if(!call||!put)return [];const cq=this.feed.quote(`NSE_FO:${call.token}`,call.tickSize),pq=this.feed.quote(`NSE_FO:${put.token}`,put.tickSize);return cq&&pq?[{strike,call:cq,put:pq}]:[];});
      const expirySession=getSessionWindow('NSE',expiry);if(!expirySession)continue;
      const basis=fitFreshParity(pairs,expirySession.close,now);if(!basis)continue;
      for(const strike of strikes){const side=c.direction==='BULLISH'?'CE':'PE',instrument=exact(strike,side);if(!instrument)continue;
        const selectedFees=freshFeePolicyFor(instrument,c.session);if(!selectedFees)continue;
        const units=instrument.contractUnits;if(!units?.quantityVerified||!units.tickVerified||units.brokerLotQuantity!==instrument.lotSize)continue;
        const q=this.feed.quote(`NSE_FO:${instrument.token}`,instrument.tickSize);if(!q)continue;
        const scenarios=freshPremiumScenarios({basis,quote:q,strike,side,signalKind:ref.signal.segment==='CM'?'SPOT':'FUTURES',signalPrice:signal.price,pricingSpot:spot.price,target:c.target,stop:c.stop,now,cutoff:session.close-600000});if(!scenarios)continue;
        const entry=q.ask+q.tick,explicit=freshRoundTripFees(entry,entry,instrument.lotSize,1,selectedFees.policy)/instrument.lotSize;
        const contract:FreshContract={id:q.contract,source:q.source,sourceEpoch:q.epoch,lotQuantity:instrument.lotSize,multiplier:1,expiryTradableSessions:freshExpirySessions(c.session,expiry)!,market,delta:scenarios.delta,metadataVerified:true,modelVerified:true,feesVerified:true,targetPremiumScenarios:scenarios.targetPremiumScenarios,invalidationPremiumScenarios:scenarios.invalidationPremiumScenarios,explicitRoundTripCostPerUnit:explicit,feePolicy:selectedFees.policy,evidence:{...scenarios.evidence,fees:{...selectedFees.evidence,flatPremiumRoundTripEstimate:freshRoundTripFeeBreakdown(entry,entry,instrument.lotSize,1,selectedFees.policy)},masterUnits:units,eventCalendar:this.events.evidence(now,freshEventMarket(market),ref.name),tickSize:instrument.tickSize,expiry,strike,side,signalReference:ref.id,spotReference:freshReferenceSpotId(ref)}};
        const plan=assessFreshPlan({candidate:c,contract,quote:q,account,now,arrivalAt:now+250,currentUnderlying:signal.price,cutoff:session.close,calendarVerified:true,eventClear:true,legacyPositionOpen:false,parentAlreadyTraded:false,correlatedPositionOpen:false,entriesToday:0,barsSinceLastClose:null});
        if(plan.ok)eligible.push({contract,rr:plan.riskRewardNet,spread:(q.ask-q.bid)/((q.ask+q.bid)/2),tick:q.tick});else refusals.push({contract:contract.id,code:plan.code});
      }
    }
    eligible.sort((a,b)=>b.rr-a.rr||a.spread-b.spread||a.contract.id.localeCompare(b.contract.id));const selected=eligible[0];if(!selected){const code=refusals.length&&refusals.every(r=>r.code===refusals[0].code)?refusals[0].code:'NO_ELIGIBLE_CONTRACT_MODEL_OR_PAYOFF';await this.ports.refusal(c,code,{refusals,strikes,expiries,eventCalendar:this.events.evidence(now,freshEventMarket(ref.market),ref.name)});return null;}
    return {candidate:c,netRR:selected.rr,finish:async()=>{
      const arrivalAt=Math.max(c.at,(this.ports.now??Date.now)())+250,q=await this.feed.firstAsk(selected.contract.id,selected.tick,arrivalAt,c.expiresAt);if(!q)return reject('ENTRY_QUOTE_DEADLINE');
      const underlying=this.feed.underlyingAt(ref.id,q.receivedAt);if(!underlying)return reject('MISSING_ARRIVAL_REFERENCE');
      const code=this.events.clearance(q.receivedAt,c.session,freshEventMarket(market),ref.name);if(code)return reject(code);
      const legacyPositionOpen=await this.ports.legacyRisk();
      return {accountId,session:c.session,capital:this.ports.capital,riskGroup:ref.riskGroup,candidate:c,contract:{...selected.contract,evidence:{...selected.contract.evidence,eventCalendar:this.events.evidence(q.receivedAt,freshEventMarket(market),ref.name)}},quote:q,now:(this.ports.now??Date.now)(),arrivalAt,currentUnderlying:underlying.price,cutoff:session.close,calendarVerified:true,eventClear:true,legacyPositionOpen,marks:this.marks(await this.store.recover())};
    }};
  }
  async build(c:FreshCandidate):Promise<FreshEntryRequest|null>{return (await this.prepare(c))?.finish()??null;}
}
