// ============================================================
// API ROUTES — FUTURES
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildFuturesData } from '../services/futures.js';

export function createFuturesRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/futures/:symbol
   * Query params: exchange (default NSE)
   */
  router.get('/:symbol', async (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const exchange = ((req.query.exchange as string) || 'NSE') as any;

      const futures = await buildFuturesData(provider, symbol, exchange);

      res.json({
        success: true,
        data: futures,
        meta: { timestamp: Date.now(), source: 'LIVE' },
      });
    } catch (error: any) {
      logger.error({ error: error.message, symbol: req.params.symbol }, 'Futures data build failed');
      res.status(502).json({
        success: false,
        error: { code: 'FUTURES_FETCH_FAILED', message: error.message },
      });
    }
  });

  return router;
}
