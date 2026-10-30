import { describe, it, expect, vi, beforeEach } from 'vitest';
const m = vi.hoisted(() => ({ queries: [] as string[], configured: true, ready: true, budget: true, cooling: false, complete: false, ask: vi.fn() }));
vi.mock('../../lib/db.js', () => {
    const sql: any = async (s: TemplateStringsArray, ...values: any[]) => {
        const text = s.join('?');
        m.queries.push(text);
        if (text.includes('RETURNING position_id'))
            return m.complete ? [] : [{ position_id: 'new-filled' }];
        if (text.includes('SELECT state'))
            return [{ state: { candidate: { version: 'NEW-INTRADAY-1.0' }, netPnl: -100 } }];
        if (text.includes('status=\'COMPLETE\''))
            m.complete = true;
        return [];
    };
    sql.json = (v: unknown) => v;
    return { sql };
});
vi.mock('../../lib/llm.js', () => ({ isAiConfigured: () => m.configured, aiRetryAt: () => m.cooling ? 100 : null, askAi: m.ask }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => m.ready }));
vi.mock('../ai-trade-review.js', () => ({ autoReviewEnabled: () => true }));
vi.mock('../auto-review-budget.js', () => ({ reserveAutomaticReviewBudget: async () => m.budget }));
import { runFreshReviews } from '../fresh-start/reviews.js';
beforeEach(() => { m.queries = []; m.configured = true; m.ready = true; m.cooling = false; m.budget = true; m.complete = false; m.ask.mockReset().mockResolvedValue({ text: 'Observed loss; future test needed.', provider: 'gemini', model: 'test' }); });
describe('isolated automatic fresh-start explanations', () => {
    it('automatically queues closed current-version fills and persists explanation without touching trading or legacy tables', async () => { await runFreshReviews(); expect(m.ask).toHaveBeenCalledOnce(); expect(m.ask.mock.calls[0][0]).toContain('untrusted evidence'); expect(m.complete).toBe(true); expect(m.queries.every(q => !q.includes('signals') && !q.includes('UPDATE fresh_paper_positions') && !q.includes('fresh_paper_accounts') && !q.includes('learning'))).toBe(true); await runFreshReviews(); expect(m.ask).toHaveBeenCalledOnce(); });
    it('keeps work durable while unconfigured or cooling down', async () => { m.configured = false; await runFreshReviews(); expect(m.queries).toHaveLength(1); expect(m.ask).not.toHaveBeenCalled(); m.configured = true; m.cooling = true; await runFreshReviews(); expect(m.ask).not.toHaveBeenCalled(); });
    it('honours shared daily budget and automatically retries provider failure without storing error bodies', async () => { m.budget = false; await runFreshReviews(); expect(m.ask).not.toHaveBeenCalled(); expect(m.queries.at(-1)).toContain("interval '1 hour'"); m.budget = true; m.ask.mockRejectedValue(Error('secret-provider-body')); await runFreshReviews(); expect(m.queries.at(-1)).toContain("status='PENDING'"); expect(m.queries.join('')).not.toContain('secret-provider-body'); });
});
