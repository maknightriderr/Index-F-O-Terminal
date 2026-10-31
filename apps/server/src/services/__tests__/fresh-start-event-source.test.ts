import {describe,it,expect,vi} from 'vitest';
import {FreshEventSource,parseFreshEvents} from '../fresh-start/event-source.js';
const at=Date.parse('2026-10-30T06:00:00Z');
const config={provider:'TRADING_ECONOMICS' as const,apiKey:'never-log-this',coverageConfirmed:true};
const row={CalendarId:'123',Date:'2026-10-30T12:00:00',Country:'India',Event:'Scheduled data',Importance:3,DateSpan:0};
describe('verified scheduled-event source and fail-closed coverage',()=>{
 it('uses public BLS schedules only as additional veto/evidence and never as complete macro or commodity coverage',async()=>{
   const bls={refresh:vi.fn(async()=>{}),blackout:vi.fn(()=>null as string|null),evidence:()=>({id:'bls-proof',scope:'SELECTED_BLS_RELEASES_ONLY'}),view:()=>({completeMacroCoverage:false})};
   const get=vi.fn(async()=>({status:200,data:[]}));
   const unconfigured=new FreshEventSource(undefined,get as any,()=>at,null,undefined,null,bls as any);
   await unconfigured.refresh({macro:false,issuer:false,publicMacro:true});
   expect(get).not.toHaveBeenCalled();expect(bls.refresh).toHaveBeenCalledOnce();
   expect(unconfigured.clearance(at,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_PROVIDER_CONFIGURATION');
   expect(unconfigured.blockers(at,'2026-10-30','COMMODITY')).toContain('BLOCKED_COMMODITY_EVENT_COVERAGE');
   const configured=new FreshEventSource(config,get as any,()=>at,null,undefined,null,bls as any);await configured.refresh();
   expect(configured.clearance(at,'2026-10-30','INDEX')).toBeNull();
   bls.blackout.mockReturnValue('BLS_RELEASE_BLACKOUT');
   expect(configured.clearance(at,'2026-10-30','INDEX')).toBe('BLS_RELEASE_BLACKOUT');
   expect(unconfigured.blockers(at,'2026-10-30','INDEX')).toEqual(['BLS_RELEASE_BLACKOUT','BLOCKED_EVENT_PROVIDER_CONFIGURATION']);
   expect(configured.blockers(at,'2026-10-30','COMMODITY')).toEqual(['BLS_RELEASE_BLACKOUT','BLOCKED_COMMODITY_EVENT_COVERAGE']);
   expect(configured.evidence(at,'INDEX')).toMatchObject({publicMacroCalendar:{id:'bls-proof'},macro:{source:'TRADING_ECONOMICS'}});
 });
 it('makes no request without explicit credentials and coverage approval',async()=>{for(const c of [undefined,{...config,coverageConfirmed:false}]){const get=vi.fn();const source=new FreshEventSource(c,get,()=>at);await source.refresh();expect(get).not.toHaveBeenCalled();expect(source.clearance(at,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_PROVIDER_CONFIGURATION');}});
 it('interprets timezone-less provider timestamps as UTC',()=>{expect(parseFreshEvents([row]).events[0].at).toBe(Date.parse(row.Date+'Z'));});
 it('blocks uncertain high-impact event sessions and stock issuer coverage',async()=>{const source=new FreshEventSource(config,vi.fn(async()=>({status:200,data:[{...row,DateSpan:1}]})) as any,()=>at);await source.refresh();expect(source.clearance(at,'2026-10-30','INDEX')).toBe('BLOCKED_UNCERTAIN_EVENT_TIME');expect(source.clearance(at,'2026-10-30','STOCK','ABC')).toBe('BLOCKED_ISSUER_RESULTS_COVERAGE');});
 it('never treats malformed, duplicate or possibly truncated responses as clear',()=>{for(const data of [{},[{...row,Date:'bad'}],[row,row],Array(1000).fill(row)])expect(()=>parseFreshEvents(data)).toThrow();});
 it('invalidates an old success on provider failure and rate-limits automatic retries',async()=>{let now=at;const get=vi.fn().mockResolvedValueOnce({status:200,data:[]}).mockRejectedValue(Error('429 secret request URL'));const source=new FreshEventSource(config,get as any,()=>now);await Promise.all([source.refresh(),source.refresh()]);expect(get).toHaveBeenCalledTimes(1);expect(source.clearance(now,'2026-10-30','INDEX')).toBeNull();now+=60001;await source.refresh();expect(source.clearance(now,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_PROVIDER_RESPONSE');await source.refresh();expect(get).toHaveBeenCalledTimes(2);expect(source.code).not.toContain(config.apiKey);});
 it('blocks a release blackout and refuses stale or future receipt coverage',async()=>{let now=at;const source=new FreshEventSource(config,vi.fn(async()=>({status:200,data:[{...row,Date:new Date(at+60000).toISOString()}]})) as any,()=>now);await source.refresh();expect(source.clearance(now,'2026-10-30','INDEX')).toBe('INDEX_EVENT_BLACKOUT');now+=60001;expect(source.clearance(now,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_COVERAGE');expect(source.clearance(at-1,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_COVERAGE');});
 it('does not reuse an index macro calendar as verified commodity-event coverage',async()=>{const source=new FreshEventSource(config,vi.fn(async()=>({status:200,data:[]})) as any,()=>at);await source.refresh();expect(source.clearance(at,'2026-10-30','INDEX')).toBeNull();expect(source.clearance(at,'2026-10-30','COMMODITY')).toBe('BLOCKED_COMMODITY_EVENT_COVERAGE');});

 it('requires macro coverage as well as a clear stock issuer/action calendar, and preserves snapshot evidence',async()=>{const issuer={refresh:vi.fn(async()=>{}),clearance:vi.fn(()=>null),evidence:()=>({id:'issuer-proof'}),view:()=>({source:'NSE_PUBLIC_RANGE_V1'})};const persist=vi.fn(async()=>{}),get=vi.fn(async()=>({status:200,data:[]}));const feed=new FreshEventSource(config,get as any,()=>at,issuer as any,persist);await feed.refresh();expect(feed.clearance(at,'2026-10-30','STOCK','INFY')).toBeNull();expect(issuer.clearance).toHaveBeenCalledWith(at,'2026-10-30','INFY','RESULTS');expect(issuer.clearance).toHaveBeenCalledWith(at,'2026-10-30','INFY','ACTIONS');expect(feed.evidence(at,'STOCK','INFY')).toMatchObject({issuerCalendar:{id:'issuer-proof'},macro:{source:'TRADING_ECONOMICS'}});expect(persist).toHaveBeenCalledOnce();const missingMacro=new FreshEventSource(undefined,get as any,()=>at,issuer as any);await missingMacro.refresh();expect(missingMacro.clearance(at,'2026-10-30','STOCK','INFY')).toBe('BLOCKED_EVENT_PROVIDER_CONFIGURATION');});
 it('keeps index entries independent of an unavailable issuer feed and blocks malformed real calendar dates',async()=>{const issuer={refresh:async()=>{},clearance:()=> 'BLOCKED_ISSUER_RESULTS_COVERAGE',view:()=>null};const feed=new FreshEventSource(config,vi.fn(async()=>({status:200,data:[]})) as any,()=>at,issuer as any);await feed.refresh();expect(feed.clearance(at,'2026-10-30','INDEX')).toBeNull();expect(feed.clearance(at,'2026-10-30','STOCK','TCS')).toBe('BLOCKED_ISSUER_RESULTS_COVERAGE');for(const Date of ['2026-02-30T12:00:00','2026-10-30T24:00:00'])expect(()=>parseFreshEvents([{...row,Date}])).toThrow();});
 it('never exposes a macro snapshot or clears entries if its durable write fails',async()=>{const feed=new FreshEventSource(config,vi.fn(async()=>({status:200,data:[]})) as any,()=>at,null,async()=>{throw Error('db');});await feed.refresh();expect(feed.clearance(at,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_PROVIDER_RESPONSE');expect(feed.evidence(at,'INDEX').macro).toBeNull();expect(JSON.stringify(feed.view())).not.toContain(config.apiKey);});

 it('makes no macro or NSE issuer request when only an uncovered commodity session needs scanning',async()=>{const issuer={refresh:vi.fn(async()=>{})},get=vi.fn();const feed=new FreshEventSource(config,get,()=>at,issuer as any);await feed.refresh({macro:false,issuer:false});expect(get).not.toHaveBeenCalled();expect(issuer.refresh).not.toHaveBeenCalled();});

 it('cannot qualify an earlier quote using a macro snapshot committed later',async()=>{let now=at;const feed=new FreshEventSource(config,vi.fn(async()=>({status:200,data:[]})) as any,()=>now,null,async()=>{now+=1000;});await feed.refresh();expect(feed.clearance(at,'2026-10-30','INDEX')).toBe('BLOCKED_EVENT_COVERAGE');expect(feed.evidence(at,'INDEX').macro).toBeNull();expect(feed.clearance(at+1000,'2026-10-30','INDEX')).toBeNull();});

});
