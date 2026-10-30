import { evaluateFreshStrategies, type FreshContext, type FreshCandidate } from '@fno/analytics';
import { freshEntriesEnabled } from '../../config/fresh-start.js';
import { FreshPaperStore, type FreshEntryRequest } from './store.js';
import { FreshWorkQueue } from './queue.js';
/** Shared-feed adapter must supply verified calendars, event coverage, model/costs and exact-contract books.
 * No legacy midpoint/spot-volume fallback is accepted. Production qualification is deliberately absent. */
export interface FreshQualifiedAdapter {
    qualified: boolean;
    build(c: FreshCandidate): Promise<FreshEntryRequest | null>;
    watch(positions: Awaited<ReturnType<FreshPaperStore['recover']>>, observe: FreshPaperStore['observe']): Promise<void>;
    audit(context: FreshContext, evaluation: ReturnType<typeof evaluateFreshStrategies>): Promise<void>;
}
export class FreshRuntime {
    private builds = new FreshWorkQueue(20, 2);
    private evaluations = new FreshWorkQueue(100, 2);
    private recovered = false;
    constructor(private store = new FreshPaperStore(), private adapter: FreshQualifiedAdapter | null = null, private enabled: () => boolean = freshEntriesEnabled) { }
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
            const evaluation = evaluateFreshStrategies(context);
            await adapter.audit(context, evaluation);
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
                // Processing time cannot reuse a formerly fresh quote after queue/network delay.
                const result = await this.store.enter({ ...r, now: Date.now() });
                if (result.ok)
                    return 'FILLED';
            }
            return 'NO_ELIGIBLE_ENTRY';
        });
    }
}
export const freshRuntime = new FreshRuntime();
export function startFreshPaperRecovery() { return freshRuntime.recover(); }
