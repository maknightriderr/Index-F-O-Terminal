import { randomUUID } from 'node:crypto';
import { freshQuoteCode, type FreshQuote } from '@fno/analytics';
import type { Tick } from '@fno/shared';
import type { SubscriptionManager, SubscriptionTarget } from '../../lib/subscription-manager.js';
/**
 * MCX book depth unit, inferred per product from the live book (2 Nov: no MCX book ever qualified, because depth was
 * read as units while the broker appears to report lots). Orders are whole lots, so a depth in UNITS is always a
 * multiple of the lot: one non-multiple quantity proves LOTS. UNITS needs FRESH_MCX_DEPTH_MIN_SAMPLES observations,
 * all multiples. Until then the depth is UNKNOWN and reads as zero, so nothing qualifies on an unproven reading.
 */
export const FRESH_MCX_DEPTH_MIN_SAMPLES = 40;
export type FreshMcxDepthMode = 'LOTS' | 'UNITS' | 'UNKNOWN';
/** One consumer of the existing Angel socket. No independent broker connection or REST quote fallback. */
/** How old a reference's last trade may be (exchange time) while the feed is live. Was 2 s (2 Nov). */
export const FRESH_REFERENCE_MAX_AGE_MS = 5000;
/**
 * A quiet futures signal (NIFTYNXT50, FINNIFTY, BANKEX: one trade every 20-30 s on 5 Nov) is read from its spot index
 * plus the futures basis at its last trade, while that trade is at most this old and the spot itself is live. Its own
 * last trade stays the reference whenever it is within FRESH_REFERENCE_MAX_AGE_MS.
 */
export const FRESH_QUIET_SIGNAL_MAX_AGE_MS = 60000;
/** The basis is measured only from a futures trade and a spot tick at most this far apart (exchange time). */
export const FRESH_BASIS_PAIR_MS = 2000;
/**
 * Ticks reach this consumer up to this late (receive time - exchange time) and still update a reference's last trade.
 * They were dropped beyond 2 s, so on MCX (ticks typically 2-4 s late on 5 Nov) a liquid future's last trade often read
 * older than FRESH_REFERENCE_MAX_AGE_MS at a bar close: ~30% of MCX evaluations refused SIGNAL_AND_SPOT_STALE. The age
 * rule itself is unchanged (exchange time), and a book still needs the 2-second freshness of freshQuoteCode.
 */
export const FRESH_TICK_MAX_LAG_MS = 10000;
/** An exchange time ahead of our receive time by up to this much is clock skew and is read as the receive time. */
export const FRESH_TICK_CLOCK_SKEW_MS = 1000;
/** The feed counts as live when any tick arrived within this window. */
export const FRESH_FEED_ALIVE_MS = 2000;
/**
 * Watchdog (6 Nov, 11:30 IST): after a restart every tick arrived with an old exchange time, all were dropped, and
 * every reference read stale for ~12 minutes until the next deploy reconnected. When ticks keep arriving but none
 * has been accepted for this long, the worker asks for a fresh upstream connection.
 */
export const FRESH_FEED_STALL_MS = 60_000;
/** The most tokens this consumer may hold on the shared connection (7 Nov: 250 -> 400; the worker's plan also
 * keeps within the connection's free headroom, see freshTokenCapacity). */
export const FRESH_FEED_MAX_TARGETS = 400;
export class FreshSharedFeed {
    private epoch = 0;
    private lastTickAt = 0;
    private lastRawAt = 0;
    private lastAcceptedAt = 0;
    private watchSince = 0;
    private closed = false;
    private readonly connectionId = randomUUID();
    private books = new Map<string, FreshQuote[]>();
    private referenceHistory=new Map<string,Tick[]>();
    private latest = new Map<string, Tick>();
    private listeners = new Set<() => void>();
    private targets = new Map<string, SubscriptionTarget>();
    private mcxContracts = new Map<string, { product: string; lot: number }>();
    private mcxEvidence = new Map<string, { samples: number; nonMultiple: number }>();
    private removeTick: (() => void) | null = null;
    /** Futures signal id → its spot index id (NSE/BSE index references), for the basis-adjusted quiet-signal reading. */
    private pairs = new Map<string, string>();
    private basis = new Map<string, { value: number; at: number }>();
    private removeRecovery: (() => void) | null = null;
    constructor(private subscriptions: SubscriptionManager, private now: () => number = Date.now, private clientId = 'fresh-start:shared-feed') { }
    get sourceEpoch() { return `ANGEL-SNAP:${this.connectionId}:${this.epoch}`; }
    start() {
        if (this.closed)
            throw Error('FEED_CLOSED');
        if (this.removeTick)
            return;
        this.watchSince = this.now();
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
        if (combined.size > Math.min(FRESH_FEED_MAX_TARGETS, verifiedNewCapacity))
            throw Error('FRESH_SUBSCRIPTION_BUDGET');
        await this.subscriptions.subscribe(this.clientId, [...combined.values()]);
        if (this.closed) {
            this.subscriptions.unsubscribe(this.clientId);
            throw Error('FEED_CLOSED');
        }
        this.targets = combined;
    }
    get subscribedTargets(){return [...this.targets.values()];}
    /** Declares an MCX option book and its verified lot (in premium units) so its depth unit can be inferred and applied. */
    registerMcxDepth(id: string, product: string, lot: number) { if (Number.isSafeInteger(lot) && lot > 1) this.mcxContracts.set(id, { product, lot }); }
    mcxDepthMode(product: string): FreshMcxDepthMode {
        const e = this.mcxEvidence.get(product);
        return !e ? 'UNKNOWN' : e.nonMultiple > 0 ? 'LOTS' : e.samples >= FRESH_MCX_DEPTH_MIN_SAMPLES ? 'UNITS' : 'UNKNOWN';
    }
    mcxDepthModes() { return Object.fromEntries([...this.mcxEvidence.keys()].map(p => [p, { mode: this.mcxDepthMode(p), ...this.mcxEvidence.get(p)! }])); }
    /** Multiplier from the reported depth to premium units: 1 outside MCX, the lot for LOTS, 0 while UNKNOWN. */
    private depthScale(id: string) {
        const c = this.mcxContracts.get(id);
        if (!c) return 1;
        const mode = this.mcxDepthMode(c.product);
        return mode === 'LOTS' ? c.lot : mode === 'UNITS' ? 1 : 0;
    }
    private scaled(q: FreshQuote, tick: number): FreshQuote { const k = this.depthScale(q.contract); return { ...q, tick, bidUnits: q.bidUnits * k, askUnits: q.askUnits * k }; }
    async syncTargets(targets:readonly SubscriptionTarget[],capacity:number){
        const wanted=new Set(targets.map(t=>`${t.exchangeSegment}:${t.token}`));
        for(const [id,t] of this.targets)if(!wanted.has(id)){this.subscriptions.unsubscribe(this.clientId,[t]);this.targets.delete(id);this.books.delete(id);this.latest.delete(id);this.referenceHistory.delete(id);this.basis.delete(id);this.pairs.delete(id);}
        if(targets.length)await this.reserve(targets,capacity);
    }
    /** Declares a futures signal's spot index, so a quiet signal can be read as spot + basis (see FRESH_QUIET_SIGNAL_MAX_AGE_MS). */
    pairReference(signalId:string,spotId:string){if(signalId!==spotId)this.pairs.set(signalId,spotId);}
    private direct(id:string,at:number){const t=this.referenceHistory.get(id)?.filter(x=>x.timestamp<=at&&x.exchangeTimestamp!=null&&x.exchangeTimestamp<=at&&at-x.exchangeTimestamp<=FRESH_REFERENCE_MAX_AGE_MS).at(-1);return t?{price:t.ltp,at:t.exchangeTimestamp!}:null;}
    underlyingAt(id:string,at:number){
      const own=this.direct(id,at);if(own)return own;
      const spotId=this.pairs.get(id),b=this.basis.get(id);if(!spotId||!b||b.at>at||at-b.at>FRESH_QUIET_SIGNAL_MAX_AGE_MS)return null;
      const spot=this.direct(spotId,at);return spot?{price:spot.price+b.value,at:spot.at}:null;
    }
    private updateBasis(signalId:string){
      const spotId=this.pairs.get(signalId),f=this.latest.get(signalId),s=spotId?this.latest.get(spotId):undefined;
      if(f?.exchangeTimestamp==null||s?.exchangeTimestamp==null||Math.abs(f.exchangeTimestamp-s.exchangeTimestamp)>FRESH_BASIS_PAIR_MS)return;
      const prior=this.basis.get(signalId);if(!prior||f.exchangeTimestamp>=prior.at)this.basis.set(signalId,{value:f.ltp-s.ltp,at:f.exchangeTimestamp});
    }
    /** Per exchange segment since the last read: ticks seen, accepted 2-10 s late, dropped (> 10 s late or clock ahead), max lag. */
    private lag=new Map<string,{ticks:number;late:number;dropped:number;skewed:number;maxLagMs:number;droppedLagMs?:[number,number];droppedAheadMs?:[number,number];clockMs?:number}>();
    /** Entry counts of the in-memory maps (memory accounting, 5 Nov cost review). */
    sizes(){let quotes=0,history=0;for(const v of this.books.values())quotes+=v.length;for(const v of this.referenceHistory.values())history+=v.length;return {targets:this.targets.size,books:this.books.size,quotes,referenceTicks:history,latest:this.latest.size,pairs:this.pairs.size};}
    tickLagStats(){const out=Object.fromEntries(this.lag);this.lag.clear();return out;}
    private receive(raw: readonly Tick[]) {
        const ticks:Tick[]=[];
        for (const r of raw) {
            if (r.exchangeTimestamp == null || ![r.exchangeTimestamp, r.timestamp, r.ltp].every(Number.isFinite) || r.ltp <= 0 || r.timestamp > this.now()) continue;
            this.lastRawAt=this.now();
            const st=this.lag.get(r.exchangeSegment??'UNKNOWN')??{ticks:0,late:0,dropped:0,skewed:0,maxLagMs:0};this.lag.set(r.exchangeSegment??'UNKNOWN',st);st.ticks++;
            const ahead=r.exchangeTimestamp-r.timestamp,lagMs=this.now()-r.exchangeTimestamp;
            if(ahead>FRESH_TICK_CLOCK_SKEW_MS||lagMs>FRESH_TICK_MAX_LAG_MS){
              // The range of what a dropped tick looked like (6 Nov: every tick dropped after a restart, cause unknown).
              st.dropped++;st.droppedLagMs=[Math.min(st.droppedLagMs?.[0]??lagMs,lagMs),Math.max(st.droppedLagMs?.[1]??lagMs,lagMs)];st.droppedAheadMs=[Math.min(st.droppedAheadMs?.[0]??ahead,ahead),Math.max(st.droppedAheadMs?.[1]??ahead,ahead)];st.clockMs=this.now()-r.timestamp;continue;}
            if(ahead>0)st.skewed++;else if(lagMs>2000)st.late++;
            st.maxLagMs=Math.max(st.maxLagMs,lagMs);
            this.lastAcceptedAt=this.now();
            ticks.push(ahead>0?{...r,exchangeTimestamp:r.timestamp}:r);
        }
        for (const t of ticks) {
            if (t.exchangeTimestamp == null)
                continue;
            const matches = [...this.targets.entries()].filter(([, v]) => v.token === t.token && v.exchange === t.exchange && v.exchangeSegment === t.exchangeSegment);
            for (const [id] of matches) {
                const old = this.latest.get(id);
                if (t.exchangeTimestamp == null || t.exchangeTimestamp <= 0 || (old?.exchangeTimestamp != null && t.exchangeTimestamp <= old.exchangeTimestamp))
                    continue;
                this.latest.set(id, t);
                this.referenceHistory.set(id,[...(this.referenceHistory.get(id)??[]).filter(x=>this.now()-x.timestamp<=FRESH_REFERENCE_MAX_AGE_MS+500),t].slice(-100));
                if(this.pairs.has(id))this.updateBasis(id);
                for(const [signal,spot] of this.pairs)if(spot===id)this.updateBasis(signal);
                if (t.bid == null || t.ask == null || t.bidQty == null || t.askQty == null)
                    continue;
                // Tick size is added only from a verified exact contract at read time, never inferred from LTP.
                const q: FreshQuote = { contract: id, source: 'ANGEL', epoch: this.sourceEpoch, eventAt: t.exchangeTimestamp, receivedAt: t.timestamp, bid: t.bid, ask: t.ask, bidUnits: t.bidQty, askUnits: t.askQty, tick: 1 };
                if (freshQuoteCode(q, id, 'ANGEL', this.sourceEpoch, this.now()) !== null)
                    continue;
                const mcx = this.mcxContracts.get(id);
                if (mcx) {
                    const e = this.mcxEvidence.get(mcx.product) ?? { samples: 0, nonMultiple: 0 };
                    for (const qty of [t.bidQty, t.askQty]) if (Number.isSafeInteger(qty) && qty > 0) { e.samples++; if (qty % mcx.lot !== 0) e.nonMultiple++; }
                    this.mcxEvidence.set(mcx.product, e);
                }
                const series = (this.books.get(id) ?? []).filter(x => this.now() - x.eventAt <= 2500);
                series.push(q);
                this.books.set(id, series.slice(-100));
            }
        }
        if (ticks.some(t => t.exchangeTimestamp != null && Number.isFinite(t.timestamp) && t.timestamp <= this.now())) this.lastTickAt = Math.max(this.lastTickAt, ...ticks.map(t => Number.isFinite(t.timestamp) && t.timestamp <= this.now() ? t.timestamp : 0));
        this.notify();
    }
    /** Ticks are arriving (last one <= 5 s ago) but none was accepted for FRESH_FEED_STALL_MS. */
    stalled() { const now = this.now(); return this.lastRawAt > 0 && now - this.lastRawAt <= 5000 && now - Math.max(this.lastAcceptedAt, this.watchSince) >= FRESH_FEED_STALL_MS; }
    /** Restarts the stall clock after a reconnect was requested. */
    resetStallClock() { this.watchSince = this.now(); }
    /** True while any tick reached this consumer in the last FRESH_FEED_ALIVE_MS: the connection itself is live. */
    feedAlive() { return this.lastTickAt > 0 && this.now() - this.lastTickAt <= FRESH_FEED_ALIVE_MS; }
    private notify() {
        for (const f of this.listeners)
            f();
    }
    /** The latest open interest reported for this id (SNAP_QUOTE), with its exchange time; null when none. */
    openInterest(id: string): { oi: number; at: number } | null {
        const t = this.latest.get(id);
        return t?.exchangeTimestamp != null && t.oi != null && Number.isFinite(t.oi) && t.oi > 0 ? { oi: t.oi, at: t.exchangeTimestamp } : null;
    }
    /** Milliseconds since the last exchange-stamped tick for this id, or null when none was received (diagnostics only). */
    tickAge(id: string) { const t = this.latest.get(id); return t?.exchangeTimestamp != null ? Math.max(0, this.now() - t.exchangeTimestamp) : null; }
    /**
     * The reference's last trade, if recent enough to act on. Angel One sends a tick only when the contract trades, so a
     * quiet contract (CRUDEOIL ~3 s, NATGASMINI ~5 s, BSE futures, some stocks on 2 Nov) went stale under the old 2 s
     * limit and kept its market WAITING_FOR_EXACT_REFERENCES. The last trade now counts for up to 5 s, but only while the
     * feed itself is live (some tick in the last 2 s), so a dropped connection never reads as a quiet market.
     */
    underlying(id: string): { price: number; at: number } | null {
        const t = this.latest.get(id);
        if (t?.exchangeTimestamp != null && this.now() - t.exchangeTimestamp <= FRESH_REFERENCE_MAX_AGE_MS && this.feedAlive() && t.timestamp <= this.now()) return { price: t.ltp, at: t.exchangeTimestamp };
        // A quiet futures signal: its spot index (live) plus the basis at the signal's last trade (<= 60 s old).
        const spotId = this.pairs.get(id), b = this.basis.get(id);
        if (!spotId || !b || t?.exchangeTimestamp == null || this.now() - t.exchangeTimestamp > FRESH_QUIET_SIGNAL_MAX_AGE_MS || this.now() - b.at > FRESH_QUIET_SIGNAL_MAX_AGE_MS) return null;
        const spot = this.underlying(spotId);
        return spot ? { price: spot.price + b.value, at: spot.at } : null;
    }
    futuresObservation(id:string,tick:number){const value=this.underlying(id),t=this.latest.get(id);return value&&t?{contract:id,price:value.price,tick,source:'ANGEL',epoch:this.sourceEpoch,eventAt:value.at,receivedAt:t.timestamp}:null;}
    quote(id: string, tick: number): FreshQuote | null {
        const q = this.books.get(id)?.at(-1);
        if (!q || this.latest.get(id)?.exchangeTimestamp !== q.eventAt)
            return null;
        const value = this.scaled(q, tick);
        return freshQuoteCode(value, id, 'ANGEL', this.sourceEpoch, this.now()) === null ? value : null;
    }
    /**
     * The latest book for a model input only (the parity basis), when it is at most maxAgeMs old in exchange time.
     * Never a traded price: entries and marks use quote() / firstAsk(), which keep the 2-second rule.
     */
    modelQuote(id: string, tick: number, maxAgeMs: number): FreshQuote | null {
        const q = this.books.get(id)?.at(-1);
        if (!q || this.latest.get(id)?.exchangeTimestamp !== q.eventAt)
            return null;
        const value = this.scaled(q, tick), now = this.now();
        if (freshQuoteCode(value, id, 'ANGEL', this.sourceEpoch, value.receivedAt) !== null || value.receivedAt > now || now - value.eventAt > maxAgeMs)
            return null;
        return value;
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
                    const value = this.scaled(q, tick);
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
