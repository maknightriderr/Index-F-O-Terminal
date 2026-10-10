// ============================================================
// API ROUTES — FII/DII ACTIVITY
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { getFiiDiiHistory } from '../services/fii-dii.js';
import { readLatestFiiDii } from '../services/read-only-views.js';

export function createFiiDiiRoutes(): Router {
  const router = Router();

  /**
   * GET /api/fii-dii
   * NSE's last-published daily FII/DII net cash activity, as already recorded (cache, else the newest
   * history row). READ-ONLY: it never calls NSE or writes — the hourly tracker does that. Null `data`
   * (still success:true) when nothing has been recorded.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { data, meta } = await readLatestFiiDii();
      res.json({ success: true, data, meta });
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
