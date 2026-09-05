// ============================================================
// API ROUTES — FII/DII ACTIVITY
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { getFiiDiiActivity, getFiiDiiHistory } from '../services/fii-dii.js';

export function createFiiDiiRoutes(): Router {
  const router = Router();

  /**
   * GET /api/fii-dii
   * NSE's last-published daily FII/DII net cash activity. Null `data`
   * (still success:true) when NSE's unofficial endpoint is unreachable
   * this tick — not treated as a hard error, since this is EOD reference
   * data, not something a poll failing should alarm over.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const data = await getFiiDiiActivity();
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'NSE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'FII/DII fetch failed');
      res.status(502).json({ success: false, error: { code: 'FII_DII_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/fii-dii/history?limit=30
   * Persisted daily snapshots, oldest first — sparse until the tracker has
   * had time to accumulate real days (see startFiiDiiTracker).
   */
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 30, 90);
      const data = await getFiiDiiHistory(limit);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'NSE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'FII/DII history fetch failed');
      res.status(502).json({ success: false, error: { code: 'FII_DII_HISTORY_FAILED', message: error.message } });
    }
  });

  return router;
}
