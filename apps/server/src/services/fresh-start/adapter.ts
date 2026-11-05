import {getSessionWindow,FO_SEGMENT,type Instrument} from '@fno/shared';
import {assessFreshPlan,FRESH_MONTHLY_MAX_EXPIRY_SESSIONS,fitFreshParity,fitFreshFuturesParity,freshFuturesPremiumScenarios,freshPremiumScenarios,freshRoundTripFees,freshRoundTripFeeBreakdown,type FreshCandidate,type FreshQuote,type FreshContract} from '@fno/analytics';
import type {FreshQualifiedAdapter,FreshPreparedCandidate} from './runtime.js';
import {FreshSharedFeed} from './feed.js';
import {FreshEventSource} from './event-source.js';
import {FreshPaperStore,type FreshEntryRequest} from './store.js';
import {freshExpirySessions} from './context.js';
import {freshFeePolicyFor} from './fees.js';
import {freshContractUnits} from './contract-units.js';
import {freshBsePaperPolicyApproved,FRESH_BSE_PAPER_PROPOSAL} from './bse-policy.js';
import {freshMcxPaperPolicyApproved,FRESH_MCX_PAPER_PROPOSAL} from './mcx-policy.js';
import {resolveFreshMcxLink} from './mcx-contracts.js';
import {freshReferenceExchange,freshReferenceSpotId,freshEventMarket,type FreshReference} from './markets.js';
export type {FreshReference} from './markets.js';

export interface FreshAdapterPorts {
  references():ReadonlyMap<string,FreshReference>;master():readonly Instrument[];capital:number;
  legacyRisk():Promise<boolean>;
  audit:FreshQualifiedAdapter['audit'];refusal(c:FreshCandidate,code:string,evidence?:Record<string,unknown>):Promise<void>;
  watch:FreshQualifiedAdapter['watch'];now?:()=>number;
  /** IV rank (0–100) of the underlying's ATM IV over its recorded year, or null when the history is too short. */
  ivRank?(name:string,expiry:string,ivPct:number):Promise<number|null>;
}
/** 1.5 IV filter: buying premium at the top of its own year invites IV crush; no entry at or above this rank. */
export const FRESH_MAX_IV_RANK=80;
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
    const bse=ref.market==='BSE_VERIFIED_OPTIONS',mcx=ref.market==='MCX_VERIFIED_FUTURES_OPTIONS';
    if(bse&&(!freshBsePaperPolicyApproved()||!FRESH_BSE_PAPER_PROPOSAL.products.includes(ref.name)))return reject('MARKET_PRODUCT_POLICY_NOT_QUALIFIED');
    if(mcx&&(!freshMcxPaperPolicyApproved()||!FRESH_MCX_PAPER_PROPOSAL.products.includes(ref.name)))return reject('MARKET_PRODUCT_POLICY_NOT_QUALIFIED');
    if(ref.market!=='NSE_INDEX_OPTIONS'&&ref.market!=='NSE_STOCK_OPTIONS'&&!bse&&!mcx)return reject('MARKET_PRODUCT_POLICY_NOT_QUALIFIED');
    const exchange=freshReferenceExchange(ref),segment=FO_SEGMENT[exchange];
    if(bse&&(ref.signal.exchange!=='BSE'||ref.id!==`${segment}:${ref.signal.token}`||ref.spot.exchangeSegment!=='BSE_CM'))return reject('BLOCKED_EXACT_REFERENCE');
    if(mcx&&(ref.signal.exchange!=='MCX'||ref.signal.instrumentType!=='FUTCOM'||ref.id!==`${segment}:${ref.signal.token}`||freshReferenceSpotId(ref)!==ref.id))return reject('BLOCKED_EXACT_REFERENCE');
    const event=this.events.clearance(now,c.session,freshEventMarket(ref.market),ref.name);if(event)return reject(event);
    if(await this.ports.legacyRisk())return reject('LEGACY_POSITION_OR_INVENTORY_UNAVAILABLE');
    let signal=this.feed.underlying(ref.id),spot=this.feed.underlying(freshReferenceSpotId(ref));if(!signal||!spot)return reject('STALE_EXACT_REFERENCE');
    const market=ref.market,master=this.ports.master(),futureMaster=mcx?master.filter(x=>x.exchange==='MCX'&&x.name===ref.name&&x.instrumentType==='FUTCOM'):[],universe=master.filter(x=>x.exchange===exchange&&x.segment==='FO'&&x.name===ref.name&&x.instrumentType===(mcx?'OPTFUT':market==='NSE_STOCK_OPTIONS'?'OPTSTK':'OPTIDX')&&x.expiry&&x.strike&&x.strike>0&&Number.isSafeInteger(x.lotSize)&&x.lotSize>0&&x.tickSize>0&&(!mcx||resolveFreshMcxLink(x,futureMaster)?.futureToken===ref.signal.token));
    // Nearest expiries inside the market's standard window (NSE index 1-10, stocks 3-15, BSE 1-10, MCX 3-15 sessions).
    // A monthly-only product has none in the first half of its cycle (5 Nov: BANKNIFTY / FINNIFTY setups refused with
    // expiries [] - next expiry 23 Nov, 12 sessions away), so it then takes its single nearest expiry up to
    // FRESH_MONTHLY_MAX_EXPIRY_SESSIONS: the only listed series, with less time decay than a weekly.
    const minSessions=mcx?FRESH_MCX_PAPER_PROPOSAL.minimumExpirySessions:bse?FRESH_BSE_PAPER_PROPOSAL.minimumExpirySessions:market==='NSE_STOCK_OPTIONS'?3:1,maxSessions=mcx?FRESH_MCX_PAPER_PROPOSAL.maximumExpirySessions:bse?FRESH_BSE_PAPER_PROPOSAL.maximumExpirySessions:market==='NSE_STOCK_OPTIONS'?15:10;
    const listed=[...new Set(universe.map(x=>x.expiry!))].map(d=>({d,n:freshExpirySessions(c.session,d,exchange)})).filter((x):x is {d:string;n:number}=>x.n!=null&&x.n>=minSessions&&x.n<=FRESH_MONTHLY_MAX_EXPIRY_SESSIONS).sort((a,b)=>a.d.localeCompare(b.d));
    const standard=listed.filter(x=>x.n<=maxSessions),expiries=(standard.length?standard.slice(0,2):listed.slice(0,1)).map(x=>x.d);
    const spotPrice=spot.price;
    const strikes=[...new Set(universe.filter(x=>expiries.includes(x.expiry!)).map(x=>x.strike!))].sort((a,b)=>Math.abs(a-spotPrice)-Math.abs(b-spotPrice)||a-b).slice(0,5);
    const rows=await this.store.recover(),marks=this.marks(rows),accountId=`${c.version}:${c.session}`,account=await this.store.accountView(accountId,this.ports.capital,marks,now),eligible:{contract:FreshContract;rr:number;spread:number;tick:number;iv:number|null;expiry:string}[]=[],refusals:{contract:string;code:string}[]=[];
    now=(this.ports.now??Date.now)();signal=this.feed.underlying(ref.id);spot=this.feed.underlying(freshReferenceSpotId(ref));if(!signal||!spot||now>c.expiresAt)return reject('STALE_PLAN_INPUTS');
    for(const expiry of expiries){
      const exact=(strike:number,side:string)=>{const xs=universe.filter(x=>x.expiry===expiry&&x.strike===strike&&x.optionType===side);return xs.length===1?xs[0]:null;};
      const pairs=strikes.flatMap(strike=>{const call=exact(strike,'CE'),put=exact(strike,'PE');if(!call||!put)return [];const cq=this.feed.quote(`${segment}:${call.token}`,call.tickSize),pq=this.feed.quote(`${segment}:${put.token}`,put.tickSize);return cq&&pq?[{strike,call:cq,put:pq}]:[];});
      const expirySession=getSessionWindow(exchange,expiry);if(!expirySession)continue;
      const future=mcx?this.feed.futuresObservation(ref.id,ref.signal.tickSize):null;
      const basis=mcx?(future?fitFreshFuturesParity(pairs,future,expirySession.close,now):null):fitFreshParity(pairs,expirySession.close,now);if(!basis)continue;
      for(const strike of strikes){const side=c.direction==='BULLISH'?'CE':'PE',instrument=exact(strike,side);if(!instrument)continue;
        const selectedFees=freshFeePolicyFor(instrument,c.session);if(!selectedFees)continue;
        const sizing=freshContractUnits(instrument);if(!sizing)continue;
        const units=instrument.contractUnits!;
        const q=this.feed.quote(`${segment}:${instrument.token}`,instrument.tickSize);if(!q)continue;
        const scenarios=mcx?(future&&'futureContract' in basis?freshFuturesPremiumScenarios({basis:basis as import('@fno/analytics').FreshFuturesParityBasis,future,quote:q,strike,side,target:c.target,stop:c.stop,now,cutoff:session.close-600000}):null):freshPremiumScenarios({basis,quote:q,strike,side,signalKind:ref.signal.segment==='CM'?'SPOT':'FUTURES',signalPrice:signal.price,pricingSpot:spot.price,target:c.target,stop:c.stop,now,cutoff:session.close-600000});if(!scenarios)continue;
        const entry=q.ask+q.tick,explicit=freshRoundTripFees(entry,entry,sizing.lotQuantity,sizing.multiplier,selectedFees.policy)/sizing.premiumUnitsPerLot;
        const contract:FreshContract={id:q.contract,source:q.source,sourceEpoch:q.epoch,lotQuantity:sizing.lotQuantity,multiplier:sizing.multiplier,expiryTradableSessions:freshExpirySessions(c.session,expiry,exchange)!,market,...(mcx?{marketPolicy:FRESH_MCX_PAPER_PROPOSAL.id}:bse?{marketPolicy:FRESH_BSE_PAPER_PROPOSAL.id}:{}),delta:scenarios.delta,metadataVerified:true,modelVerified:true,feesVerified:true,targetPremiumScenarios:scenarios.targetPremiumScenarios,invalidationPremiumScenarios:scenarios.invalidationPremiumScenarios,explicitRoundTripCostPerUnit:explicit,feePolicy:selectedFees.policy,evidence:{...scenarios.evidence,fees:{...selectedFees.evidence,flatPremiumRoundTripEstimate:freshRoundTripFeeBreakdown(entry,entry,sizing.lotQuantity,sizing.multiplier,selectedFees.policy)},masterUnits:units,...(mcx?{optionFuturesLink:resolveFreshMcxLink(instrument,futureMaster)}:{}),sizingUnits:sizing,eventCalendar:this.events.evidence(now,freshEventMarket(market),ref.name),tickSize:instrument.tickSize,expiry,strike,side,underlying:ref.name,signalReference:ref.id,spotReference:freshReferenceSpotId(ref)}};
        const plan=assessFreshPlan({candidate:c,contract,quote:q,account,now,arrivalAt:now+250,currentUnderlying:signal.price,cutoff:session.close,calendarVerified:true,eventClear:true,legacyPositionOpen:false,parentAlreadyTraded:false,correlatedPositionOpen:false,entriesToday:0,barsSinceLastClose:null});
        if(plan.ok){const iv=(scenarios as {iv?:number}).iv;eligible.push({contract,rr:plan.riskRewardNet,spread:(q.ask-q.bid)/((q.ask+q.bid)/2),tick:q.tick,iv:typeof iv==='number'&&Number.isFinite(iv)&&iv>0?iv:null,expiry});}else refusals.push({contract:contract.id,code:plan.code});
      }
    }
    eligible.sort((a,b)=>b.rr-a.rr||a.spread-b.spread||a.contract.id.localeCompare(b.contract.id));const selected=eligible[0];if(!selected){const code=refusals.length&&refusals.every(r=>r.code===refusals[0].code)?refusals[0].code:'NO_ELIGIBLE_CONTRACT_MODEL_OR_PAYOFF';await this.ports.refusal(c,code,{refusals,strikes,expiries,eventCalendar:this.events.evidence(now,freshEventMarket(ref.market),ref.name)});return null;}
    // IV filter: the selected contract's own IV (the strikes are near the money) ranked against the underlying's year.
    const ivPct=selected.iv!=null?selected.iv*100:null,ivRank=ivPct!=null&&this.ports.ivRank?await this.ports.ivRank(ref.name,selected.expiry,ivPct).catch(()=>null):null;
    if(ivRank!=null&&ivRank>=FRESH_MAX_IV_RANK){await this.ports.refusal(c,'IV_RANK_TOO_HIGH',{ivRank,ivPct,maxIvRank:FRESH_MAX_IV_RANK,contract:selected.contract.id});return null;}
    selected.contract={...selected.contract,evidence:{...selected.contract.evidence,ivPct,ivRank:ivRank??'UNAVAILABLE'}};
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
