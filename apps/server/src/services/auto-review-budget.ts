// Bound research backlog consumption so it cannot spend the whole shared AI allowance in one burst.
import { redis } from '../lib/redis.js';

export function automaticReviewDailyLimit(): number {
  const value = Number(process.env.AUTO_TRADE_REVIEW_DAILY_LIMIT ?? 20);
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : 20;
}
const budgetKey = () => `ai:auto-review:budget:${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}`;
export async function automaticReviewBudgetAvailable(): Promise<boolean> {
  return Number(await redis.get(budgetKey()) ?? 0) < automaticReviewDailyLimit();
}
/** Atomic across workers. Count attempts, including failed calls; providers can charge those too. */
export async function reserveAutomaticReviewBudget(): Promise<boolean> {
  const used = await redis.eval(`
    local used = tonumber(redis.call('GET', KEYS[1]) or '0')
    if used >= tonumber(ARGV[1]) then return 0 end
    redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], 172800)
    return 1
  `, 1, budgetKey(), automaticReviewDailyLimit());
  return Number(used) === 1;
}
