import {FreshPaperWorker} from './worker.js';
import type { MarketDataProvider } from '../../providers/interface.js';
import type { SubscriptionManager } from '../../lib/subscription-manager.js';
import { evaluateFreshStrategies, FRESH_SHADOW_STRATEGIES, type FreshContext, type FreshCandidate } from '@fno/analytics';
import { freshEntriesEnabled } from '../../config/fresh-start.js';
import { FreshPaperStore, type FreshEntryRequest } from './store.js';
import { FreshWorkQueue } from './queue.js';
import type { FreshLearning } from './learning.js';
/** Shared-feed adapter must supply verified calendars, event coverage, model/costs and exact-contract books.
 * No legacy midpoint/spot-volume fallback is accepted. Production qualification is deliberately absent. */
export interface FreshPreparedCandidate {candidate:FreshCandidate;netRR:number;finish():Promise<FreshEntryRequest|null>;}
export interface FreshQualifiedAdapter {
    prepare?(c:FreshCandidate):Promise<FreshPreparedCandidate|null>;
    decision?(c:FreshCandidate,code:string):Promise<void>;
    qualified: boolean;
    build(c: FreshCandidate): Promise<FreshEntryRequest | null>;
    watch(positions: Awaited<ReturnType<FreshPaperStore['recover']>>, observe: FreshPaperStore['observe']): Promise<void>;
    audit(context: FreshContext, evaluation: ReturnType<typeof evaluateFreshStrategies>): Promise<void>;
}
export class FreshRuntime {
    private builds = new FreshWorkQueue(20, 4);
    // 8 (was 2): an evaluation holds its slot while its candidates price (up to the 20 s entry window), and a queued
    // evaluation must start within 2 s of its context.
    private evaluations = new FreshWorkQueue(100, 8);
    private recovered = false;
    constructor(private store = new FreshPaperStore(), private adapter: FreshQualifiedAdapter | null = null, private enabled: () => boolean = freshEntriesEnabled, private learner: Pick<FreshLearning, 'screen' | 'screenContract'> | null = null) { }
    /** Learning (owner, 16 Nov): a candidate that would repeat a learned mistake is recorded and dropped. */
    private async screened(candidates: readonly FreshCandidate[], adapter: FreshQualifiedAdapter): Promise<FreshCandidate[]> {
        if (!this.learner) return [...candidates];
        const kept: FreshCandidate[] = [];
        for (const c of candidates) { const s = this.learner.screen(c); if (s.refusal) { await adapter.decision?.(s.candidate, s.refusal.code); continue; } kept.push(s.candidate); }
        return kept;
    }
    /** The expiry-day lesson, once the contract is known; returns the refusal code or null. */
    private async contractRefused(request: FreshEntryRequest, adapter: FreshQualifiedAdapter): Promise<string | null> {
        const r = this.learner?.screenContract(request.candidate, request.contract) ?? null;
        if (!r) return null;
        await adapter.decision?.(request.candidate, r.code);
        return r.code;
    }
    async recover() {
        // Always recover held risk before even considering whether entries are enabled.
        const positions = await this.store.recover();
        if (positions.length && !this.adapter?.qualified)
            throw new Error('BLOCKED_OPEN_POSITION_MONITOR_ADAPTER');
        if (this.adapter?.qualified)
            await this.adapter.watch(positions, this.store.observe.bind(this.store));
        this.recovered = true;
    }
    onClosedReference(context: FreshContext): Promise<string> {
        if (!this.enabled())
            return Promise.resolve('PAPER_DISABLED');
        if (!this.recovered || !this.adapter?.qualified)
            return Promise.resolve('BLOCKED_QUALIFIED_ADAPTER');
        const adapter = this.adapter;
        return this.evaluations.add(context.now + 2000, async () => {
            const evaluated = evaluateFreshStrategies(context);
            await adapter.audit(context, evaluated);
            // Shadow strategies (2.0): recorded as a decision, never priced or entered.
            for (const c of evaluated.candidates.filter(c => FRESH_SHADOW_STRATEGIES.has(c.strategy)))
                await adapter.decision?.(c, 'SHADOW_STRATEGY');
            const evaluation = { ...evaluated, candidates: await this.screened(evaluated.candidates.filter(c => !FRESH_SHADOW_STRATEGIES.has(c.strategy)), adapter) };
            if(adapter.prepare){
                const plans=await Promise.all(evaluation.candidates.map(c=>this.builds.add(c.expiresAt,()=>adapter.prepare!(c))));
                const eligible=plans.filter((p):p is FreshPreparedCandidate=>p!==null).sort((a,b)=>a.candidate.at-b.candidate.at||b.netRR-a.netRR||a.candidate.origin-b.candidate.origin||a.candidate.strategy.localeCompare(b.candidate.strategy));
                const selected=eligible[0];if(!selected)return 'NO_ELIGIBLE_ENTRY';
                for(const other of eligible.slice(1))await adapter.decision?.(other.candidate,'ANOTHER_CANDIDATE_SELECTED');
                const request=await selected.finish();if(!request)return 'NO_ELIGIBLE_ENTRY';
                const learned=await this.contractRefused(request,adapter);if(learned)return learned;
                const result=await this.store.enter({...request,now:Date.now()});
                if(result.ok){await adapter.watch(await this.store.recover(),this.store.observe.bind(this.store));return 'FILLED';}
                await adapter.decision?.(selected.candidate,result.code);return result.code;
            }
            // Build only bounded candidates, then arbitrate using actual worst-case net payoff.
            const built = await Promise.all(evaluation.candidates.map(c => this.builds.add(c.expiresAt, () => adapter.build(c))));
            // Same confirmation time is ordered by modeled net RR; admission is rechecked transactionally at fill.
            const rank = (r: FreshEntryRequest) => {
                const k = r.contract, entry = r.quote.ask + r.quote.tick, cost = k.explicitRoundTripCostPerUnit;
                const risk = Math.max(entry - Math.min(...k.invalidationPremiumScenarios), entry - Math.ceil(entry * .75 / r.quote.tick) * r.quote.tick) + cost;
                const v = (Math.min(...k.targetPremiumScenarios) - r.quote.tick - entry - cost) / risk;
                return Number.isFinite(v) ? v : -Infinity;
            };
            const requests = built.filter((x): x is FreshEntryRequest => x !== null).sort((a, b) => a.candidate.at - b.candidate.at || rank(b) - rank(a) || a.candidate.origin - b.candidate.origin || a.candidate.strategy.localeCompare(b.candidate.strategy));
            for (const r of requests) {
                if (await this.contractRefused(r, adapter)) continue;
                // Processing time cannot reuse a formerly fresh quote after queue/network delay.
                const result = await this.store.enter({ ...r, now: Date.now() });
                if (result.ok){
                    await adapter.watch(await this.store.recover(),this.store.observe.bind(this.store));
                    return 'FILLED';
                }
            }
            return 'NO_ELIGIBLE_ENTRY';
        });
    }
    /**
     * Dhan engine v2 (phase 4): one externally decided candidate (a DHAN_* setup SIGNAL) priced and entered through the
     * same adapter and store as every fresh-start entry: same arming, books, fees, IV filter, account lock, record-only
     * risk flags. Returns the decision code.
     */
    onExternalCandidate(c: FreshCandidate): Promise<string> {
        if (!this.enabled())
            return Promise.resolve('PAPER_DISABLED');
        if (!this.recovered || !this.adapter?.qualified || !this.adapter.prepare)
            return Promise.resolve('BLOCKED_QUALIFIED_ADAPTER');
        const adapter = this.adapter;
        // It may start while the candidate's own window lasts (bar closes are when the fresh evaluations queue is busiest).
        const startBy = Math.max(Date.now() + 2000, Math.min(c.expiresAt - 5000, Date.now() + 15000));
        return this.evaluations.add(startBy, async () => {
            const s = this.learner?.screen(c) ?? { candidate: c, refusal: null };
            if (s.refusal) { await adapter.decision?.(s.candidate, s.refusal.code); return s.refusal.code; }
            const screened = s.candidate;
            const plan = await this.builds.add(c.expiresAt, () => adapter.prepare!(screened));
            if (!plan) return 'NO_ELIGIBLE_ENTRY';
            const request = await plan.finish();
            if (!request) return 'NO_ELIGIBLE_ENTRY';
            const learned = await this.contractRefused(request, adapter);
            if (learned) return learned;
            const result = await this.store.enter({ ...request, now: Date.now() });
            if (result.ok) { await adapter.watch(await this.store.recover(), this.store.observe.bind(this.store)); return 'FILLED'; }
            await adapter.decision?.(screened, result.code);
            return result.code;
        });
    }
}
export const freshRuntime = new FreshRuntime();
let productionWorker:FreshPaperWorker|null=null;
export function startFreshPaperRecovery(provider?:MarketDataProvider,subscriptions?:SubscriptionManager){
    if(!provider||!subscriptions)return freshRuntime.recover();
    productionWorker?.stop();productionWorker=new FreshPaperWorker(provider,subscriptions);return productionWorker.start();
}
