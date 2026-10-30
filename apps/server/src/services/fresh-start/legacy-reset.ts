import { createHash } from 'node:crypto';
import { sql } from '../../lib/db.js';
import { redis, scanKeys } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { legacyEntriesAllowed } from '../../config/legacy-entry-policy.js';
/** A retired cached position whose original PG row was deliberately deleted must not be backfilled as a new trade.
 * Move only an unchanged, demonstrably orphaned slot; never flush Redis or remove a surviving position.
 */
export interface LegacyResetIO {
    keys(): Promise<string[]>;
    read(key: string): Promise<string | null>;
    existing(ids: readonly string[]): Promise<ReadonlySet<string>>;
    quarantine(key: string, raw: string): Promise<boolean>;
}
const MOVE = `local current=redis.call('GET',KEYS[1])
if current~=ARGV[1] then return 0 end
redis.call('SET',KEYS[2],current,'EX',2592000)
redis.call('DEL',KEYS[1])
return 1`;
const liveIO: LegacyResetIO = {
    keys: () => scanKeys('trade_setup:*'), read: key => redis.get(key),
    existing: async (ids) => new Set((await sql<{
        id: string;
    }[]> `SELECT id FROM signals WHERE id=ANY(${[...ids]})`).map(x => x.id)),
    quarantine: async (key, raw) => Number(await redis.eval(MOVE, 2, key, `legacy_slot_quarantine:${createHash('sha256').update(key).update(raw).digest('hex')}`, raw)) === 1,
};
export async function reconcileRetiredLegacySlots(io: LegacyResetIO = liveIO) {
    const report = { checked: 0, quarantined: 0, surviving: 0, unlinked: 0, changed: 0 };
    if (legacyEntriesAllowed())
        return report;
    const slots: Array<{
        key: string;
        raw: string;
        id: string;
    }> = [];
    for (const key of await io.keys()) {
        const raw = await io.read(key);
        if (!raw)
            continue;
        let value: any;
        try {
            value = JSON.parse(raw);
        }
        catch {
            report.unlinked++;
            continue;
        }
        if (!value?.available)
            continue;
        report.checked++;
        if (typeof value.signalId !== 'string' || !value.signalId) {
            report.unlinked++;
            continue;
        }
        slots.push({ key, raw, id: value.signalId });
    }
    // A failed source-of-truth read throws BEFORE any mutation. Empty successful rows are distinct from failure.
    const existing = slots.length ? await io.existing(slots.map(x => x.id)) : new Set<string>();
    for (const s of slots) {
        if (existing.has(s.id)) {
            report.surviving++;
            continue;
        }
        if (await io.quarantine(s.key, s.raw))
            report.quarantined++;
        else
            report.changed++;
    }
    logger.info(report, 'Retired legacy slots reconciled; missing PostgreSQL trades quarantined without recreating history');
    return report;
}
