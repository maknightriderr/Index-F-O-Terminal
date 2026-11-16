// 16 Nov (owner): every strategy learns from its own closed paper trades — the new engine (runtime screen) and the
// legacy engine (late session / expiry day / losing streak).
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/redis.js', () => ({ scanKeys: vi.fn(async () => []) }));
vi.mock('../../lib/db.js', () => ({ sql: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { FreshRuntime } from '../fresh-start/runtime.js';
import { FreshLearning, freshLessonOutcomes, type FreshClosed } from '../fresh-start/learning.js';
import { legacyLessonOutcomes, legacyLessonRefusal, legacyMinutesToClose, OF1_LEARNING_VERSION_MARK, type LegacyClosed } from '../of1-trend-learning.js';
import { learnLessons } from '@fno/analytics';

const SESSION = '2026-11-16';
const OPEN = Date.parse('2026-11-16T03:45:00Z'), CLOSE = Date.parse('2026-11-16T10:00:00Z');
const closed = (i: number, netR: number, extra: Partial<FreshClosed> = {}): FreshClosed => ({ strategy: 'NEW_MOMENTUM_BREAKOUT_V1', direction: 'BULLISH', session: `2026-10-${String(10 + (i % 18)).padStart(2, '0')}`, openedAt: Date.parse(`2026-10-${String(10 + (i % 18)).padStart(2, '0')}T05:00:00Z`) + i, closedAt: null, netR, exchange: 'NSE', stamped: null, expiryDay: false, ...extra });
// Ten late-session losers (14:30 IST) and eight morning winners.
const WEEKDAYS = ['05', '06', '07', '08', '09', '12', '13', '14', '15', '16'];
const lateLosers = [...WEEKDAYS.map((d, i) => closed(i, -0.7, { openedAt: Date.parse(`2026-10-${d}T09:00:00Z`), session: `2026-10-${d}` })), ...Array.from({ length: 8 }, (_, i) => closed(i + 20, 0.5))];
const cand = (at: number, extra: Record<string, unknown> = {}) => ({ id: `c-${at}`, at, expiresAt: Date.now() + 20_000, origin: at, strategy: 'NEW_MOMENTUM_BREAKOUT_V1', direction: 'BULLISH', instrument: 'NSE_FO:1', session: SESSION, evidence: {}, ...extra }) as any;
const parts = () => {
  const store = { recover: vi.fn(async () => []), observe: vi.fn(), enter: vi.fn(async () => ({ ok: true, code: 'FILLED' })) };
  const adapter = { qualified: true, build: vi.fn(), prepare: vi.fn(async (x: any) => ({ candidate: x, netRR: 2, finish: vi.fn(async () => ({ candidate: x, contract: { expiryTradableSessions: 2 } })) })), watch: vi.fn(async () => {}), audit: vi.fn(async () => {}), decision: vi.fn(async () => {}) };
  return { store, adapter };
};
const learner = async (rows: FreshClosed[], bars: any[] = []) => {
  const l = new FreshLearning({ bars: () => bars, exchange: () => 'NSE', load: async () => rows });
  await l.refresh(Date.parse('2026-11-16T05:00:00Z'));
  return l;
};

describe('new engine learning', () => {
  it('outcomes: R from the record, late session from the open time, streak from earlier closes', () => {
    const out = freshLessonOutcomes([
      closed(0, -1, { session: SESSION, openedAt: OPEN + 60 * 60_000, closedAt: OPEN + 70 * 60_000 }),
      closed(1, -1, { session: SESSION, openedAt: OPEN + 80 * 60_000, closedAt: OPEN + 90 * 60_000 }),
      closed(2, 1, { session: SESSION, openedAt: CLOSE - 30 * 60_000, closedAt: CLOSE - 10 * 60_000 }),
    ]);
    expect(out.map((o) => o.features.priorLossStreak)).toEqual([0, 1, 2]);
    expect(out[2].features.minutesToClose).toBe(30);
    expect(out[0].features.minutesToClose).toBe(375 - 60);
  });

  it('a candidate repeating a learned mistake is refused before pricing, with a LEARNED_ code', async () => {
    const { store, adapter } = parts();
    const rt = new FreshRuntime(store as any, adapter as any, () => true, await learner(lateLosers));
    await rt.recover();
    expect(await rt.onExternalCandidate(cand(CLOSE - 45 * 60_000))).toBe('LEARNED_LATE_SESSION');
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.decision).toHaveBeenCalledWith(expect.objectContaining({ id: `c-${CLOSE - 45 * 60_000}` }), 'LEARNED_LATE_SESSION');
    expect(store.enter).not.toHaveBeenCalled();
  });

  it('the same strategy earlier in the day, and other strategies, are not affected; the situation is stamped', async () => {
    const { store, adapter } = parts();
    const rt = new FreshRuntime(store as any, adapter as any, () => true, await learner(lateLosers));
    await rt.recover();
    expect(await rt.onExternalCandidate(cand(OPEN + 60 * 60_000))).toBe('FILLED');
    const priced = adapter.prepare.mock.calls[0][0];
    expect(priced.evidence.learning).toMatchObject({ minutesToClose: 315, priorLossStreak: 0, trend: null, quiet: null });
    expect(await rt.onExternalCandidate(cand(CLOSE - 45 * 60_000, { id: 'other', strategy: 'HTA_HUMAN_TA_V1' }))).toBe('FILLED');
  });

  it('expiry-day lesson is applied once the contract is known', async () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => closed(i, -0.8, { expiryDay: true })), ...Array.from({ length: 6 }, (_, i) => closed(i + 30, 0.4, { expiryDay: false }))];
    const { store, adapter } = parts();
    adapter.prepare.mockImplementation(async (x: any) => ({ candidate: x, netRR: 2, finish: vi.fn(async () => ({ candidate: x, contract: { expiryTradableSessions: 0 } })) }));
    const rt = new FreshRuntime(store as any, adapter as any, () => true, await learner(rows));
    await rt.recover();
    expect(await rt.onExternalCandidate(cand(OPEN + 60 * 60_000))).toBe('LEARNED_EXPIRY_DAY');
    expect(store.enter).not.toHaveBeenCalled();
  });

  it('nothing learned yet (no closed trades, or the read failed): every candidate continues', async () => {
    const { store, adapter } = parts();
    const failing = new FreshLearning({ bars: () => [], exchange: () => 'NSE', load: async () => { throw new Error('db down'); } });
    await failing.refresh(Date.now());
    const rt = new FreshRuntime(store as any, adapter as any, () => true, failing);
    await rt.recover();
    expect(await rt.onExternalCandidate(cand(CLOSE - 45 * 60_000))).toBe('FILLED');
  });
});

describe('legacy engine: more lessons', () => {
  const t = (i: number, netR: number, minted: string, extra: Partial<LegacyClosed> = {}): LegacyClosed => ({ family: 'A2', direction: 'BULLISH', session: minted.slice(0, 10), mintedAt: Date.parse(minted), closedAt: Date.parse(minted) + 30 * 60_000, netR, exchange: 'NSE', expiry: '2026-12-31', logicVersion: `x${OF1_LEARNING_VERSION_MARK}`, ...extra });
  it('learns expiry-day losses and refuses the next expiry-day entry; only trades since the re-enable mark count', () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => t(i, -0.9, `2026-11-${String(i + 1).padStart(2, '0')}T05:00:00Z`, { expiry: `2026-11-${String(i + 1).padStart(2, '0')}` })), ...Array.from({ length: 6 }, (_, i) => t(i, 0.3, `2026-11-${String(i + 1).padStart(2, '0')}T06:00:00Z`))];
    const learned = learnLessons(legacyLessonOutcomes(rows), Date.parse('2026-11-16T05:00:00Z'));
    expect(learned.byStrategy.A2.lessons.EXPIRY_DAY.block).toBe(true);
    const state = { learned, closed: rows };
    expect(legacyLessonRefusal('A2', 'BULLISH', Date.parse('2026-11-17T05:00:00Z'), 'NSE', '2026-11-17', state)?.code).toBe('LEARNED_EXPIRY_DAY');
    expect(legacyLessonRefusal('A2', 'BULLISH', Date.parse('2026-11-17T05:00:00Z'), 'NSE', '2026-11-20', state)).toBeNull();
    expect(legacyLessonRefusal('OF1', 'BULLISH', Date.parse('2026-11-17T05:00:00Z'), 'NSE', '2026-11-17', state)).toBeNull();
    const before = rows.map((r) => ({ ...r, logicVersion: 'old' }));
    expect(legacyLessonOutcomes(before)).toEqual([]);
  });
  it('session close by exchange (MCX trades late)', () => {
    expect(legacyMinutesToClose('NSE', Date.parse('2026-11-16T09:00:00Z'))).toBe(60);
    expect(legacyMinutesToClose('MCX', Date.parse('2026-11-16T09:00:00Z'))).toBeGreaterThan(300);
    expect(legacyMinutesToClose(null, Date.now())).toBeNull();
  });
});
