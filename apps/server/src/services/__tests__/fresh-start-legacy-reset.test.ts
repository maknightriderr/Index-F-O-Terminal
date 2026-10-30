import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/db.js', () => ({ sql: () => { throw Error('TEST_UNEXPECTED_SQL'); } }));
vi.mock('../../lib/redis.js', () => ({ redis: {}, scanKeys: async () => [] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() { } } }));
import { reconcileRetiredLegacySlots, type LegacyResetIO } from '../fresh-start/legacy-reset.js';
function fixture() {
    const cache = new Map([['trade_setup:NSE:NIFTY:INTRADAY', JSON.stringify({ available: true, signalId: 'deleted' })], ['trade_setup:NSE:TCS:POSITIONAL', JSON.stringify({ available: true, signalId: 'survives' })], ['trade_setup:NSE:INFY:POSITIONAL', JSON.stringify({ available: true })]]), quarantined = new Map();
    const io: LegacyResetIO = { keys: async () => [...cache.keys()], read: async (k) => cache.get(k) ?? null, existing: async () => new Set(['survives']), quarantine: async (k, raw) => {
            if (cache.get(k) !== raw)
                return false;
            quarantined.set(k, raw);
            cache.delete(k);
            return true;
        } };
    return { cache, quarantined, io };
}
describe('user-deleted legacy PostgreSQL history', () => {
    it('quarantines only proven missing slots, preserves surviving positions and flags unlinked uncertainty', async () => { const f = fixture(), r = await reconcileRetiredLegacySlots(f.io); expect(r).toMatchObject({ checked: 3, quarantined: 1, surviving: 1, unlinked: 1 }); expect(f.cache.has('trade_setup:NSE:TCS:POSITIONAL')).toBe(true); expect(f.quarantined.size).toBe(1); expect((await reconcileRetiredLegacySlots(f.io)).quarantined).toBe(0); });
    it('leaves every slot intact when PostgreSQL is unavailable', async () => { const f = fixture(); f.io.existing = async () => { throw Error('DB unavailable'); }; await expect(reconcileRetiredLegacySlots(f.io)).rejects.toThrow('DB unavailable'); expect(f.cache.size).toBe(3); expect(f.quarantined.size).toBe(0); });
    it('uses compare-and-move so a concurrent replacement cannot be removed', async () => { const f = fixture(); f.io.existing = async () => { f.cache.set('trade_setup:NSE:NIFTY:INTRADAY', 'changed'); return new Set(['survives']); }; expect((await reconcileRetiredLegacySlots(f.io)).changed).toBe(1); expect(f.cache.get('trade_setup:NSE:NIFTY:INTRADAY')).toBe('changed'); });
});
