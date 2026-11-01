import {describe,it,expect} from 'vitest';
import {evaluateFreshStrategies,FRESH_PACK_VERSION,type FreshContext} from '@fno/analytics';
import {replayFreshResearch} from '../fresh-start/research-replay.js';
const at=Date.parse('2026-11-02T10:00:00+05:30');
const input:FreshContext={now:at,session:'2026-11-02',sessionOpen:at-2700000,sessionClose:at+19800000,instrument:'NSE_FO:1',sourceEpoch:'recorded',bars5:[],bars15:[],bars1:[],rvolReferences:{},openingVolumeReferences:[],levels:[],previousHigh:0,previousLow:0,referenceVerified:false,eventClear:false,calendarVerified:true};
const row=()=>({id:'one',version:FRESH_PACK_VERSION,input:structuredClone(input),result:evaluateFreshStrategies(input)});
describe('offline signal decision replay, not execution backtesting',()=>{
 it('replays a recorded refusal with frozen time and is reproducible without IO',()=>{const r=row(),before=JSON.stringify(r);const result=replayFreshResearch([r]);expect(result).toMatchObject({evidence:'SIGNAL_REPLAY_ONLY',sampled:1,matched:1,mismatched:0});expect(replayFreshResearch([r])).toEqual(result);expect(JSON.stringify(r)).toBe(before);});
 it('surfaces a stored-decision mismatch and rejects mixed versions, duplicate IDs, bad dates and nonchronological inputs',()=>{
  expect(replayFreshResearch([{...row(),result:{candidates:[],refusals:[]}}]).mismatched).toBe(1);
  expect(()=>replayFreshResearch([{...row(),version:'legacy'}])).toThrow();expect(()=>replayFreshResearch([row(),row()])).toThrow('INVALID_REPLAY_ORDER_OR_IDENTITY');
  const wrong=row();wrong.input.session='2026-11-03';expect(()=>replayFreshResearch([wrong])).toThrow('INVALID_REPLAY_ORDER_OR_IDENTITY');
  const prior=row();prior.id='prior';prior.input.now-=1000;expect(()=>replayFreshResearch([row(),prior])).toThrow('INVALID_REPLAY_ORDER_OR_IDENTITY');
 });
});
