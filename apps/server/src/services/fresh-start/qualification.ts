import { randomUUID } from 'node:crypto';
import { getSessionWindow, HOLIDAY_CALENDAR_YEARS, type Instrument } from '@fno/shared';
import type { MarketDataProvider } from '../../providers/interface.js';
import type { SubscriptionManager, SubscriptionTarget } from '../../lib/subscription-manager.js';
import { FreshSharedFeed } from './feed.js';
import { logger } from '../../lib/logger.js';
const state = { status: 'NOT_STARTED', lastCheckAt: null as number | null, sourceEpoch: null as string | null, referenceContracts: 0, optionContracts: 0, observedExecutableBooks: 0, error: null as string | null };
export function freshFeedQualification() { return { ...state }; }
/** Initial qualification scope only. Does not declare an event calendar, model or trading edge verified. */
export function qualificationContracts(master: readonly Instrument[], name: string, date: string, referencePrice: number | null) {
    const valid = (x: Instrument) => x.exchange === 'NSE' && x.segment === 'FO' && x.name === name && x.expiry != null && x.expiry > date && Number.isSafeInteger(x.lotSize) && x.lotSize > 0 && Number.isFinite(x.tickSize) && x.tickSize > 0;
    const future = master.filter(x => valid(x) && x.instrumentType === 'FUTIDX').sort((a, b) => a.expiry!.localeCompare(b.expiry!) || a.token.localeCompare(b.token))[0];
    if (!future)
        return { future: null, options: [] as Instrument[] };
    if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0)
        return { future, options: [] as Instrument[] };
    const eligible = master.filter(x => valid(x) && x.instrumentType === 'OPTIDX' && x.strike != null && x.strike > 0);
    const expiries = [...new Set(eligible.map(x => x.expiry!))].sort().slice(0, 2);
    const strikes = [...new Set(eligible.map(x => x.strike!))].sort((a, b) => Math.abs(a - referencePrice) - Math.abs(b - referencePrice) || a - b).slice(0, 5);
    // Both CE and PE may be observed; this is diagnostics, with no entry selection or Greek/model claims.
    return { future, options: eligible.filter(x => expiries.includes(x.expiry!) && strikes.includes(x.strike!) && ['CE', 'PE'].includes(x.optionType ?? '')).slice(0, 20) };
}
export function startFreshFeedQualification(provider: MarketDataProvider, subscriptions: SubscriptionManager) {
    const newFeed = () => { const f = new FreshSharedFeed(subscriptions, Date.now, `fresh-start:qualification:${randomUUID()}`); f.start(); return f; };
    let feed = newFeed(), stopped = false, running = false, master: Instrument[] = [], masterDay = '';
    const tick = async () => {
        if (stopped || running)
            return;
        running = true;
        try {
            const now = Date.now(), date = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), session = getSessionWindow('NSE', date);
            state.lastCheckAt = now;
            state.error = null;
            if (!HOLIDAY_CALENDAR_YEARS.includes(Number(date.slice(0, 4)))) {
                state.status = 'BLOCKED_CALENDAR_YEAR';
                return;
            }
            if (!session || now < session.open || now >= session.close) {
                if (masterDay) {
                    feed.close();
                    feed = newFeed();
                    masterDay = '';
                    master = [];
                    state.referenceContracts = 0;
                    state.optionContracts = 0;
                    state.observedExecutableBooks = 0;
                    state.sourceEpoch = null;
                }
                state.status = 'WAITING_FOR_MARKET';
                return;
            }
            if (!provider.isAuthenticated()) {
                state.status = 'BLOCKED_BROKER_AUTH';
                return;
            }
            if (masterDay !== date) {
                if (masterDay) {
                    feed.close();
                    feed = newFeed();
                }
                master = await provider.getInstrumentMaster();
                if (stopped)
                    return;
                if (!master.length) {
                    state.status = 'BLOCKED_INSTRUMENT_MASTER';
                    return;
                }
                masterDay = date;
            }
            const contracts = ['NIFTY', 'BANKNIFTY'].map(name => qualificationContracts(master, name, date, null));
            const futures = contracts.flatMap(x => x.future ? [x.future] : []);
            if (futures.length !== 2) {
                state.status = 'BLOCKED_EXACT_REFERENCES';
                return;
            }
            const options = futures.flatMap(f => qualificationContracts(master, f.name, date, feed.underlying(`NSE_FO:${f.token}`)?.price ?? null).options);
            const targets: SubscriptionTarget[] = [...futures, ...options].map(x => ({ token: x.token, exchange: 'NSE', exchangeSegment: 'NSE_FO' }));
            // Documented socket limit 1000, with headroom for active-position dependencies. Never evict other consumers.
            const capacity = Math.min(250, 950 - subscriptions.getStatus().subscriptionCount);
            if (capacity < targets.length) {
                state.status = 'BLOCKED_SHARED_SUBSCRIPTION_HEADROOM';
                return;
            }
            await feed.reserve(targets, capacity);
            state.sourceEpoch = feed.sourceEpoch;
            state.referenceContracts = futures.length;
            state.optionContracts = options.length;
            state.observedExecutableBooks = options.filter(x => { const q = feed.quote(`NSE_FO:${x.token}`, x.tickSize); return q != null && q.askUnits >= x.lotSize && q.bidUnits >= x.lotSize && (q.ask - q.bid) / ((q.ask + q.bid) / 2) <= .01; }).length;
            state.status = state.observedExecutableBooks > 0 ? 'BOOKS_OBSERVED_NOT_FULLY_QUALIFIED' : 'WAITING_FOR_OBSERVED_BOOKS';
        }
        catch {
            state.status = 'BLOCKED_FEED_QUALIFICATION';
            state.error = 'Feed qualification failed; automatic retry is pending.';
            logger.warn('Fresh-start shared feed qualification failed; no new paper entry is authorized by this observer');
        }
        finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), 60000);
    return () => { stopped = true; clearInterval(timer); feed.close(); };
}
