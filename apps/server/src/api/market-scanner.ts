// ============================================================
// API ROUTES — MARKET SCANNER
// ============================================================
// GET is READ-ONLY: it returns the newest scan the background job already
// recorded (or the last-known copy) and never runs one. A scan runs a bias for
// every finalist, which writes decision records (and can mint paper trades in a
// live session), so it is only ever started by:
//   - the background job (every 5 min while NSE is open), or
//   - POST /refresh, an explicit action a person takes.
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { refreshMarketScan } from '../services/market-scanner.js';
import { readMarketScan, readMeta } from '../services/read-only-views.js';

/** One explicit scan at a time, and not more often than this. */
export const MANUAL_SCAN_MIN_INTERVAL_MS = 60_000;
let manualScanRunning = false;
let lastManualScanAt = 0;

export function createMarketScannerRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/market-scanner
   * The latest recorded scan. `data` is null (success: true) when none has been recorded; `meta` says where
   * it came from and how old it is. Never computes a scan, never writes.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { data, meta } = await readMarketScan();
      res.json({ success: true, data, meta });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Market scan read failed');
      res.status(502).json({ success: false, error: { code: 'MARKET_SCAN_READ_FAILED', message: error.message } });
    }
  });

  /**
   * POST /api/market-scanner/refresh
   * An explicit "run a scan now". Records the same decision rows the background scan does — it is never called by
   * a page load. Refused while one is running or within MANUAL_SCAN_MIN_INTERVAL_MS of the last.
   */
  router.post('/refresh', async (_req: Request, res: Response) => {
    const now = Date.now();
    if (manualScanRunning || now - lastManualScanAt < MANUAL_SCAN_MIN_INTERVAL_MS) {
      res.status(429).json({ success: false, error: { code: 'SCAN_RECENTLY_RUN', message: 'A scan is running or ran under a minute ago.' } });
      return;
    }
    manualScanRunning = true;
    try {
      const data = await refreshMarketScan(provider);
      lastManualScanAt = Date.now();
      res.json({ success: true, data, meta: { ...readMeta('CACHE', data.scannedAt ?? null, Date.now()), readOnly: false, explicitAction: true } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Explicit market scan failed');
      res.status(502).json({ success: false, error: { code: 'MARKET_SCAN_FAILED', message: error.message } });
    } finally {
      manualScanRunning = false;
    }
  });

  return router;
}
