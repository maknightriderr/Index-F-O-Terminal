import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { FreshPaperStore, type FreshDb, type FreshEntryRequest } from '../fresh-start/store.js';
import { FRESH_PACK_VERSION } from '@fno/analytics';
let pg: PGlite;
function client(db: any): FreshDb { return { unsafe: async (q, p = []) => ((await db.query(q, p.map((x: any) => x instanceof Date ? x.toISOString() : x))).rows), begin: fn => db.transaction((tx: any) => fn(client(tx))) }; }
const at = Date.UTC(2026, 9, 30, 6, 0);
function request(id = 'c1', instrument = 'NIFTY-FUT', group = 'INDEX'): FreshEntryRequest {
    return { accountId: 'acct:2026-10-30', session: '2026-10-30', capital: 1000000, riskGroup: group,
        candidate: { id, parentId: 'parent', version: FRESH_PACK_VERSION, strategy: 'NEW_ORB_RETEST_V1', direction: 'BULLISH', instrument, sourceEpoch: 'e1', session: '2026-10-30', at, referenceEntry: 100, stop: 95, target: 115, atr: 4, expiresAt: at + 2000, origin: at - 100000, evidence: {} },
        contract: { id: 'option1', sourceEpoch: 'e1', source: 'ANGEL', lotQuantity: 25, multiplier: 1, expiryTradableSessions: 3, market: 'NSE_INDEX_OPTIONS', delta: .55, metadataVerified: true, modelVerified: true, feesVerified: true, targetPremiumScenarios: [175, 170], invalidationPremiumScenarios: [90, 85], explicitRoundTripCostPerUnit: 1 },
        quote: { contract: 'option1', source: 'ANGEL', epoch: 'e1', eventAt: at + 300, receivedAt: at + 300, bid: 100, ask: 100.5, bidUnits: 5000, askUnits: 5000, tick: .5 }, now: at + 300, arrivalAt: at + 250, currentUnderlying: 100, cutoff: at + 14400000, calendarVerified: true, eventClear: true, legacyPositionOpen: false, marks: {} };
}
let store: FreshPaperStore;
beforeAll(async () => { pg = new PGlite(); const text = readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql', import.meta.url), 'utf8'); await pg.exec(text); await pg.exec(text); }, 30000);
beforeEach(async () => { await pg.exec('TRUNCATE fresh_paper_events,fresh_paper_positions,fresh_candidates,fresh_parent_moves,fresh_paper_accounts CASCADE'); store = new FreshPaperStore(client(pg), () => true,()=>at+300); });
afterAll(async () => { await pg.close(); });
async function count(table: string) {
    return (await pg.query<{
        n: number;
    }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
}
describe('fresh-start durable account and fills', () => {
    it('recognizes an already committed fill on late duplicate delivery without reserving or minting again',async()=>{
        const r=request();await store.enter(r);
        expect(await new FreshPaperStore(client(pg),()=>true,()=>at+60000).enter(r)).toMatchObject({ok:true,code:'ALREADY_FILLED'});
        expect(await count('fresh_paper_positions')).toBe(1);expect(await count('fresh_candidates')).toBe(1);expect(await count('fresh_paper_events')).toBe(1);
    });
    it.each(['SELECT id FROM fresh_paper_portfolio','SELECT status,closed_at,strategy','INSERT INTO fresh_paper_events'].flatMap(checkpoint=>['quote','setup','cutoff','backward-clock','invalid-clock'].map(kind=>({checkpoint,kind}))))('rolls back $kind invalidation during $checkpoint',async({checkpoint,kind})=>{
        const r=request();r.candidate.expiresAt=at+60000;
        let now=r.now;const c=client(pg);
        if(kind==='setup')r.candidate.expiresAt=at+500;
        if(kind==='cutoff')r.cutoff=at+3600000+500;
        const delayed:FreshDb={...c,begin:fn=>c.begin(tx=>fn({...tx,unsafe:async(q,p)=>{
            const rows=await tx.unsafe(q,p);
            if(q.includes(checkpoint))now=kind==='quote'?at+2501:kind==='setup'?at+501:kind==='cutoff'?at+500:kind==='backward-clock'?at+299:NaN;
            return rows;
        }}))};
        const before=JSON.stringify(r),expected=kind==='quote'?'STALE_OR_FUTURE_QUOTE':kind.endsWith('clock')?'ENTRY_CLOCK_UNAVAILABLE':'ENTRY_EXPIRED_OR_EARLY';
        expect(await new FreshPaperStore(delayed,()=>true,()=>now).enter(r)).toMatchObject({ok:false,code:expected});
        for(const table of ['fresh_paper_accounts','fresh_candidates','fresh_parent_moves','fresh_paper_positions','fresh_paper_events'])expect(await count(table)).toBe(0);
        expect(JSON.stringify(r)).toBe(before);
    });
    it('records admission time from the current clock without modifying the original request or selected quote',async()=>{
        const r=request(),before=JSON.stringify(r);
        expect(await new FreshPaperStore(client(pg),()=>true,()=>at+400).enter(r)).toMatchObject({ok:true,code:'FILLED'});
        const [p]=await store.recover();expect(p.state.openedAt).toBe(at+400);
        const event=(await pg.query<any>("SELECT evidence,at FROM fresh_paper_events WHERE kind='ENTRY_FILL'")).rows[0];
        expect(event.evidence.request.now).toBe(at+400);expect(event.evidence.request.quote).toEqual(r.quote);expect(new Date(event.at).getTime()).toBe(at+400);expect(JSON.stringify(r)).toBe(before);
    });
    it('rechecks every held mark before commit and preserves existing exposure if a mark ages while the new quote stays fresh',async()=>{
        const first=request();await store.enter(first);
        const r=request('c2','TCS','IT');r.now=at+2000;r.candidate.at=at+1700;r.arrivalAt=at+1950;r.candidate.expiresAt=at+4000;r.quote={...r.quote,eventAt:r.now,receivedAt:r.now};r.marks={c1:first.quote};
        let now=r.now;const c=client(pg),before=(await pg.query<any>('SELECT state FROM fresh_paper_positions')).rows;
        const delayed:FreshDb={...c,begin:fn=>c.begin(tx=>fn({...tx,unsafe:async(q,p)=>{const rows=await tx.unsafe(q,p);if(q.includes('INSERT INTO fresh_paper_events'))now=at+2301;return rows;}}))};
        expect(await new FreshPaperStore(delayed,()=>true,()=>now).enter(r)).toMatchObject({ok:false,code:'ACCOUNT_PAUSED'});
        expect((await pg.query<any>('SELECT state FROM fresh_paper_positions')).rows).toEqual(before);expect(await count('fresh_candidates')).toBe(1);expect(await count('fresh_paper_events')).toBe(1);
    });
    it.each(['SELECT id FROM fresh_paper_portfolio','INSERT INTO fresh_candidates','INSERT INTO fresh_paper_events'])('rolls back new spending when entry activation is revoked during %s',async(checkpoint)=>{
        let enabled=true,revoked=false;const c=client(pg);
        const delayed:FreshDb={...c,begin:fn=>c.begin(tx=>fn({...tx,unsafe:async(q,p)=>{
            const rows=await tx.unsafe(q,p);if(q.includes(checkpoint)){enabled=false;revoked=true;}return rows;
        }}))};
        expect(await new FreshPaperStore(delayed,()=>enabled,()=>at+300).enter(request())).toMatchObject({ok:false,code:'PAPER_DISABLED'});
        expect(revoked).toBe(true);
        for(const table of ['fresh_paper_accounts','fresh_candidates','fresh_parent_moves','fresh_paper_positions','fresh_paper_events'])expect(await count(table)).toBe(0);
        expect(await store.enter(request())).toMatchObject({ok:true,code:'FILLED'});
    });
    it('defaults to disabled with no database calls or broker side effects', async () => { const calls: FreshDb = { unsafe: async () => { throw Error('MUST_NOT_QUERY'); }, begin: async () => { throw Error('MUST_NOT_QUERY'); } }; expect(await new FreshPaperStore(calls).enter(request())).toEqual({ ok: false, code: 'PAPER_DISABLED' }); });
    it('migrates idempotently and commits one fill/reservation despite duplicate entry delivery', async () => { const r = request(); expect(await store.enter(r)).toMatchObject({ ok: true, code: 'FILLED' }); expect(await store.enter(r)).toMatchObject({ ok: true, code: 'ALREADY_FILLED' }); expect(await count('fresh_paper_positions')).toBe(1); expect(await count('fresh_paper_events')).toBe(1); const [p] = await store.recover(); expect(p.state.originalRiskCurrency).toBe(1987.5); });
    it('serializes competing account requests and refuses correlated/underlying stacking', async () => { const r = request(), r2 = request('c2'); r2.marks = { c1: r.quote }; const results = await Promise.all([store.enter(r), store.enter(r2)]); expect(results.filter(x => x.ok)).toHaveLength(1); expect(await count('fresh_paper_positions')).toBe(1); });
    it('requires marks of every held risk before allowing a different group', async () => { await store.enter(request()); const r = request('c2', 'TCS', 'IT'); expect(await store.enter(r)).toMatchObject({ ok: false, code: 'ACCOUNT_PAUSED' }); r.candidate.id = 'c3'; r.marks = { c1: r.quote }; expect(await store.enter(r)).toMatchObject({ ok: true, code: 'FILLED' }); expect(await count('fresh_paper_positions')).toBe(2); });
    it('persists pending exits across restart; fills once with entry switch disabled and releases exposure', async () => { const r = request(); await store.enter(r); const restarted = new FreshPaperStore(client(pg), () => false); const t = at + 1000, e = { at: t, underlying: 116, underlyingAt: t, quote: null, cutoff: r.cutoff, barsSinceFill: 1, trail: false }; expect(await restarted.observe(r.accountId, 'c1', e)).toBe(true); expect((await restarted.recover())[0].state.state).toBe('EXIT_PENDING'); const q = { ...r.quote, eventAt: t + 300, receivedAt: t + 300, bid: 70, ask: 70.5 }; await restarted.observe(r.accountId, 'c1', { ...e, at: t + 300, underlyingAt: t + 300, quote: q }); expect(await restarted.recover()).toEqual([]); expect(await restarted.observe(r.accountId, 'c1', { ...e, at: t + 400, quote: q })).toBe(false); const a = (await pg.query<any>('SELECT * FROM fresh_paper_accounts')).rows[0]; expect(a.realized_net).toBe(-2437.5); expect(a.consecutive_losses).toBe(1); expect(await count('fresh_paper_events')).toBe(3); });
    it('rolls back account, candidate and reservations when a fill event cannot be persisted', async () => {
        const c = client(pg), broken: FreshDb = { ...c, begin: fn => c.begin(tx => fn({ ...tx, unsafe: async (q, p) => {
                    if (q.includes('INSERT INTO fresh_paper_events'))
                        throw Error('storage unavailable');
                    return tx.unsafe(q, p);
                } })) };
        await expect(new FreshPaperStore(broken, () => true,()=>at+300).enter(request())).rejects.toThrow('storage unavailable');
        expect(await count('fresh_paper_accounts')).toBe(0);
        expect(await count('fresh_paper_positions')).toBe(0);
    });
    it('blocks unresolved prior-session exposure when a new account day starts', async () => {
        await store.enter(request());
        const next = request('c2', 'TCS', 'IT');
        next.session = '2026-11-02';
        next.accountId = 'acct:2026-11-02';
        next.candidate = { ...next.candidate, session: next.session };
        expect(await store.enter(next)).toMatchObject({ ok: false, code: 'ACCOUNT_PAUSED' });
        expect(await count('fresh_paper_positions')).toBe(1);
    });
    it('does not pool capital/version/session changes into an existing account', async () => { await store.enter(request()); const r = request('c2'); r.capital = 2000000; expect(await store.enter(r)).toMatchObject({ ok: false, code: 'ACCOUNT_COHORT_MISMATCH' }); });
});
