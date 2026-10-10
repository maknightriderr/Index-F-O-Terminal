// ============================================================
// API ROUTES — PAPER TRADES (read-only)
// ============================================================
// GET /api/paper-trades?limit=500
// One authoritative list of the paper trades (open and closed) with their
// live tracking, estimated costs and an explicit status. SELECTs and Redis
// reads only: it prices nothing, never creates, closes or changes a trade.
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { listPaperTrades } from '../services/paper-trades.js';

export function createPaperTradesRoutes(): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit);
      const data = await listPaperTrades(Number.isFinite(limit) && limit > 0 ? limit : undefined);
      res.json({ success: true, data, meta: { readOnly: true, timestamp: Date.now() } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Paper trades read failed');
      res.status(502).json({ success: false, error: { code: 'PAPER_TRADES_FAILED', message: error.message } });
    }
  });

  return router;
}
