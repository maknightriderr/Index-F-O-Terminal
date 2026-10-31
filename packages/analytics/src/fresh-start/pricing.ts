import {blackScholesPrice,calculateIV,calculateGreeks} from '../greeks/index.js';
import type {FreshQuote} from './paper.js';
export interface ParityPair {strike:number;call:FreshQuote;put:FreshQuote;}
export interface FreshParityBasis {forward:number;discount:number;expiryAt:number;at:number;epoch:string;source:string;strikes:number[];}
/** European parity C-P=D(F-K); the caller verifies exact underlying and expiry identity from the master. */
export function fitFreshParity(pairs:readonly ParityPair[],expiryAt:number,now:number):FreshParityBasis|null {
  if(pairs.length<3||pairs.length>5||!Number.isFinite(expiryAt)||expiryAt<=now)return null;
  const a=[...pairs].sort((x,y)=>x.strike-y.strike),quotes=a.flatMap(x=>[x.call,x.put]);
  if(new Set(a.map(x=>x.strike)).size!==a.length||new Set(quotes.map(x=>x.epoch)).size!==1||new Set(quotes.map(x=>x.source)).size!==1)return null;
  if(quotes.some(q=>![q.bid,q.ask,q.tick,q.eventAt,q.receivedAt].every(Number.isFinite)||q.tick<=0||q.bid<=0||q.ask<q.bid||!Number.isSafeInteger(q.bidUnits)||!Number.isSafeInteger(q.askUnits)||q.bidUnits<=0||q.askUnits<=0||q.eventAt>q.receivedAt||q.receivedAt>now||now-q.eventAt>2000)||Math.max(...quotes.map(q=>q.eventAt))-Math.min(...quotes.map(q=>q.eventAt))>1000)return null;
  const xs=a.map(x=>x.strike),ys=a.map(x=>(x.call.bid+x.call.ask-x.put.bid-x.put.ask)/2);
  if(xs.some(x=>!Number.isFinite(x)||x<=0))return null;
  const mx=xs.reduce((s,x)=>s+x,0)/xs.length,my=ys.reduce((s,x)=>s+x,0)/ys.length;
  const v=xs.reduce((s,x)=>s+(x-mx)**2,0),discount=-xs.reduce((s,x,i)=>s+(x-mx)*(ys[i]-my),0)/v;
  if(!(discount>0&&discount<=1))return null;
  const forward=mx+my/discount;if(!(forward>0&&Number.isFinite(forward)))return null;
  if(a.some(x=>discount*(forward-x.strike)<x.call.bid-x.put.ask-1e-8||discount*(forward-x.strike)>x.call.ask-x.put.bid+1e-8))return null;
  return {forward,discount,expiryAt,at:now,epoch:quotes[0].epoch,source:quotes[0].source,strikes:xs};
}
export function freshPremiumScenarios(args:{basis:FreshParityBasis;quote:FreshQuote;strike:number;side:'CE'|'PE';signalKind:'SPOT'|'FUTURES';signalPrice:number;pricingSpot:number;target:number;stop:number;now:number;cutoff:number}){
  const {basis:b,quote:q}=args;
  if(![args.strike,args.signalPrice,args.pricingSpot,args.target,args.stop,args.now,args.cutoff].every(Number.isFinite)||Math.min(args.strike,args.signalPrice,args.pricingSpot,args.target,args.stop)<=0||b.at>args.now||args.now-b.at>2000||q.epoch!==b.epoch||q.source!==b.source)return null;
  const t=(b.expiryAt-args.now)/31536000000;if(t<=0||args.cutoff<=args.now)return null;
  const mid=(q.bid+q.ask)/2,iv=calculateIV(mid/b.discount,b.forward,args.strike,t,0,args.side);
  if(!(iv>0&&Number.isFinite(iv)))return null;
  const fair=(f:number,time:number,vol:number,d:number)=>Math.max(0,d*blackScholesPrice({spotPrice:f,strikePrice:args.strike,timeToExpiry:time,riskFreeRate:0,iv:vol,optionType:args.side}));
  if(Math.abs(fair(b.forward,t,iv,b.discount)-mid)>q.tick)return null;
  const delta=calculateGreeks({spotPrice:b.forward,strikePrice:args.strike,timeToExpiry:t,riskFreeRate:0,iv,optionType:args.side}).delta*b.discount*b.forward/args.pricingSpot;
  const horizon=Math.min(900000,args.cutoff-args.now),remaining=Math.max(0,(b.expiryAt-args.now-horizon)/31536000000),discount=b.discount**(remaining/t),ratio=b.forward/args.signalPrice;
  const forwardAt=(level:number)=>level*(args.signalKind==='SPOT'?ratio**(remaining/t):ratio),halfSpread=(q.ask-q.bid)/2;
  const bid=(level:number,vol:number)=>Math.max(0,fair(forwardAt(level),remaining,vol,discount)-halfSpread);
  return {delta,iv,targetPremiumScenarios:[bid(args.target,iv),bid(args.target,Math.max(0,iv-.02))],invalidationPremiumScenarios:[bid(args.stop,iv),bid(args.stop,Math.max(0,iv-.02))],evidence:{model:'EUROPEAN_FORWARD_PARITY_BLACK76_1',forward:b.forward,discount:b.discount,signalToForwardRatio:ratio,signalKind:args.signalKind,pricingSpot:args.pricingSpot,horizonMs:horizon,ivShocks:[0,-.02],futureSpread:'CURRENT_ABSOLUTE_HALF_SPREAD_ASSUMPTION',calibrationStrikes:b.strikes}};
}
export interface FreshFeePolicy {version:string;brokeragePerOrder:number;exchangeFraction:number;sebiFraction:number;stampBuyFraction:number;sellTaxFraction:number;gstFraction:number;}
export function freshRoundTripFeeBreakdown(entry:number,exit:number,quantity:number,multiplier:number,p:FreshFeePolicy) {
  if(![entry,exit,quantity,multiplier,p.brokeragePerOrder,p.exchangeFraction,p.sebiFraction,p.stampBuyFraction,p.sellTaxFraction,p.gstFraction].every(Number.isFinite)||entry<=0||exit<0||!Number.isSafeInteger(quantity)||quantity<=0||multiplier<=0||Object.entries(p).some(([k,v])=>k!=='version'&&(v as number)<0))throw Error('INVALID_FEE_INPUT');
  const buy=entry*quantity*multiplier,sell=exit*quantity*multiplier,turnover=buy+sell,brokerage=2*p.brokeragePerOrder,exchange=turnover*p.exchangeFraction,sebi=turnover*p.sebiFraction;
  const stampBuy=buy*p.stampBuyFraction,sellTax=sell*p.sellTaxFraction,gst=(brokerage+exchange+sebi)*p.gstFraction;
  return {buyTurnover:buy,sellTurnover:sell,brokerage,exchange,sebi,stampBuy,sellTax,gst,total:brokerage+exchange+sebi+stampBuy+sellTax+gst};
}
export function freshRoundTripFees(entry:number,exit:number,quantity:number,multiplier:number,p:FreshFeePolicy):number{return freshRoundTripFeeBreakdown(entry,exit,quantity,multiplier,p).total;}
export function freshPremiumForNet(entry:number,quantity:number,multiplier:number,p:FreshFeePolicy,netCurrency:number){
  const base=freshRoundTripFees(entry,0,quantity,multiplier,p),slope=freshRoundTripFees(entry,1,quantity,multiplier,p)-base,units=quantity*multiplier;
  if(!Number.isFinite(netCurrency)||units<=slope)throw Error('INVALID_NET_PRICE_INPUT');
  return (entry*units+base+netCurrency)/(units-slope);
}
