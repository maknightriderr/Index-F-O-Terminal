import { randomUUID } from 'node:crypto';
import { freshQuoteCode, type FreshQuote } from '@fno/analytics';
import type { Tick } from '@fno/shared';
import type { SubscriptionManager, SubscriptionTarget } from '../../lib/subscription-manager.js';
/** One consumer of the existing Angel socket. No independent broker connection or REST quote fallback. */
export class FreshSharedFeed {
    private epoch = 0;
    private closed = false;
    private readonly connectionId = randomUUID();
    private books = new Map<string, FreshQuote[]>();
    private referenceHistory=new Map<string,Tick[]>();
    private latest = new Map<string, Tick>();
    private listeners = new Set<() => void>();
    private targets = new Map<string, SubscriptionTarget>();
    private removeTick: (() => void) | null = null;
    private removeRecovery: (() => void) | null = null;
    constructor(private subscriptions: SubscriptionManager, private now: () => number = Date.now, private clientId = 'fresh-start:shared-feed') { }
    get sourceEpoch() { return `ANGEL-SNAP:${this.connectionId}:${this.epoch}`; }
    start() {
        if (this.closed)
            throw Error('FEED_CLOSED');
        if (this.removeTick)
            return;
        this.removeTick = this.subscriptions.onTick(ticks => this.receive(ticks));
        this.removeRecovery = this.subscriptions.onRecovering(() => { this.epoch++; this.books.clear(); this.latest.clear(); this.referenceHistory.clear(); this.notify(); });
    }
    async reserve(targets: readonly SubscriptionTarget[], verifiedNewCapacity: number) {
        if (this.closed)
            throw Error('FEED_CLOSED');
        if (!Number.isSafeInteger(verifiedNewCapacity) || verifiedNewCapacity < 1)
            throw Error('UNVERIFIED_SUBSCRIPTION_CAPACITY');
        const combined = new Map(this.targets);
        for (const t of targets) {
            if (!({NSE:['NSE_CM','NSE_FO'],BSE:['BSE_CM','BSE_FO'],MCX:['MCX_FO']} as Record<string,string[]>)[t.exchange]?.includes(t.exchangeSegment))
                throw Error('MARKET_NOT_QUALIFIED');
            combined.set(`${t.exchangeSegment}:${t.token}`, t);
        }
        if (combined.size > Math.min(250, verifiedNewCapacity))
            throw Error('FRESH_SUBSCRIPTION_BUDGET');
        await this.subscriptions.subscribe(this.clientId, [...combined.values()]);
        if (this.closed) {
            this.subscriptions.unsubscribe(this.clientId);
            throw Error('FEED_CLOSED');
        }
        this.targets = combined;
    }
    get subscribedTargets(){return [...this.targets.values()];}
    async syncTargets(targets:readonly SubscriptionTarget[],capacity:number){
        const wanted=new Set(targets.map(t=>`${t.exchangeSegment}:${t.token}`));
        for(const [id,t] of this.targets)if(!wanted.has(id)){this.subscriptions.unsubscribe(this.clientId,[t]);this.targets.delete(id);this.books.delete(id);this.latest.delete(id);this.referenceHistory.delete(id);}
        if(targets.length)await this.reserve(targets,capacity);
    }
    underlyingAt(id:string,at:number){const t=this.referenceHistory.get(id)?.filter(x=>x.timestamp<=at&&x.exchangeTimestamp!=null&&x.exchangeTimestamp<=at&&at-x.exchangeTimestamp<=2000).at(-1);return t?{price:t.ltp,at:t.exchangeTimestamp!}:null;}
    private receive(ticks: readonly Tick[]) {
        for (const t of ticks) {
            if (t.exchangeTimestamp == null || ![t.exchangeTimestamp, t.timestamp, t.ltp].every(Number.isFinite) || t.ltp <= 0 || t.exchangeTimestamp > t.timestamp || t.timestamp > this.now() || this.now() - t.exchangeTimestamp > 2000)
                continue;
            const matches = [...this.targets.entries()].filter(([, v]) => v.token === t.token && v.exchange === t.exchange && v.exchangeSegment === t.exchangeSegment);
            for (const [id] of matches) {
                const old = this.latest.get(id);
                if (t.exchangeTimestamp == null || t.exchangeTimestamp <= 0 || (old?.exchangeTimestamp != null && t.exchangeTimestamp <= old.exchangeTimestamp))
                    continue;
                this.latest.set(id, t);
                this.referenceHistory.set(id,[...(this.referenceHistory.get(id)??[]).filter(x=>this.now()-x.timestamp<=2500),t].slice(-100));
                if (t.bid == null || t.ask == null || t.bidQty == null || t.askQty == null)
                    continue;
                // Tick size is added only from a verified exact contract at read time, never inferred from LTP.
                const q: FreshQuote = { contract: id, source: 'ANGEL', epoch: this.sourceEpoch, eventAt: t.exchangeTimestamp, receivedAt: t.timestamp, bid: t.bid, ask: t.ask, bidUnits: t.bidQty, askUnits: t.askQty, tick: 1 };
                if (freshQuoteCode(q, id, 'ANGEL', this.sourceEpoch, this.now()) !== null)
                    continue;
                const series = (this.books.get(id) ?? []).filter(x => this.now() - x.eventAt <= 2500);
                series.push(q);
                this.books.set(id, series.slice(-100));
            }
        }
        this.notify();
    }
    private notify() {
        for (const f of this.listeners)
            f();
    }
    underlying(id: string) { const t = this.latest.get(id); return t?.exchangeTimestamp != null && this.now() - t.exchangeTimestamp <= 2000 && t.timestamp <= this.now() ? { price: t.ltp, at: t.exchangeTimestamp } : null; }
    futuresObservation(id:string,tick:number){const value=this.underlying(id),t=this.latest.get(id);return value&&t?{contract:id,price:value.price,tick,source:'ANGEL',epoch:this.sourceEpoch,eventAt:value.at,receivedAt:t.timestamp}:null;}
    quote(id: string, tick: number): FreshQuote | null {
        const q = this.books.get(id)?.at(-1);
        if (!q || this.latest.get(id)?.exchangeTimestamp !== q.eventAt)
            return null;
        const value = { ...q, tick };
        return freshQuoteCode(value, id, 'ANGEL', this.sourceEpoch, this.now()) === null ? value : null;
    }
    /** Returns the earliest eligible observed book after simulated arrival, even if the caller finishes work later. */
    firstAsk(id: string, tick: number, arrivalAt: number, deadline: number): Promise<FreshQuote | null> {
        if (this.closed || deadline <= this.now() || !Number.isFinite(arrivalAt) || !Number.isFinite(deadline))
            return Promise.resolve(null);
        return new Promise(resolve => {
            const find = () => {
                if (this.closed) {
                    finish(null);
                    return;
                }
                const q = this.books.get(id)?.find(x => x.eventAt >= arrivalAt && x.receivedAt >= arrivalAt && x.receivedAt <= deadline);
                if (q) {
                    const value = { ...q, tick };
                    finish(freshQuoteCode(value, id, 'ANGEL', this.sourceEpoch, this.now()) === null ? value : null);
                }
                else if (this.now() >= deadline)
                    finish(null);
            };
            const finish = (q: FreshQuote | null) => { clearTimeout(timer); this.listeners.delete(find); resolve(q); };
            const timer = setTimeout(() => finish(null), Math.max(0, deadline - this.now()));
            this.listeners.add(find);
            find();
        });
    }
    onObservation(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    close() { this.closed = true; this.removeTick?.(); this.removeRecovery?.(); this.removeTick = null; this.removeRecovery = null; this.subscriptions.unsubscribe(this.clientId); this.targets.clear(); this.books.clear(); this.latest.clear(); this.referenceHistory.clear(); this.notify(); this.listeners.clear(); }
}
