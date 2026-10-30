import { afterEach, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => new Map<string, number>());
vi.mock('../../lib/redis.js', () => ({ redis: {
  get: async (key: string) => store.get(key) ?? null,
  eval: async (_lua: string, _n: number, key: string, limit: number) => {
    const used = store.get(key) ?? 0; if (used >= limit) return 0;
    store.set(key, used + 1); return 1;
  },
} }));
const { automaticReviewDailyLimit, automaticReviewBudgetAvailable, reserveAutomaticReviewBudget } = await import('../auto-review-budget.js');
const previous = process.env.AUTO_TRADE_REVIEW_DAILY_LIMIT;
afterEach(() => { vi.useRealTimers(); store.clear(); if (previous == null) delete process.env.AUTO_TRADE_REVIEW_DAILY_LIMIT; else process.env.AUTO_TRADE_REVIEW_DAILY_LIMIT = previous; });
it('bounds background attempts, keeps the counter across reads, and resets on the next IST day', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T18:29:00Z'));
  process.env.AUTO_TRADE_REVIEW_DAILY_LIMIT = '2';
  expect(await automaticReviewBudgetAvailable()).toBe(true);
  expect(await reserveAutomaticReviewBudget()).toBe(true);
  expect(await reserveAutomaticReviewBudget()).toBe(true);
  expect(await reserveAutomaticReviewBudget()).toBe(false);
  expect(await automaticReviewBudgetAvailable()).toBe(false);
  vi.setSystemTime(new Date('2026-10-30T18:31:00Z'));
  expect(await automaticReviewBudgetAvailable()).toBe(true);
});
it('uses a bounded default for invalid configuration', () => {
  for (const value of ['0', '-1', 'NaN', '1001', '1.5']) { process.env.AUTO_TRADE_REVIEW_DAILY_LIMIT = value; expect(automaticReviewDailyLimit()).toBe(20); }
});
