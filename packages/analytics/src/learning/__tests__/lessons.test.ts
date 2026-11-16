import { describe, expect, it } from 'vitest';
import { learnLessons, learnedBlocks, lessonLossStreak, lessonMarketRead, lessonRefusal, lessonTags, LESSON_RULES, NO_FEATURES, type LessonOutcome } from '../lessons.js';

const NOW = Date.parse('2026-11-16T10:00:00Z');
const o = (strategy: string, netR: number, f: Partial<typeof NO_FEATURES> = {}, daysAgo = 1): LessonOutcome => ({ strategy, netR, at: NOW - daysAgo * 86_400_000, features: { ...NO_FEATURES, ...f } });
const many = (n: number, mk: (i: number) => LessonOutcome) => Array.from({ length: n }, (_, i) => mk(i));

describe('lessons', () => {
  it('tags only observed situations', () => {
    expect(lessonTags(NO_FEATURES)).toEqual([]);
    expect(lessonTags({ trend: 'COUNTER_TREND', quiet: true, minutesToClose: 60, expiryDay: true, priorLossStreak: 2 })).toEqual(['COUNTER_TREND', 'QUIET_MARKET', 'LATE_SESSION', 'EXPIRY_DAY', 'AFTER_LOSING_STREAK']);
    expect(lessonTags({ trend: 'WITH_TREND', quiet: false, minutesToClose: 200, expiryDay: false, priorLossStreak: 1 })).toEqual([]);
  });

  it('blocks a situation after 10 losing trades in it that did worse than the rest', () => {
    const rows = [...many(10, () => o('S', -0.6, { trend: 'COUNTER_TREND' })), ...many(8, () => o('S', 0.4, { trend: 'WITH_TREND' }))];
    const l = learnLessons(rows, NOW);
    expect(l.byStrategy.S.lessons.COUNTER_TREND).toMatchObject({ trades: 10, avgNetR: -0.6, others: 8, othersAvgNetR: 0.4, block: true });
    expect(learnedBlocks(l)).toEqual(['S:COUNTER_TREND']);
    const r = lessonRefusal('S', { ...NO_FEATURES, trend: 'COUNTER_TREND' }, l);
    expect(r?.code).toBe('LEARNED_COUNTER_TREND');
    expect(r?.reason).toMatch(/10 trades/);
    expect(lessonRefusal('S', { ...NO_FEATURES, trend: 'WITH_TREND' }, l)).toBeNull();
    expect(lessonRefusal('OTHER', { ...NO_FEATURES, trend: 'COUNTER_TREND' }, l)).toBeNull();
  });

  it('does not block with 9 trades, a positive average, or when the situation is no worse than the rest', () => {
    expect(learnLessons(many(9, () => o('S', -1, { quiet: true })), NOW).byStrategy.S.lessons.QUIET_MARKET.block).toBe(false);
    expect(learnLessons(many(12, () => o('S', 0.2, { quiet: true })), NOW).byStrategy.S.lessons.QUIET_MARKET.block).toBe(false);
    // A strategy that loses everywhere has no SPECIFIC lesson.
    const everywhere = [...many(10, () => o('S', -0.5, { quiet: true })), ...many(10, () => o('S', -0.8, { quiet: false }))];
    expect(learnLessons(everywhere, NOW).byStrategy.S.lessons.QUIET_MARKET.block).toBe(false);
    // Too few other trades to compare: a negative average alone is enough.
    const few = [...many(10, () => o('S', -0.5, { quiet: true })), ...many(2, () => o('S', -0.9, { quiet: false }))];
    expect(learnLessons(few, NOW).byStrategy.S.lessons.QUIET_MARKET.block).toBe(true);
  });

  it('unknown situations are counted in neither group', () => {
    const rows = [...many(10, () => o('S', -0.5, { expiryDay: true })), ...many(20, () => o('S', -2))];
    const l = learnLessons(rows, NOW).byStrategy.S.lessons.EXPIRY_DAY;
    expect(l.others).toBe(0); expect(l.block).toBe(true);
  });

  it('the window is rolling: trades older than 60 days no longer count', () => {
    const old = many(10, () => o('S', -1, { minutesToClose: 30 }, LESSON_RULES.windowDays + 1));
    expect(learnLessons(old, NOW).byStrategy.S).toBeUndefined();
  });

  it('each strategy learns only from its own trades', () => {
    const rows = [...many(10, () => o('A', -1, { expiryDay: true })), ...many(10, () => o('B', 1, { expiryDay: true }))];
    const l = learnLessons(rows, NOW);
    expect(l.byStrategy.A.lessons.EXPIRY_DAY.block).toBe(true);
    expect(l.byStrategy.B.lessons.EXPIRY_DAY.block).toBe(false);
  });

  it('a refusal can be limited to some lessons', () => {
    const l = learnLessons(many(10, () => o('S', -1, { expiryDay: true, minutesToClose: 30 })), NOW);
    const f = { ...NO_FEATURES, expiryDay: true, minutesToClose: 30 };
    expect(lessonRefusal('S', f, l, ['EXPIRY_DAY'])?.lesson).toBe('EXPIRY_DAY');
    expect(lessonRefusal('S', f, l, ['QUIET_MARKET'])).toBeNull();
  });

  it('losing streak: consecutive losses, same strategy, direction and session, closed before the entry', () => {
    const h = [
      { strategy: 'S', direction: 'BULLISH', session: 'd', closedAt: 1, netR: -1 },
      { strategy: 'S', direction: 'BULLISH', session: 'd', closedAt: 2, netR: 0.5 },
      { strategy: 'S', direction: 'BULLISH', session: 'd', closedAt: 3, netR: -1 },
      { strategy: 'S', direction: 'BULLISH', session: 'd', closedAt: 4, netR: -0.2 },
      { strategy: 'S', direction: 'BEARISH', session: 'd', closedAt: 5, netR: -1 },
      { strategy: 'T', direction: 'BULLISH', session: 'd', closedAt: 5, netR: -1 },
      { strategy: 'S', direction: 'BULLISH', session: 'd', closedAt: 9, netR: -1 },
    ];
    expect(lessonLossStreak(h, 'S', 'BULLISH', 'd', 6)).toBe(2);
    expect(lessonLossStreak(h, 'S', 'BULLISH', 'd', 3.5)).toBe(1);
    expect(lessonLossStreak(h, 'S', 'BULLISH', 'other', 6)).toBe(0);
  });

  it('market read: trend alignment and quietness from closed 5-minute bars only', () => {
    const T = Date.parse('2026-11-16T04:00:00Z');
    const up = Array.from({ length: 80 }, (_, i) => ({ time: T + i * 300_000, high: 100 + i + 1, low: 100 + i - 1, close: 100 + i }));
    const now = T + 80 * 300_000;
    expect(lessonMarketRead(up, 'BULLISH', now).trend).toBe('WITH_TREND');
    expect(lessonMarketRead(up, 'BEARISH', now).trend).toBe('COUNTER_TREND');
    expect(lessonMarketRead(up, 'BULLISH', now).quiet).toBe(false);
    // Volatility contracting in the last hour.
    const quiet = up.map((b, i) => (i >= 68 ? { ...b, high: b.close + 0.1, low: b.close - 0.1 } : { ...b, high: b.close + 3, low: b.close - 3 }));
    expect(lessonMarketRead(quiet, 'BULLISH', now).quiet).toBe(true);
    // Too few closed bars: unknown, never guessed.
    expect(lessonMarketRead(up.slice(0, 30), 'BULLISH', now)).toEqual({ trend: null, quiet: null });
    // The still-open bar is not read.
    const open = [...up.slice(0, 70), { time: T + 70 * 300_000 + 60_000, high: 500, low: 0, close: 0 }];
    expect(lessonMarketRead(open, "BULLISH", T + 70 * 300_000 + 120_000).trend).toBe("WITH_TREND");
  });
});
