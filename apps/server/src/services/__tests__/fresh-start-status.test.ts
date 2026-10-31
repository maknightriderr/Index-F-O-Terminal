import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let pg: PGlite;
vi.mock('../../lib/db.js', () => ({ sql: async (s: TemplateStringsArray, ...v: any[]) => { const q = s.reduce((q, x, i) => q + x + (i < v.length ? `$${i + 1}` : ''), ''); return (await pg.query(q, v)).rows; } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
import {FRESH_PACK_VERSION} from '@fno/analytics';
import { freshStartStatus } from '../fresh-start/status.js';
beforeAll(async () => { pg = new PGlite(); await pg.exec(readFileSync(new URL('../../../../../database/init/048_fresh_start_adapter.sql', import.meta.url), 'utf8')); await pg.exec(readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql', import.meta.url), 'utf8')); }, 30000);
afterAll(async () => { await pg.close(); });
describe('fresh-start read-only status and all-cohort aggregation', () => {
    it('keeps verified/unverified/unrecorded results separate without rewriting historical state or account counters',async()=>{
      const policy={id:'PAPER_EVENT_UNVERIFIED_V1',allowMissingMacroCoverage:true};
      await pg.query('INSERT INTO fresh_paper_accounts(id,session,version,capital,realized_net) VALUES ($1,$2,$3,500000,123)',['cohort-account','2026-11-02',FRESH_PACK_VERSION]);
      try{
        for(const [id,label,pnl] of [['unverified','EVENT_DATA_UNVERIFIED',-200],['verified','EVENT_COVERAGE_VERIFIED',100],['old',null,50]] as const){
          const state=label?{contract:{evidence:{eventCalendar:{policy,coverage:{evidenceClass:label}}}}}:{};
          await pg.query("INSERT INTO fresh_candidates(id,account_id,at,version,strategy,parent_id,decision,code,evidence) VALUES ($1,'cohort-account',now(),$2,'NEW_ORB_RETEST_V1',$1,'FILLED','FILLED','{}')",[id,FRESH_PACK_VERSION]);
          await pg.query("INSERT INTO fresh_paper_positions(id,account_id,version,strategy,instrument,risk_group,parent_id,session,status,reserved_risk,reserved_premium,opened_at,closed_at,net_pnl,state) VALUES ($1,'cohort-account',$2,'NEW_ORB_RETEST_V1',$1,$1,$1,'2026-11-02','CLOSED',100,1000,now(),now(),$3,$4::jsonb)",[id,FRESH_PACK_VERSION,pnl,JSON.stringify(state)]);
        }
        const r=await freshStartStatus();expect(r.eventPolicy.id).toBe(policy.id);expect(r.requiredEventConfiguration).toEqual([]);expect(r.performance[0]).toMatchObject({filled:3,closed:3,netPnl:-50,wins:2,losses:1});
        expect(r.eventCohorts).toHaveLength(3);for(const [label,pnl] of [['EVENT_DATA_UNVERIFIED',-200],['EVENT_COVERAGE_VERIFIED',100],['EVENT_POLICY_UNRECORDED',50]] as const)expect(r.eventCohorts.find(c=>c.evidenceClass===label)?.performance[0]).toMatchObject({filled:1,netPnl:pnl,validation:'NOT_VALIDATED'});
        expect((await pg.query<any>("SELECT state FROM fresh_paper_positions WHERE id='old'")).rows[0].state).toEqual({});expect((await pg.query<any>("SELECT realized_net FROM fresh_paper_accounts WHERE id='cohort-account'")).rows[0].realized_net).toBe(123);
      }finally{await pg.exec('TRUNCATE fresh_paper_events,fresh_paper_positions,fresh_candidates,fresh_parent_moves,fresh_paper_accounts CASCADE');}
    });

    it('returns four explicitly unvalidated rows with unavailable net results, and performs no writes', async () => { const before = (await pg.query('SELECT count(*) FROM fresh_paper_accounts')).rows; const r = await freshStartStatus(); expect(r).toMatchObject({ enabled: false, legacyNewEntries: false, liveOrdersAllowed: false, capital: 500000, performanceValidated: false, schemaReady: true }); expect(r.performance).toHaveLength(4); expect(r.performance.every(x => x.netPnl === null && x.winRate === null && x.validation === 'NOT_VALIDATED')).toBe(true); expect((await pg.query('SELECT count(*) FROM fresh_paper_accounts')).rows).toEqual(before); expect(r.blockers).toContain('QUALIFIED_SHARED_FEED_ADAPTER'); expect(r.reviews).toEqual([]);expect(r.capabilities).toContainEqual({id:'PRICING_MODEL_AND_SCENARIOS',status:'IMPLEMENTED_NOT_FULLY_QUALIFIED'}); });
});
