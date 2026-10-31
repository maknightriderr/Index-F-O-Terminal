import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
let pg:PGlite;
vi.mock('../../lib/db.js',()=>({sql:Object.assign(async(s:TemplateStringsArray,...values:any[])=>{const query=s.reduce((q,x,i)=>q+x+(i<values.length?`$${i+1}`:''),'');return (await pg.query(query,values.map(x=>x instanceof Date?x.toISOString():x))).rows;},{json:(x:unknown)=>JSON.stringify(x)})}));
import {persistFreshCalendarSnapshot} from '../fresh-start/audit.js';
beforeAll(async()=>{pg=new PGlite();const migration=readFileSync(new URL('../../../../../database/init/049_fresh_start_calendars.sql',import.meta.url),'utf8');await pg.exec(migration);await pg.exec(migration);},30000);
afterAll(async()=>pg.close());
describe('immutable calendar evidence store',()=>{
 it('persists the exact source snapshot once and does not rewrite the original evidence on duplicate delivery',async()=>{const snapshot={id:'calendar-proof',source:'TRADING_ECONOMICS' as const,from:1,to:999999,fetchedAt:100000,expiresAt:160000,events:[],uncertainSessions:[]};await persistFreshCalendarSnapshot(snapshot);await persistFreshCalendarSnapshot({...snapshot,uncertainSessions:['2026-10-30']});const rows=(await pg.query<any>('SELECT * FROM fresh_calendar_snapshots')).rows;expect(rows).toHaveLength(1);expect(rows[0].evidence).toEqual(snapshot);expect(rows[0].source).toBe('TRADING_ECONOMICS');});
 it('stores EIA observation provenance without asserting full commodity coverage',async()=>{const snapshot={id:'eia-proof',source:'EIA_WPSR_PUBLIC_V1' as const,product:'CRUDEOIL' as const,requestedAt:100000,fetchedAt:101000,expiresAt:700000,urls:['https://www.eia.gov/petroleum/supply/weekly/includes/wpsr-calendar.json'],payloadHash:'payload-proof',events:[{day:'2026-11-04',at:1793806200000}],scope:'SINGLE_EIA_WEEKLY_REPORT_ONLY' as const,sourceQuality:{sourceRows:110,excludedOutOfWindowRows:106,excludedRelationshipWarnings:5}};await persistFreshCalendarSnapshot(snapshot);const rows=(await pg.query<any>("SELECT * FROM fresh_calendar_snapshots WHERE id='eia-proof'")).rows;expect(rows).toHaveLength(1);expect(rows[0].evidence).toEqual(snapshot);expect(rows[0].source).toBe('EIA_WPSR_PUBLIC_V1');});
});
