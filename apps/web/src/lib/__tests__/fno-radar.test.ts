import { describe, it, expect } from 'vitest';
import type { FnoScannerRow, Instrument } from '@fno/shared';
import { buildRadar, equityChartToken } from '../fno-radar';
const now=1800000000000;
const row=(symbol:string, extra:Partial<FnoScannerRow>={}):FnoScannerRow=>({symbol,exchange:'NSE',price:100,timestamp:now,direction:'BULLISH',score:60,relativeStrength:1,atmSpreadPct:1,...extra} as FnoScannerRow);
const universe=['A','B','C','D','E'].map(symbol=>({symbol,exchange:'NSE'}));
describe('F&O breadth and screening',()=>{
 it('partitions the eligible universe including missing, stale and invalid data',()=>{
 const r=buildRadar([row('A'),row('B',{direction:'BEARISH',relativeStrength:-1}),row('C',{direction:'NEUTRAL'}),row('D',{timestamp:now-500000}),row('OUTSIDE')],universe,now,true);
 expect([r.total,r.bullish,r.bearish,r.neutral,r.unavailable]).toEqual([5,1,1,1,2]);
 expect(r.bear.map(r=>r.symbol)).toEqual(['B']);
 });
 it('deduplicates newest row and does not count invalid prices as neutral',()=>{
 const r=buildRadar([row('A',{timestamp:now-1}),row('A',{direction:'BEARISH'}),row('B',{price:NaN}),row('C',{timestamp:now+100000})],universe,now,true);
 expect(r.bullish).toBe(0);expect(r.bearish).toBe(1);expect(r.unavailable).toBe(4);
 });
 it('does not fabricate a denominator when universe lookup fails',()=>{
 const r=buildRadar([row('A')],null,now,true);expect(r.total).toBeNull();expect(r.unavailable).toBeNull();expect(r.observed).toBe(1);
 });
 it('uses last-known rows outside session while excluding them during session',()=>{
 const rows=[row('A',{timestamp:now-86400000})];expect(buildRadar(rows,universe,now,false).bullish).toBe(1);expect(buildRadar(rows,universe,now,true).bullish).toBe(0);
 });
 it('requires finite spread and directional relative strength; never pads ten slots',()=>{
 const rows=[row('A'),row('B',{atmSpreadPct:null}),row('C',{relativeStrength:-2}),row('D',{atmSpreadPct:NaN}),row('E',{score:NaN})];
 expect(buildRadar(rows,universe,now,true).bull.map(r=>r.symbol)).toEqual(['A']);
 });
 it('caps lists at ten with deterministic score and strength tie breaking',()=>{
 const rows=Array.from({length:15},(_,i)=>row(`A${i}`,{score:i,relativeStrength:i+1}));
 const before=rows.map(r=>r.symbol);const r=buildRadar(rows,null,now,true);expect(r.bull).toHaveLength(10);expect(r.bull[0].symbol).toBe('A14');expect(rows.map(r=>r.symbol)).toEqual(before);
 });
 it('ranks lower directional scores first for bearish candidates',()=>{
 const rows=[row('A',{direction:'BEARISH',relativeStrength:-1,score:30}),row('B',{direction:'BEARISH',relativeStrength:-2,score:10})];
 expect(buildRadar(rows,universe,now,true).bear.map(r=>r.symbol)).toEqual(['B','A']);
 });
 it('clears breadth for an empty snapshot',()=>expect(buildRadar([],universe,now,true).unavailable).toBe(5));
});
describe('cash-stock chart identity',()=>{
 const instrument=(extra:Partial<Instrument>)=>({symbol:'ABC',exchange:'NSE',segment:'CM',instrumentType:'EQ',token:'cash',...extra} as Instrument);
 it('rejects futures, wrong exchange and partial-symbol matches',()=>{
 expect(equityChartToken([instrument({segment:'FO',instrumentType:'FUTSTK'}),instrument({exchange:'BSE'}),instrument({symbol:'ABCD'})],'ABC','NSE')).toBeNull();
 });
 it('accepts exact cash symbol or EQ suffix',()=>{
 expect(equityChartToken([instrument({symbol:'ABC-EQ'})],'ABC','NSE')).toBe('cash');
 });
});
