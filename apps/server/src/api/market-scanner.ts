// ============================================================
// API ROUTES — MARKET SCANNER
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { getMarketScan } from '../services/market-scanner.js';

export function createMarketScannerRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/market-scanner
   * Latest scored trade-setup candidates from the top-down NIFTY -> sector
   * -> stock pipeline. Reads the background job's cached result; if the
   * server just booted and no scan has run yet, computes one fresh here so
   * the page isn't stuck empty on first load.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const data = await getMarketScan(provider);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Market scan fetch failed');
      res.status(502).json({ success: false, error: { code: 'MARKET_SCAN_FAILED', message: error.message } });
    }
  });

  return router;
}
