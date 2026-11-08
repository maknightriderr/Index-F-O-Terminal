// 8 Nov audit fixes on the real paper store (PGlite, 047): the Dhan engine trades its own paper book (owner D4) — its
// own cash, reservations and one-position-per-instrument — and an expiry-gamma (premium-exit) candidate may enter until
// its own 15:00 window instead of one hour before the cutoff.
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { FreshPaperStore, type FreshDb, type FreshEntryRequest } from '../fresh-start/store.js';
import { FRESH_PACK_VERSION, freshAccountId } from '@fno/analytics';

let pg: PGlite;
function client(db: any): FreshDb { return { unsafe: async (q, p = []) => ((await db.query(q, p.map((x: any) => x instanceof Date ? x.toISOString() : x))).rows), begin: (fn) => db.transaction((tx: any) => fn(client(tx))) }; }
const at = Date.UTC(2026, 9, 30, 6, 0);
const session = '2026-10-30';
function request(id: string, strategy: string, extra: Partial<FreshEntryRequest['candidate']> = {}, contract: Partial<FreshEntryRequest['contract']> = {}): FreshEntryRequest {
  const candidate = { id, parentId: `p-${id}`, version: FRESH_PACK_VERSION, strategy: strategy as any, direction: 'BULLISH' as const, instrument: 'NIFTY-FUT', sourceEpoch: 'e1', session, at, referenceEntry: 100, stop: 95, target: 115, atr: 4, expiresAt: at + 2000, origin: at - 100000, evidence: {}, ...extra };
  return {
    accountId: freshAccountId(candidate), session, capital: 1000000, riskGroup: 'INDEX', candidate,
    contract: { id: `opt-${id}`, sourceEpoch: 'e1', source: 'ANGEL', lotQuantity: 25, multiplier: 1, expiryTradableSessions: 3, market: 'NSE_INDEX_OPTIONS', delta: 0.55, metadataVerified: true, modelVerified: true, feesVerified: true, targetPremiumScenarios: [175, 170], invalidationPremiumScenarios: [90, 85], explicitRoundTripCostPerUnit: 1, ...contract },
    quote: { contract: `opt-${id}`, source: 'ANGEL', epoch: 'e1', eventAt: at + 300, receivedAt: at + 300, bid: 100, ask: 100.5, bidUnits: 5000, askUnits: 5000, tick: 0.5 },
    now: at + 300, arrivalAt: at + 250, currentUnderlying: 100, cutoff: at + 14400000, calendarVerified: true, eventClear: true, legacyPositionOpen: false, marks: {},
  };
}
let store: FreshPaperStore;
beforeAll(async () => { pg = new PGlite(); await pg.exec(readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql', import.meta.url), 'utf8')); }, 30000);
beforeEach(async () => { await pg.exec('TRUNCATE fresh_paper_events,fresh_paper_positions,fresh_candidates,fresh_parent_moves,fresh_paper_accounts CASCADE'); store = new FreshPaperStore(client(pg), () => true, () => at + 300, () => undefined); });
afterAll(async () => { await pg.close(); });

describe('separate paper books', () => {
  it('a DHAN trade and a fresh-start trade on the same instrument both fill, each in its own account', async () => {
    expect(await store.enter(request('f1', 'NEW_INDEX_BREADTH_V1'))).toMatchObject({ ok: true, code: 'FILLED' });
    expect(await store.enter(request('d1', 'DHAN_A_SWEEP_ABSORPTION'))).toMatchObject({ ok: true, code: 'FILLED' });
    const rows = (await pg.query<any>('SELECT id, account_id FROM fresh_paper_positions ORDER BY id')).rows;
    expect(rows).toEqual([{ id: 'd1', account_id: `${FRESH_PACK_VERSION}:DHAN:${session}` }, { id: 'f1', account_id: `${FRESH_PACK_VERSION}:${session}` }]);
    // Inside one book the one-position-per-instrument rule still holds.
    expect(await store.enter(request('d2', 'DHAN_D_VWAP_PROFILE_REJECTION'))).toMatchObject({ ok: false, code: 'EXPOSURE_OR_PARENT' });
    expect(await store.enter(request('f2', 'NEW_MCX_FLOW_V1'))).toMatchObject({ ok: false, code: 'EXPOSURE_OR_PARENT' });
  });
  it('the schema still allows only one account per session and book', async () => {
    await pg.query("INSERT INTO fresh_paper_accounts(id,session,version,capital) VALUES ('x:DHAN:2026-10-30','2026-10-30',$1,1)", [FRESH_PACK_VERSION]);
    await expect(pg.query("INSERT INTO fresh_paper_accounts(id,session,version,capital) VALUES ('y:DHAN:2026-10-30','2026-10-30',$1,1)", [FRESH_PACK_VERSION])).rejects.toThrow(/duplicate|unique/i);
  });
  it('account views reserve only their own book', async () => {
    await store.enter(request('d1', 'DHAN_A_SWEEP_ABSORPTION'));
    const fresh = await store.accountView(`${FRESH_PACK_VERSION}:${session}`, 1000000, {}, at + 400);
    const dhan = await store.accountView(`${FRESH_PACK_VERSION}:DHAN:${session}`, 1000000, {}, at + 400);
    expect(fresh).toMatchObject({ reservedRisk: 0, openPositions: 0 });
    expect(dhan.openPositions).toBe(1);
    expect(dhan.reservedRisk).toBeGreaterThan(0);
  });
});

describe('expiry-gamma entry window at the store', () => {
  const pe = { stopFraction: 0.3, exitAt: at + 3_000_000, entryUntil: at + 1_800_000, minAbsDelta: 0.55, maxAbsDelta: 0.85, expiryDay: session };
  it('enters inside the last hour before the cutoff (its window ends at entryUntil); a normal candidate cannot', async () => {
    const near = { cutoff: at + 3_000_000 };
    const g = { ...request('g1', 'DHAN_EXPIRY_GAMMA', { premiumExit: pe, expiresAt: at + 20_000 }, { expiryTradableSessions: 0, delta: 0.7 }), ...near };
    expect(await store.enter(g)).toMatchObject({ ok: true, code: 'FILLED' });
    const n = { ...request('n1', 'NEW_INDEX_BREADTH_V1', { instrument: 'BANKNIFTY-FUT' }), ...near };
    expect(await store.enter(n)).toMatchObject({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' });
    const late = { ...request('g2', 'DHAN_EXPIRY_GAMMA', { instrument: 'SENSEX-FUT', premiumExit: { ...pe, entryUntil: at + 200 }, expiresAt: at + 20_000 }, { expiryTradableSessions: 0, delta: 0.7 }), ...near };
    expect(await store.enter(late)).toMatchObject({ ok: false, code: 'ENTRY_EXPIRED_OR_EARLY' });
  });
});
