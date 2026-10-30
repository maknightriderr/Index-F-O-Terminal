import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({budget:true,configured:true,cooling:false,ready:true,discover:vi.fn(),claim:vi.fn(),source:vi.fn(),complete:vi.fn(),retry:vi.fn(),write:vi.fn()}));
vi.mock('../../lib/logger.js',()=>({logger:{warn:vi.fn()}}));
vi.mock('../../lib/llm.js',()=>({isAiConfigured:()=>mocks.configured,aiRetryAt:()=>mocks.cooling?Date.now()+60000:null,askAi:vi.fn()}));
vi.mock('../auto-review-budget.js',()=>({automaticReviewBudgetAvailable:async()=>mocks.budget,reserveAutomaticReviewBudget:async()=>mocks.budget}));
vi.mock('../ensure-capture-schema.js',()=>({schemaFileReady:()=>mocks.ready}));
vi.mock('../auto-review-store.js',()=>({discoverAutomaticReviews:mocks.discover,claimAutomaticReview:mocks.claim,automaticReviewSource:mocks.source,completeAutomaticReview:mocks.complete,retryAutomaticReview:mocks.retry}));
vi.mock('../ai-trade-review.js',()=>({autoReviewEnabled:()=>process.env.AUTO_TRADE_REVIEW!=='off',automaticReviewEvidence:(v:unknown)=>v,writeAutomaticReview:mocks.write}));
const {runAutomaticReviewTick}=await import('../auto-review-job.js');
const previous=process.env.AUTO_TRADE_REVIEW;
beforeEach(()=>{vi.clearAllMocks();mocks.budget=true;mocks.configured=true;mocks.cooling=false;mocks.ready=true;delete process.env.AUTO_TRADE_REVIEW;mocks.claim.mockResolvedValue(null);mocks.source.mockResolvedValue({});mocks.write.mockResolvedValue({review:{summary:'test',hypotheses:[]}});});
afterEach(()=>{if(previous===undefined)delete process.env.AUTO_TRADE_REVIEW;else process.env.AUTO_TRADE_REVIEW=previous;});
it('keeps jobs durable when AI is not configured, without burning retry attempts',async()=>{
  mocks.configured=false;await runAutomaticReviewTick();expect(mocks.discover).toHaveBeenCalledOnce();expect(mocks.claim).not.toHaveBeenCalled();
});
it('honours schema availability and the automation pause',async()=>{
  mocks.ready=false;await runAutomaticReviewTick();expect(mocks.discover).not.toHaveBeenCalled();
  mocks.ready=true;process.env.AUTO_TRADE_REVIEW='off';await runAutomaticReviewTick();expect(mocks.discover).not.toHaveBeenCalled();
});
it('automatically retries model/evidence failure and continues other jobs',async()=>{
  mocks.claim.mockResolvedValueOnce({signal_id:'1'}).mockResolvedValueOnce({signal_id:'2'});
  mocks.write.mockRejectedValueOnce(new Error('provider-secret-do-not-log'));
  await runAutomaticReviewTick();expect(mocks.retry).toHaveBeenCalledWith({signal_id:'1'});expect(mocks.complete).toHaveBeenCalledOnce();
});
it('limits each tick to two claims and prevents overlapping local workers',async()=>{
  let release:()=>void=()=>{};mocks.discover.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));
  mocks.claim.mockResolvedValue({signal_id:'1'});
  const first=runAutomaticReviewTick();await runAutomaticReviewTick();expect(mocks.discover).toHaveBeenCalledOnce();
  release();await first;expect(mocks.claim).toHaveBeenCalledTimes(2);
});

it('leaves work pending without claiming or burning retries while providers cool down',async()=>{
  mocks.cooling=true;await runAutomaticReviewTick();expect(mocks.discover).toHaveBeenCalledOnce();expect(mocks.claim).not.toHaveBeenCalled();
  mocks.cooling=false;await runAutomaticReviewTick();expect(mocks.claim).toHaveBeenCalledOnce();
});
it('stops the batch immediately when a provider outage starts',async()=>{
  mocks.claim.mockResolvedValue({signal_id:'1'});
  mocks.write.mockImplementationOnce(async()=>{mocks.cooling=true;throw new Error('429');});
  await runAutomaticReviewTick();expect(mocks.claim).toHaveBeenCalledOnce();expect(mocks.retry).toHaveBeenCalledOnce();
});

it('preserves queued work after the daily research budget is spent',async()=>{
  mocks.budget=false;await runAutomaticReviewTick();expect(mocks.claim).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
});
