import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AutoReviewEvidence } from '@fno/shared';

let pg: PGlite;
class Json { constructor(public value: unknown) {} }
const sqlShim: any = (strings: TemplateStringsArray,...values: unknown[]) => {
  const text = strings.reduce((s,part,i)=>s+part+(i<values.length?`$${i+1}`:''),'');
  const params=values.map(v=>v instanceof Json?JSON.stringify(v.value):v instanceof Date?v.toISOString():v);
  return pg.query(text,params).then(r=>r.rows);
};
sqlShim.json=(v:unknown)=>new Json(v);
vi.mock('../../lib/db.js',()=>({sql:(...args: unknown[])=>sqlShim(...args)}));
// Keep the postgres.js-shaped json helper on the mocked callable.
const db = await import('../../lib/db.js');
(db.sql as any).json=sqlShim.json;
vi.mock('../../lib/llm.js',()=>({isAiConfigured:()=>true}));
const { discoverAutomaticReviews, claimAutomaticReview, automaticReviewSource, completeAutomaticReview, retryAutomaticReview, automaticReviewReport, reviewRetrySeconds }=await import('../auto-review-store.js');
const { automaticReviewEvidence }=await import('../ai-trade-review.js');
const id='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';
const migration=readFileSync(fileURLToPath(new URL('../../../../../database/init/046_automatic_ai_trade_reviews.sql',import.meta.url)),'utf8');
const inputs=(over:Record<string,unknown>={})=>({source:'A3',sourceVersion:'v1',logic:{logicVersion:'rules1'},exchange:'NSE',mode:'INTRADAY',outcome:'LOSS',closeReason:'STOP',entry:100,stopLoss:80,exitPrice:79,estimatedCostPct:2,exitTime:Date.now()-10000,...over});
async function seed(uuid=id, over:Record<string,unknown>={}) { await pg.query('INSERT INTO signals VALUES ($1,NOW(),$2,$3,$4)',[uuid,'NIFTY','TRADE_SETUP',JSON.stringify(inputs(over))]); }
async function due() { await pg.exec("UPDATE ai_trade_reviews SET next_attempt_at=NOW()-interval '1 minute'"); }
beforeAll(async()=>{
  pg=new PGlite();
  await pg.exec('CREATE TABLE signals(id uuid primary key,time timestamptz,symbol text,signal_type text,inputs jsonb); CREATE TABLE decision_snapshots(signal_id uuid,time timestamptz,decision text,bias text,confidence numeric,regime text,spread_pct numeric,delta numeric); CREATE TABLE paper_execution_observations(signal_id uuid,observed_at timestamptz,ltp numeric);');
  await pg.exec(migration); await pg.exec(migration);
}, 30000);
beforeEach(async()=>{await pg.exec('TRUNCATE signals,decision_snapshots,paper_execution_observations,ai_trade_reviews,ai_review_versions');});
afterAll(async()=>{await pg.close();});
describe('durable isolated review queue on Postgres',()=>{
  it('discovers all outcome labels, is idempotent, and does not review open trades',async()=>{
    await seed(); await seed(id2,{outcome:'WIN'});
    await discoverAutomaticReviews(); await discoverAutomaticReviews();
    expect((await pg.query('SELECT * FROM ai_trade_reviews')).rows).toHaveLength(2);
    await pg.exec("UPDATE signals SET inputs=jsonb_set(inputs,'{outcome}','null')");
    await pg.exec('TRUNCATE ai_trade_reviews'); await discoverAutomaticReviews();
    expect((await pg.query('SELECT * FROM ai_trade_reviews')).rows).toHaveLength(0);
  });
  it('claims once, reclaims an expired lease, and fences stale worker completion',async()=>{
    await seed();await discoverAutomaticReviews();await due();
    const first=(await claimAutomaticReview())!; expect(await claimAutomaticReview()).toBeNull();
    await pg.exec("UPDATE ai_trade_reviews SET lease_until=NOW()-interval '1 minute'");
    const second=(await claimAutomaticReview())!;
    const evidence=automaticReviewEvidence({symbol:'NIFTY',time:new Date(),inputs:inputs(),snapshot:null,observations:null});
    const answer={review:{summary:'Observed only',hypotheses:[]},provider:'test',model:'test'};
    expect(await completeAutomaticReview(first,evidence,answer)).toBe(false);
    expect(await completeAutomaticReview(second,evidence,answer)).toBe(true);
    expect((await automaticReviewReport()).counts.COMPLETE).toBe(1);
  });
  it('includes older positional trades that close after activation without backfilling all history',async()=>{
    await discoverAutomaticReviews();
    await seed(id,{mode:'POSITIONAL',exitTime:Date.now()+1000});
    await seed(id2,{exitTime:Date.now()-30*86400000});
    await pg.exec("UPDATE signals SET time=NOW()-interval '30 days'");
    await discoverAutomaticReviews();
    expect((await pg.query<{signal_id:string}>('SELECT signal_id FROM ai_trade_reviews')).rows.map(r=>r.signal_id)).toEqual([id]);
  });
  it('requeues changed outcomes and never writes to source trade or snapshot tables',async()=>{
    await seed();await discoverAutomaticReviews();await due();
    const claim=(await claimAutomaticReview())!;
    const before=(await pg.query('SELECT inputs FROM signals')).rows;
    const source=await automaticReviewSource(claim,true);
    expect(source.observations?.samples).toBe(0);
    await retryAutomaticReview(claim);
    expect((await pg.query('SELECT inputs FROM signals')).rows).toEqual(before);
    await pg.exec("UPDATE signals SET inputs=jsonb_set(inputs,'{exitPrice}','110')");
    await discoverAutomaticReviews();
    expect((await pg.query<{status:string;attempts:number}>('SELECT status,attempts FROM ai_trade_reviews')).rows[0]).toEqual({status:'PENDING',attempts:0});
  });
  it('automatically backs off and caps retries at a day without requiring a reset',()=>{
    expect(reviewRetrySeconds(1)).toBe(60);expect(reviewRetrySeconds(2)).toBe(120);expect(reviewRetrySeconds(99)).toBe(86400);
  });
  it('invalidates reopened trades and does not claim them until they close again',async()=>{
    await seed();await discoverAutomaticReviews();await due();const claim=(await claimAutomaticReview())!;
    await pg.exec("UPDATE signals SET inputs=jsonb_set(inputs,'{outcome}','null')");
    const e=automaticReviewEvidence({symbol:'NIFTY',time:new Date(),inputs:inputs(),snapshot:null,observations:null});
    expect(await completeAutomaticReview(claim,e,{review:{summary:'stale',hypotheses:[]},provider:'x',model:'x'})).toBe(false);
    await discoverAutomaticReviews();expect(await claimAutomaticReview()).toBeNull();
    await pg.exec("UPDATE signals SET inputs=jsonb_set(inputs,'{outcome}','\"EXPIRED\"')");
    await discoverAutomaticReviews();await due();expect(await claimAutomaticReview()).not.toBeNull();
  });
  it('repeated observations compare net winners and losers in the same version only',async()=>{
    await seed();await seed(id2,{outcome:'WIN',exitPrice:110});await discoverAutomaticReviews();await due();
    for(let i=0;i<2;i++){
      const claim=(await claimAutomaticReview())!;const source=await automaticReviewSource(claim,false);
      const evidence:AutoReviewEvidence={...automaticReviewEvidence(source),issueCodes:['DATA_GAPS']};
      await completeAutomaticReview(claim,evidence,{review:{summary:'Missing path',hypotheses:[]},provider:'test',model:'test'});
    }
    const report=await automaticReviewReport();
    expect(report.repeated[0]).toMatchObject({strategy:'A3',source_version:'v1',trades:2,measured:2,profitable:1,losing:1});
    await pg.query('UPDATE ai_trade_reviews SET source_version=$1 WHERE signal_id=$2',['v2',id2]);
    expect((await automaticReviewReport()).repeated).toHaveLength(0);
  });
});
