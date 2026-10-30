import { describe, it, expect, vi, afterEach } from 'vitest';
const m = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('../../lib/db.js', () => { const sql: any = async (s: TemplateStringsArray) => s.join(' ').includes("WHERE official_status = 'OPEN'") ? m.rows : []; sql.json = (v: unknown) => v; return { sql }; });
vi.mock('../../lib/logger.js', () => ({ logger: { info() { }, warn() { }, error() { }, debug() { } } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
import { legacyEntriesAllowed, LEGACY_NEW_ENTRIES_ENABLED } from '../../config/legacy-entry-policy.js';
import * as engine from '../experiment-engine.js';
import { armFor, openPosition, type ExpCandidate } from '../experiment-arms.js';
afterEach(() => { engine.__resetExperimentEngine(); vi.restoreAllMocks(); vi.unstubAllEnvs(); m.rows = []; });
describe('actual production legacy retirement policy', () => {
    it('cannot be bypassed by legacy environment flags or experiment entry toggles', async () => {
        for (const k of ['STRUCTURE', 'CONSENSUS_SETUPS', 'RESEARCH_PAPER_TRADING', 'OF1_TRADING', 'EXPERIMENT_NEW_ENTRIES'])
            vi.stubEnv(k, 'on');
        expect(LEGACY_NEW_ENTRIES_ENABLED).toBe(false);
        expect(legacyEntriesAllowed()).toBe(false);
        expect(engine.experimentEntriesEnabled()).toBe(false);
        engine.__startedForTest();
        const build = vi.fn();
        await engine.onIndicatorPoll({ symbol: 'TCS', exchange: 'NSE', mode: 'INTRADAY', at: Date.now(), direction: 'BULLISH', confidence: 90, chain: { strikes: [] }, buildCandidate: build, triggerCandidates: [{ source: 'A3', candidateId: 'test', build }], confirmMs: 300000, lastClosedBar: null } as any);
        expect(build).not.toHaveBeenCalled();
        expect(engine.__positions()).toEqual([]);
    });
    it('restores a legacy position and processes its structural exit while entries remain retired', async () => {
        const at = Date.UTC(2026, 9, 26, 5), c: ExpCandidate = { at, candidateId: 'old', symbol: 'TCS', exchange: 'NSE', mode: 'INTRADAY', direction: 'BULLISH', confidence: 90, side: 'CE', strike: 2400, expiry: '2026-10-27', token: '43210', lotSize: 175, entry: 100, stop: 70, target: 130, costPct: 2.5, statutoryPct: .15, brokeragePerLotInr: 47.2, minutesSinceOpen: 120, behindLevel: 2380, atr: 10, quote: { ltp: 100, bid: 99.5, ask: 100.5, bidQty: 1000, askQty: 1000, exchangeAt: at, receivedAt: at, feedState: null, source: 'CHAIN' } };
        const saved = openPosition(armFor('V2', 'IND-V2-INVALIDATION-1.1')!, c, 'legacy-position', at);
        m.rows = [{ state: JSON.parse(JSON.stringify(saved)) }];
        vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as any);
        engine.startExperimentEngine();
        await vi.waitFor(() => expect(engine.__positions()).toHaveLength(1));
        const loaded = engine.__positions()[0];
        const later = at + 1800000, build = vi.fn();
        await engine.onIndicatorPoll({ at: later, symbol: 'TCS', exchange: 'NSE', mode: 'INTRADAY', direction: 'BULLISH', confidence: 90, confirmMs: 300000, lastClosedBar: { close: 2370, closeAt: later }, chain: { expiry: c.expiry, spotPrice: 2370, strikes: [{ strike: 2400, call: { token: c.token, ltp: 90, bid: 89.5, ask: 90.5, bidQty: 1000, askQty: 1000, timestamp: later, exchangeTimestamp: later - 1000 } }] }, buildCandidate: build } as any);
        expect(loaded.official).toMatchObject({ status: 'CLOSED', reason: 'STRUCTURE_INVALIDATED' });
        expect(build).not.toHaveBeenCalled();
        expect(legacyEntriesAllowed()).toBe(false);
    });
});
