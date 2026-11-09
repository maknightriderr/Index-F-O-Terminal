import {blackScholesPrice,calculateIV,calculateGreeks} from '../greeks/index.js';
import type {FreshQuote} from './paper.js';
export interface ParityPair {strike:number;call:FreshQuote;put:FreshQuote;}
export interface FreshParityBasis {forward:number;discount:number;expiryAt:number;at:number;epoch:string;source:string;strikes:number[];}
export interface FreshFutureObservation {contract:string;price:number;tick:number;source:string;epoch:string;eventAt:number;receivedAt:number;}
export interface FreshFuturesParityBasis extends FreshParityBasis {futureContract:string;futureAt:number;}
/**
 * How old, and how far apart in exchange time, the parity quotes may be. Default: every quote <= 2 s old and all
 * within 1 s of each other. 6 Nov: that synchronous snapshot of 6-10 option books almost never existed (options tick
 * on trades, every few seconds), so 6 of 7 setups in two days never reached a contract. The adapter retries with a
 * relaxed tolerance for the BASIS only; the traded quote keeps the 2 s rule, and the bid/ask no-arbitrage band below
 * still rejects any fit the older quotes cannot all support.
 */
export interface FreshParityTolerance {maxAgeMs:number;maxSkewMs:number;}
export const FRESH_PARITY_STRICT:FreshParityTolerance=Object.freeze({maxAgeMs:2000,maxSkewMs:1000});
function validFuture(f:FreshFutureObservation,now:number,maxAgeMs=2000){return !!f.contract&&!!f.source&&!!f.epoch&&[f.price,f.tick,f.eventAt,f.receivedAt,now].every(Number.isFinite)&&f.price>0&&f.tick>0&&f.eventAt<=f.receivedAt&&f.receivedAt<=now&&now-f.eventAt<=maxAgeMs;}

type ParityBand = { strike: number; low: number; high: number };

function parityInputs(pairs: readonly ParityPair[], expiryAt: number, now: number, tolerance: FreshParityTolerance) {
  if (pairs.length < 3 || pairs.length > 5 || !Number.isFinite(expiryAt) || !Number.isFinite(now) || expiryAt <= now) return null;
  const quotes = pairs.flatMap(p => [p.call, p.put]);
  if (new Set(pairs.map(p => p.strike)).size !== pairs.length
    || new Set(quotes.map(q => q.contract)).size !== quotes.length
    || new Set(quotes.map(q => q.epoch)).size !== 1 || new Set(quotes.map(q => q.source)).size !== 1
    || pairs.some(p => !Number.isFinite(p.strike) || p.strike <= 0)) return null;
  if (quotes.some(q => ![q.bid, q.ask, q.tick, q.eventAt, q.receivedAt].every(Number.isFinite)
    || q.tick <= 0 || q.bid <= 0 || q.ask < q.bid || !Number.isSafeInteger(q.bidUnits) || !Number.isSafeInteger(q.askUnits)
    || q.bidUnits <= 0 || q.askUnits <= 0 || q.eventAt > q.receivedAt || q.receivedAt > now || now - q.eventAt > tolerance.maxAgeMs)
    || Math.max(...quotes.map(q => q.eventAt)) - Math.min(...quotes.map(q => q.eventAt)) > tolerance.maxSkewMs) return null;
  const bands = [...pairs].sort((a, b) => a.strike - b.strike).map(p => ({
    strike: p.strike, low: p.call.bid - p.put.ask, high: p.call.ask - p.put.bid,
  }));
  return { quotes, bands, basis: { expiryAt, at: now, epoch: quotes[0].epoch, source: quotes[0].source, strikes: bands.map(b => b.strike) } };
}

const mid = (b: ParityBand) => (b.low + b.high) / 2;
const clip = (x: number, low: number, high: number) => Math.max(low, Math.min(x, high));
const bandContains = (b: ParityBand, x: number) => x >= b.low - 1e-8 && x <= b.high + 1e-8;

/** With an observed future, each quote band bounds D directly in C-P=D(F-K). */
export function fitFreshFuturesParity(pairs: readonly ParityPair[], future: FreshFutureObservation, expiryAt: number, now: number, tolerance: FreshParityTolerance = FRESH_PARITY_STRICT): FreshFuturesParityBasis | null {
  if (!validFuture(future, now, tolerance.maxAgeMs)) return null;
  const inputs = parityInputs(pairs, expiryAt, now, tolerance);
  if (!inputs || inputs.basis.source !== future.source || inputs.basis.epoch !== future.epoch
    || inputs.quotes.some(q => Math.abs(q.eventAt - future.eventAt) > tolerance.maxSkewMs)) return null;
  let minDiscount = Number.EPSILON, maxDiscount = 1, cross = 0, squares = 0;
  for (const band of inputs.bands) {
    const distance = future.price - band.strike;
    if (distance === 0) {
      if (!bandContains(band, 0)) return null;
      continue;
    }
    const lo = band.low / distance, hi = band.high / distance;
    minDiscount = Math.max(minDiscount, Math.min(lo, hi));
    maxDiscount = Math.min(maxDiscount, Math.max(lo, hi));
    cross += distance * mid(band);
    squares += distance * distance;
  }
  if (minDiscount > maxDiscount || !(squares > 0)) return null;
  const discount = clip(cross / squares, minDiscount, maxDiscount);
  if (!inputs.bands.every(b => bandContains(b, discount * (future.price - b.strike)))) return null;
  return { ...inputs.basis, forward: future.price, discount, futureContract: future.contract, futureAt: future.eventAt };
}

/** European parity C-P=D(F-K). Find D for which the intercept intervals share a point. */
export function fitFreshParity(pairs: readonly ParityPair[], expiryAt: number, now: number, tolerance: FreshParityTolerance = FRESH_PARITY_STRICT): FreshParityBasis | null {
  const inputs = parityInputs(pairs, expiryAt, now, tolerance);
  if (!inputs) return null;
  const { bands, basis } = inputs;
  let minDiscount = Number.EPSILON, maxDiscount = 1;
  // Each lower intercept bound must be <= each upper intercept bound.
  for (const lower of bands) for (const upper of bands) {
    const distance = lower.strike - upper.strike;
    const bound = upper.high - lower.low;
    if (distance > 0) maxDiscount = Math.min(maxDiscount, bound / distance);
    if (distance < 0) minDiscount = Math.max(minDiscount, bound / distance);
  }
  if (minDiscount > maxDiscount) return null;
  const center = bands.reduce((s, b) => s + b.strike, 0) / bands.length;
  const mean = bands.reduce((s, b) => s + mid(b), 0) / bands.length;
  const squares = bands.reduce((s, b) => s + (b.strike - center) ** 2, 0);
  const slope = -bands.reduce((s, b) => s + (b.strike - center) * (mid(b) - mean), 0) / squares;
  const discount = clip(slope, minDiscount, maxDiscount);
  const lower = Math.max(...bands.map(b => b.low + discount * (b.strike - center)));
  const upper = Math.min(...bands.map(b => b.high + discount * (b.strike - center)));
  const forward = center + clip(mean, lower, upper) / discount;
  if (!(forward > 0 && Number.isFinite(forward)) || !bands.every(b => bandContains(b, discount * (forward - b.strike)))) return null;
  return { ...basis, forward, discount };
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
  return {delta,iv,targetPremiumScenarios:[bid(args.target,iv),bid(args.target,Math.max(0,iv-.02))],invalidationPremiumScenarios:[bid(args.stop,iv),bid(args.stop,Math.max(0,iv-.02))],evidence:{model:'EUROPEAN_FORWARD_PARITY_BLACK76_1',normalCdf:'ERF_SQRT2_FIXED_V1',forward:b.forward,discount:b.discount,signalToForwardRatio:ratio,signalKind:args.signalKind,pricingSpot:args.pricingSpot,horizonMs:horizon,ivShocks:[0,-.02],futureSpread:'CURRENT_ABSOLUTE_HALF_SPREAD_ASSUMPTION',calibrationStrikes:b.strikes}};
}
export interface FreshFeePolicy {version:string;brokeragePerOrder:number;exchangeFraction:number;sebiFraction:number;stampBuyFraction:number;sellTaxFraction:number;gstFraction:number;}
export function freshFuturesPremiumScenarios(args:{basis:FreshFuturesParityBasis;future:FreshFutureObservation;quote:FreshQuote;strike:number;side:'CE'|'PE';target:number;stop:number;now:number;cutoff:number}){
  const {basis:b,future:f,quote:q}=args;
  if(!validFuture(f,args.now)||f.contract!==b.futureContract||f.eventAt!==b.futureAt||f.price!==b.forward||f.source!==b.source||f.epoch!==b.epoch)return null;
  if(![q.bid,q.ask,q.tick,q.eventAt,q.receivedAt].every(Number.isFinite)||q.bid<=0||q.ask<q.bid||q.tick<=0||!Number.isSafeInteger(q.bidUnits)||!Number.isSafeInteger(q.askUnits)||q.bidUnits<=0||q.askUnits<=0||q.eventAt>q.receivedAt||q.receivedAt>args.now||args.now-q.eventAt>2000||Math.abs(q.eventAt-f.eventAt)>1000)return null;
  const result=freshPremiumScenarios({...args,signalKind:'FUTURES',signalPrice:f.price,pricingSpot:f.price});
  return result?{...result,evidence:{...result.evidence,model:'EUROPEAN_EXACT_FUTURE_BLACK76_1',futureContract:f.contract,futureAt:f.eventAt,referenceRule:'EXACT_FUTURE_NO_SPOT_OR_MONTH_SUBSTITUTION'}}:null;
}
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
