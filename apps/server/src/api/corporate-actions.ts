// ============================================================
// API ROUTES — CORPORATE ACTIONS
// ============================================================

import { Router, type Request, type Response } from 'express';
import type { CorporateAction } from '@fno/shared';
import { logger } from '../lib/logger.js';
import { getUpcomingCorporateActions, getCorporateActionsForSymbol } from '../services/corporate-actions.js';

export function createCorporateActionsRoutes(): Router {
  const router = Router();

  /**
   * GET /api/corporate-actions
   * Market-wide upcoming dividends/bonuses/splits/rights/buybacks across NSE.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const actions: CorporateAction[] = await getUpcomingCorporateActions();
      res.json({
        success: true,
        data: actions,
        meta: { count: actions.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Market-wide corporate actions fetch failed');
      res.status(502).json({
        success: false,
        error: { code: 'CORPORATE_ACTIONS_FETCH_FAILED', message: error.message },
      });
    }
  });

  /**
   * GET /api/corporate-actions/:symbol
   * Full corporate-action history (past + future) for one symbol.
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

      const actions: CorporateAction[] = await getCorporateActionsForSymbol(symbol);

      res.json({
        success: true,
        data: actions,
        meta: { symbol, count: actions.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      logger.error({ error: error.message, symbol: req.params.symbol }, 'Symbol corporate actions fetch failed');
      res.status(502).json({
        success: false,
        error: { code: 'CORPORATE_ACTIONS_FETCH_FAILED', message: error.message },
      });
    }
  });

  return router;
}
