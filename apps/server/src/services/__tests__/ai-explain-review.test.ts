import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PaperTradeView } from '@fno/shared';

// The model, the database, the cache and the outside world are all fakes here.
const askAi = vi.fn();
vi.mock('../../lib/llm.js', () => ({ askAi: (...a: unknown[]) => askAi(...a), isAiConfigured: () => true, AI_KEY_NAMES: 'keys' }));
const sqlRows: unknown[][] = [];
vi.mock('../../lib/db.js', () => ({ sql: () => Promise.resolve(sqlRows.shift() ?? []) }));
vi.mock('../../lib/cache.js', () => ({ cached: (_k: string, _t: number, compute: () => Promise<unknown>) => compute() }));
const redisStore = new Map<string, string>();
const history: string[] = [];
vi.mock('../../lib/redis.js', () => ({
  redis: {
    set: vi.fn(async (k: string, v: string, ...opts: unknown[]) => {
      if (opts.includes('NX') && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    lpush: vi.fn(async (_k: string, v: string) => history.unshift(v)),
    ltrim: vi.fn(async () => 'OK'),
  },
}));
const telegram = vi.fn(async (_text: string) => undefined);
vi.mock('../../lib/telegram.js', () => ({ sendTelegramMessage: (text: string) => telegram(text) }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
let paperTrades: PaperTradeView[] = [];
vi.mock('../paper-trades.js', () => ({ listPaperTrades: async () => ({ trades: paperTrades }) }));

const { voteStances, tradeFactSheet, decisionFactSheet, explain, ExplainNotFoundError, isTradeId } = await import('../ai-explain.js');
const { sessionReviewStats, formatReviewMessage, reviewNumberLines, writeReviewSummary } = await import('../ai-daily-review.js');
const { reviewsDue, runDailyReviewTick, REVIEW_DELAY_MS } = await import('../daily-review-job.js');

const ist = (s: string) => Date.parse(`${s}+05:30`);
const trade = (over: Partial<PaperTradeView>): PaperTradeView =>
  ({
    id: 'x', symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', structureType: 'NAKED_LONG', side: 'CE', strike: 23100, expiry: '2026-10-20', direction: 'BULLISH',
    family: 'INDICATOR', strategyLabel: 'Indicator Engine', logicVersion: null, mintedAt: ist('2026-10-16T10:17:00'), state: 'WIN', status: 'CLOSED', includedInPerformance: true,
    excludedReason: null, cohort: 'POST_B', measurementReliable: true, entry: 100, initialStop: 70, currentStop: null, target: 115, plannedRiskReward: 0.5, exitPrice: 115,
    exitAt: ist('2026-10-16T11:00:00'), closeReason: 'TARGET', holdMinutes: 43, grossR: 0.5, netR: 0.45, returnPercent: 15,
    estimatedCost: { pct: 1.5, basis: 'ESTIMATED_MODEL', costR: 0.05, record: null }, live: null, disclosure: 'paper',
    ...over,
  }) as PaperTradeView;

beforeEach(() => {
  askAi.mockReset();
  telegram.mockClear();
  sqlRows.length = 0;
  redisStore.clear();
  history.length = 0;
});

describe('"Why this trade?" fact sheets (computed in code, never by the model)', () => {
  it('reads vote contributions as stances: 95 agrees, 5 is against, 50 is neutral', () => {
    expect(voteStances({ trend: 95, pcr: 5, volume: 50, iv: 'x' as unknown as number })).toEqual({ agree: ['trend'], against: ['put-call ratio'], neutral: ['volume'] });
    expect(voteStances(null)).toEqual({ agree: [], against: [], neutral: [] });
  });

  it('describes a closed Old Indicator trade with its R before costs, and never prints "undefined"', () => {
    const sheet = tradeFactSheet(
      { time: new Date(ist('2026-10-16T10:17:00')), symbol: 'NIFTY', inputs: { source: 'INDICATOR', exchange: 'NSE', mode: 'INTRADAY', side: 'CE', strike: 23100, entry: 100, stopLoss: 70, target: 115, riskReward: 0.5, estimatedCostPct: 1.5, outcome: 'WIN', closeReason: 'TARGET', exitPrice: 115, holdMinutes: 43 } },
      { time: new Date(), symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', decision: 'TAKE', reason_code: null, reason: 'BULLISH bias at 83/100', regime: 'STRONG_BULL_TREND', bias: 'BULLISH', confidence: '83', vote_contributions: { trend: 95, futuresOi: 95, pcr: 5 } }
    );
    const all = sheet.facts.join('\n');
    expect(sheet.subject).toMatch(/^NIFTY 23100 CE \(bullish\)/);
    expect(all).toContain('Engine that took it: Old Indicator.');
    expect(all).toContain('Signals agreeing with the call: trend, futures open interest.');
    expect(all).toContain('Signals against the call: put-call ratio.');
    expect(all).toContain('+0.50R before costs');
    expect(all).toContain('No order was placed.');
    expect(all).not.toMatch(/undefined|NaN/);
  });

  it('says an open trade is still open', () => {
    const sheet = tradeFactSheet({ time: new Date(), symbol: 'TCS', inputs: { source: 'A3', side: 'PE', strike: 3000, entry: 50, stopLoss: 35 } }, null);
    expect(sheet.facts.join('\n')).toContain('The trade is still open.');
    expect(sheet.facts.join('\n')).toContain('Engine that took it: A3.');
  });

  it('describes a refusal with the rule that refused it', () => {
    const sheet = decisionFactSheet({ time: new Date(), symbol: 'BANKNIFTY', exchange: 'NSE', mode: 'INTRADAY', decision: 'REFUSE', reason_code: 'POST_LOSS_COOLDOWN', reason: 'A setup stopped out 3 minutes ago', regime: null, bias: 'BEARISH', confidence: 70, vote_contributions: {} });
    expect(sheet.subject).toMatch(/^BANKNIFTY intraday: no trade/);
    expect(sheet.facts.join('\n')).toContain('Rule that refused it: post loss cooldown.');
  });

  it('explain() gives the model only the fact sheet, and reports which provider answered', async () => {
    sqlRows.push([{ time: new Date(), symbol: 'NIFTY', inputs: { source: 'INDICATOR', side: 'CE', strike: 23100, entry: 100, stopLoss: 70 } }], []);
    askAi.mockResolvedValue({ text: '• It was bullish.', provider: 'groq', label: 'Groq', model: 'm' });
    const r = await explain({ kind: 'trade', id: '9b1d1c2e-1111-4a4a-8b8b-123456789abc' });
    expect(r).toMatchObject({ text: '• It was bullish.', via: 'Groq' });
    const [system, messages] = askAi.mock.calls[0];
    expect(system).toMatch(/Use only the facts/);
    expect(messages[0].content).toMatch(/^<facts>\n[\s\S]*Old Indicator[\s\S]*<\/facts>/);
  });

  it('explain() refuses a trade that does not exist, and only accepts real ids', async () => {
    sqlRows.push([]);
    await expect(explain({ kind: 'trade', id: '9b1d1c2e-1111-4a4a-8b8b-123456789abc' })).rejects.toBeInstanceOf(ExplainNotFoundError);
    expect(isTradeId("1; DROP TABLE signals")).toBe(false);
    expect(askAi).not.toHaveBeenCalled();
  });
});

describe('end-of-session review', () => {
  const date = '2026-10-16';
  const trades = [
    trade({ id: 'a', netR: 0.45, symbol: 'CANBK', strike: 120 }),
    trade({ id: 'b', netR: -1.08, state: 'LOSS', closeReason: 'STOP', symbol: 'TECHM', strike: 1500, side: 'PE', family: 'A3', strategyLabel: 'Paper research · A3' }),
    trade({ id: 'c', netR: -0.1, state: 'EXPIRED', includedInPerformance: false, symbol: 'INFY' }),
    trade({ id: 'd', state: 'OPEN', exitAt: null, netR: null, symbol: 'RELIANCE' }),
    trade({ id: 'e', exchange: 'MCX', symbol: 'CRUDEOIL', netR: 0.3 }),
    trade({ id: 'f', mintedAt: ist('2026-10-14T10:00:00'), exitAt: ist('2026-10-16T14:00:00'), netR: 0.2, mode: 'POSITIONAL', symbol: 'MARUTI' }),
  ];

  it('counts the session: closed today whatever the mint date, excluded trades out of net R, MCX apart', () => {
    const s = sessionReviewStats(trades, 'NSE_BSE', date);
    expect(s).toMatchObject({ minted: 4, closed: 4, wins: 2, losses: 1, expired: 1, stillOpen: 1 });
    expect(s.netR).toBeCloseTo(0.45 - 1.08 + 0.2, 6);
    expect(s.best).toEqual({ label: 'CANBK 120 CE', netR: 0.45 });
    expect(s.worst).toEqual({ label: 'TECHM 1500 PE', netR: -1.08 });
    expect(s.oldIndicator).toEqual({ closed: 2, netR: 0.65 });
    expect(s.others).toEqual({ closed: 1, netR: -1.08 });
    expect(sessionReviewStats(trades, 'MCX', date)).toMatchObject({ minted: 1, closed: 1, netR: 0.3 });
  });

  it('writes a Telegram message that escapes HTML, states no orders were placed, and survives a missing AI note', () => {
    const s = { ...sessionReviewStats(trades, 'NSE_BSE', date), best: { label: 'M&M <x>', netR: 0.4 } };
    const withAi = formatReviewMessage(s, 'A mixed session <b>.', 'Gemini');
    expect(withAi).toContain('M&amp;M &lt;x&gt;');
    expect(withAi).toContain('A mixed session &lt;b&gt;.');
    expect(withAi).toContain('no orders were placed');
    expect(withAi).toContain('via Gemini');
    expect(formatReviewMessage(s, null, null)).toContain('AI note unavailable');
    expect(reviewNumberLines(s)[1]).toBe('Net after estimated costs: −0.43R (−0.14R a trade)');
  });

  it('asks the model nothing for an empty session, and returns null when every provider fails', async () => {
    const empty = sessionReviewStats([], 'MCX', date);
    expect(await writeReviewSummary(empty)).toBeNull();
    expect(askAi).not.toHaveBeenCalled();
    askAi.mockRejectedValue(new Error('all failed'));
    expect(await writeReviewSummary(sessionReviewStats(trades, 'NSE_BSE', date))).toBeNull();
  });

  it('is due from 20 minutes to 4 hours after a session closes, and never on a holiday', () => {
    const close = ist('2026-10-16T15:30:00');
    const win = (e: string) => (e === 'NSE' ? { close } : null);
    expect(reviewsDue(close + 10 * 60_000, win)).toEqual([]);
    expect(reviewsDue(close + REVIEW_DELAY_MS + 1, win)).toEqual([{ group: 'NSE_BSE', date }]);
    expect(reviewsDue(close + 5 * 3_600_000, win)).toEqual([]);
    expect(reviewsDue(close + REVIEW_DELAY_MS + 1, () => null)).toEqual([]);
  });

  it('sends one review per session, even when the job ticks again', async () => {
    paperTrades = trades;
    askAi.mockResolvedValue({ text: 'Net positive session.', provider: 'gemini', label: 'Gemini', model: 'm' });
    const now = ist('2026-10-16T15:55:00');
    await runDailyReviewTick(now);
    await runDailyReviewTick(now + 5 * 60_000);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(String(telegram.mock.calls[0][0])).toContain('NSE/BSE session review');
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0])).toMatchObject({ group: 'NSE_BSE', date, via: 'Gemini' });
  });
});
