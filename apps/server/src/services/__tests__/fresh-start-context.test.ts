import {describe,it,expect} from 'vitest';
import {getSessionWindow} from '@fno/shared';
import {buildFreshReferenceContext,freshBars,freshTrendBars,mergeFreshBars,freshExpirySessions} from '../fresh-start/context.js';
const open=getSessionWindow('NSE','2026-10-30')!.open;
const bar=(time:number,volume=1000)=>({time,availableAt:time+300000,open:100,high:102,low:99,close:101,volume});
describe('point-in-time reference contexts',()=>{
 it('retains first availability for unchanged candles and revisions receive new availability',()=>{const b=bar(open),same={...b,availableAt:b.availableAt+10000};expect(mergeFreshBars([b],[same],10)[0].availableAt).toBe(b.availableAt);expect(mergeFreshBars([b],[{...same,volume:1001}],10)[0].availableAt).toBe(same.availableAt);});
 it('excludes unfinished candles and rejects ambiguous duplicate broker timestamps',()=>{const row={timestamp:new Date(open).toISOString(),open:100,high:102,low:99,close:101,volume:1000};expect(freshBars([row],5,open+299999)).toEqual([]);expect(()=>freshBars([row,row],5,open+300000)).toThrow('DUPLICATE_BROKER_CANDLE');});
 it('aggregates only three contiguous five-minute bars within a session',()=>{const rows=[0,1,2].map(i=>bar(open+i*300000));expect(freshTrendBars(rows)).toHaveLength(1);expect(freshTrendBars(rows.filter((_,i)=>i!==1))).toEqual([]);expect(freshTrendBars(rows)[0].availableAt).toBe(open+900000);});
 it('never substitutes an older session when the previous session is missing',()=>{const older=getSessionWindow('NSE','2026-10-28')!.open;const c=buildFreshReferenceContext({now:open+1800000,instrument:'NSE_FO:1',sourceEpoch:'e',bars5:[...Array.from({length:75},(_,i)=>bar(older+i*300000)),...Array.from({length:6},(_,i)=>bar(open+i*300000,99999))],bars1:[],eventClear:true,referenceVerified:true})!;expect(c.previousHigh).toBe(0);expect(c.rvolReferences[0]).toEqual([1000]);});
 it('does not extrapolate exchange calendars into an unverified year or admit zero DTE',()=>{expect(freshExpirySessions('2026-10-30','2026-10-30')).toBe(0);expect(freshExpirySessions('2026-12-31','2027-01-07')).toBeNull();});
});
