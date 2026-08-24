// ============================================================
// API ROUTES — BACKTESTING (Trade Setup outcome analytics)
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { getTradeSetupHistory, getWinRateAnalytics } from '../services/backtesting.js';

export function createBacktestingRoutes(): Router {
  const router = Router();

  /**
   * GET /api/backtesting/win-rate
   * Day/week/month/year win-rate breakdown, overall, and per-symbol —
   * built entirely from trade setups the system has actually generated.
   */
  router.get('/win-rate', async (_req: Request, res: Response) => {
    try {
      const data = await getWinRateAnalytics();
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Win-rate analytics fetch failed');
      res.status(502).json({ success: false, error: { code: 'WIN_RATE_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/backtesting/trade-setups?limit=100
   * Raw trade-setup history, newest first.
   */
  router.get('/trade-setups', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 2000);
      const data = await getTradeSetupHistory(limit);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Trade setup history fetch failed');
      res.status(502).json({ success: false, error: { code: 'TRADE_SETUPS_FAILED', message: error.message } });
    }
  });

  return router;
}
