// ============================================================
// API ROUTES — AI ASSISTANT
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { chat } from '../services/ai-assistant.js';
import { isAnthropicConfigured } from '../lib/anthropic.js';
import type { ChatTurn } from '../lib/anthropic.js';

const MAX_HISTORY_TURNS = 20;

export function createAiAssistantRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * POST /api/ai-assistant/chat
   * Body: { message: string, history?: Array<{ role: 'user'|'assistant', content: string }> }
   */
  router.post('/chat', async (req: Request, res: Response) => {
    if (!isAnthropicConfigured()) {
      res.status(503).json({
        success: false,
        error: { code: 'AI_NOT_CONFIGURED', message: 'ANTHROPIC_API_KEY is not set on the backend.' },
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

      const reply = await chat(provider, message, history);

      res.json({ success: true, data: { reply }, meta: { timestamp: Date.now() } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'AI assistant chat failed');
      res.status(502).json({
        success: false,
        error: { code: 'AI_CHAT_FAILED', message: error.message },
      });
    }
  });

  return router;
}
