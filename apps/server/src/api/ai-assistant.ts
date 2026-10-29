// ============================================================
// API ROUTES — AI ASSISTANT
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { chat } from '../services/ai-assistant.js';
import { explain, isTradeId, ExplainNotFoundError, type ExplainTarget } from '../services/ai-explain.js';
import { REVIEW_HISTORY_KEY, type DailyReview } from '../services/ai-daily-review.js';
import { redis } from '../lib/redis.js';
import { AI_KEY_NAMES, isAiConfigured, type ChatTurn } from '../lib/llm.js';
import { automaticReviewReport } from '../services/auto-review-store.js';

const MAX_HISTORY_TURNS = 20;

export function createAiAssistantRoutes(provider: MarketDataProvider): Router {
  const router = Router();
  router.get('/trade-reviews', async (_req: Request, res: Response) => {
    try { res.json({ success: true, data: await automaticReviewReport(), meta: { timestamp: Date.now(), readOnly: true } }); }
    catch { res.status(502).json({ success: false, error: { code: 'TRADE_REVIEW_UNAVAILABLE', message: 'Automatic review report unavailable; retry shortly.' } }); }
  });

  /**
   * POST /api/ai-assistant/chat
   * Body: { message: string, history?: Array<{ role: 'user'|'assistant', content: string }> }
   */
  router.post('/chat', async (req: Request, res: Response) => {
    if (!isAiConfigured()) {
      res.status(503).json({
        success: false,
        error: { code: 'AI_NOT_CONFIGURED', message: `No AI key is set on the backend: set ${AI_KEY_NAMES}.` },
      });
      return;
    }

    try {
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!message) {
        res.status(400).json({ success: false, error: { code: 'EMPTY_MESSAGE', message: 'message is required' } });
        return;
      }

      const historyRaw = Array.isArray(req.body?.history) ? req.body.history : [];
      const history: ChatTurn[] = historyRaw
        .filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-MAX_HISTORY_TURNS);

      const answer = await chat(provider, message, history);

      res.json({ success: true, data: { reply: answer.text, via: answer.label }, meta: { timestamp: Date.now(), model: answer.model } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'AI assistant chat failed');
      res.status(502).json({
        success: false,
        error: { code: 'AI_CHAT_FAILED', message: error.message },
      });
    }
  });

  /**
   * POST /api/ai-assistant/explain — "Why this trade?" / "Why no trade?" in plain English (cached).
   * Body: { kind: 'trade', id } or { kind: 'decision', symbol, exchange, mode }
   */
  router.post('/explain', async (req: Request, res: Response) => {
    if (!isAiConfigured()) {
      res.status(503).json({ success: false, error: { code: 'AI_NOT_CONFIGURED', message: `No AI key is set on the backend: set ${AI_KEY_NAMES}.` } });
      return;
    }
    const b = req.body ?? {};
    let target: ExplainTarget | null = null;
    if (b.kind === 'trade' && isTradeId(b.id)) target = { kind: 'trade', id: b.id };
    else if (
      b.kind === 'decision' &&
      typeof b.symbol === 'string' && /^[A-Z0-9&_-]{1,30}$/.test(b.symbol) &&
      ['NSE', 'BSE', 'MCX'].includes(b.exchange) &&
      ['INTRADAY', 'POSITIONAL'].includes(b.mode)
    ) target = { kind: 'decision', symbol: b.symbol, exchange: b.exchange, mode: b.mode };
    if (!target) {
      res.status(400).json({ success: false, error: { code: 'BAD_TARGET', message: "Send { kind: 'trade', id } or { kind: 'decision', symbol, exchange, mode }." } });
      return;
    }
    try {
      res.json({ success: true, data: await explain(target), meta: { timestamp: Date.now() } });
    } catch (error: any) {
      if (error instanceof ExplainNotFoundError) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: error.message } });
        return;
      }
      logger.error({ error: error.message }, 'AI explain failed');
      res.status(502).json({ success: false, error: { code: 'AI_EXPLAIN_FAILED', message: error.message } });
    }
  });

  /** GET /api/ai-assistant/daily-review — the latest end-of-session reviews, newest first. */
  router.get('/daily-review', async (_req: Request, res: Response) => {
    try {
      const raw = await redis.lrange(REVIEW_HISTORY_KEY, 0, 5);
      const reviews = raw.map((r) => JSON.parse(r) as DailyReview);
      res.json({ success: true, data: { reviews }, meta: { timestamp: Date.now() } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Daily review read failed');
      res.status(502).json({ success: false, error: { code: 'DAILY_REVIEW_FAILED', message: error.message } });
    }
  });

  return router;
}
