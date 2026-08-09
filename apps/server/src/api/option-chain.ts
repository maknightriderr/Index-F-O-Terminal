// ============================================================
// API ROUTES — OPTION CHAIN
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildOptionChain } from '../services/option-chain.js';

export function createOptionChainRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/option-chain/:symbol
   * Query params: exchange (default NSE), expiry (ISO date, defaults to nearest), strikeRange
   */
  router.get('/:symbol', async (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const exchange = ((req.query.exchange as string) || 'NSE') as any;
      const expiry = req.query.expiry as string | undefined;
      const strikeRange = req.query.strikeRange ? parseInt(req.query.strikeRange as string, 10) : undefined;

      const chain = await buildOptionChain(provider, symbol, exchange, expiry, { strikeRange });

      res.json({
        success: true,
        data: chain,
        meta: { timestamp: Date.now(), source: 'LIVE' },
      });
    } catch (error: any) {
      logger.error({ error: error.message, symbol: req.params.symbol }, 'Option chain build failed');
      res.status(502).json({
        success: false,
        error: { code: 'OPTION_CHAIN_FAILED', message: error.message },
      });
    }
  });

  return router;
}
