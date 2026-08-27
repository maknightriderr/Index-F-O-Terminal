// ============================================================
// API ROUTES — NEWS
// ============================================================

import { Router, type Request, type Response } from 'express';
import type { NewsArticle } from '@fno/shared';
import { logger } from '../lib/logger.js';
import { getNewsForSymbol } from '../services/news.js';

export function createNewsRoutes(): Router {
  const router = Router();

  /**
   * GET /api/news/:symbol
   * Fetch latest news for a stock or index symbol.
   */
  router.get('/:symbol', async (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      if (!symbol || symbol.length > 30) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_SYMBOL', message: 'Symbol is required and must be ≤30 chars.' },
        });
        return;
      }

      const articles: NewsArticle[] = await getNewsForSymbol(symbol);

      res.json({
        success: true,
        data: articles,
        meta: { symbol, count: articles.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      logger.error({ error: error.message, symbol: req.params.symbol }, 'News fetch failed');
      res.status(500).json({
        success: false,
        error: { code: 'NEWS_FETCH_FAILED', message: error.message },
      });
    }
  });

  return router;
}
