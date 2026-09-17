// ============================================================
// API ROUTES — STRATEGY SCANNER
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { cached } from '../lib/cache.js';
import { getStrategyTrackRecord } from '../services/strategy-tracker.js';

export function createStrategyScannerRoutes(): Router {
  const router = Router();

  /**
   * GET /api/strategy-scanner/track-record
   * How the Strategy Scanner's direction calls have played out: each day's
   * recommendations graded against the next session's snapshot.
   */
  router.get('/track-record', async (_req: Request, res: Response) => {
    try {
      const data = await cached('strategy-scanner:track-record', 300, getStrategyTrackRecord);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Strategy track record fetch failed');
      res.status(502).json({ success: false, error: { code: 'STRATEGY_TRACK_RECORD_FAILED', message: error.message } });
    }
  });

  return router;
}
