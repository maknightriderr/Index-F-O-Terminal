// ============================================================
// API ROUTES — MARKET SCANNER
// ============================================================
// GET is READ-ONLY: it returns the newest scan the background job already
// recorded (or the last-known copy) and never runs one. A scan runs a bias for
// every finalist, which writes decision records (and can mint paper trades in a
// live session), so it is only ever started by:
//   - the background job (every 5 min while NSE is open), or
//   - POST /refresh, an explicit action a person takes: it needs the explicit-action header and is refused while NSE is
//     closed (the background job never scans then either; a closed-market scan only writes MARKET_CLOSED skip rows).
// ============================================================

import { Router, type Request, type Response } from 'express';
import { isMarketOpen } from '@fno/shared';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { refreshMarketScan } from '../services/market-scanner.js';
import { readMarketScan, readMeta } from '../services/read-only-views.js';

/** The header a scan request must carry: the web button sends it, so a stray or prefetched POST cannot start a scan. */
export const EXPLICIT_SCAN_HEADER = 'x-explicit-action';
export const EXPLICIT_SCAN_VALUE = 'run-market-scan';

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
  router.post('/refresh', async (req: Request, res: Response) => {
    if (req.header(EXPLICIT_SCAN_HEADER) !== EXPLICIT_SCAN_VALUE) {
      res.status(400).json({ success: false, error: { code: 'EXPLICIT_ACTION_REQUIRED', message: `Running a scan needs the ${EXPLICIT_SCAN_HEADER}: ${EXPLICIT_SCAN_VALUE} header.` } });
      return;
    }
    if (!isMarketOpen('NSE')) {
      res.status(409).json({ success: false, error: { code: 'MARKET_CLOSED', message: 'NSE is closed. A scan only runs in session; the last recorded scan is shown instead.' } });
      return;
    }
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
