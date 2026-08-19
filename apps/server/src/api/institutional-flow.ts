// ============================================================
// API ROUTES — INSTITUTIONAL FLOW
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { cached } from '../lib/cache.js';
import { buildSentimentSnapshot, buildNextDayBias, generateCommentary, INSTITUTIONAL_SYMBOLS } from '../services/institutional-flow.js';
import { getPredictionHistory, getAccuracyStats } from '../services/institutional-flow-scanner.js';

const SNAPSHOT_CACHE_TTL_SECONDS = 60;
const BIAS_CACHE_TTL_SECONDS = 60;
const COMMENTARY_CACHE_TTL_SECONDS = 300; // Claude call — don't regenerate on every poll

export function createInstitutionalFlowRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/institutional-flow/snapshot
   * Section 1-4: sentiment composite built from every real input this app
   * has live (VIX, PCR, futures/option OI) — see InstitutionalFlowSnapshot
   * for exactly which inputs are/aren't connected.
   */
  router.get('/snapshot', async (_req: Request, res: Response) => {
    try {
      const data = await cached('institutional-flow:snapshot', SNAPSHOT_CACHE_TTL_SECONDS, () => buildSentimentSnapshot(provider));
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Institutional flow snapshot failed');
      res.status(502).json({ success: false, error: { code: 'INSTITUTIONAL_SNAPSHOT_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/institutional-flow/next-day-bias
   * Section 5: gap/trend/range/volatility probabilities + expected range
   * for NIFTY and BANKNIFTY.
   */
  router.get('/next-day-bias', async (_req: Request, res: Response) => {
    try {
      const data = await Promise.all(
        INSTITUTIONAL_SYMBOLS.map((s) =>
          cached(`institutional-flow:next-day-bias:${s.symbol}`, BIAS_CACHE_TTL_SECONDS, () => buildNextDayBias(provider, s.symbol))
        )
      );
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Next-day bias build failed');
      res.status(502).json({ success: false, error: { code: 'NEXT_DAY_BIAS_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/institutional-flow/commentary
   * Section 6: AI-generated commentary grounded in the snapshot + biases
   * above (never invents FII/DII or global-market figures).
   */
  router.get('/commentary', async (_req: Request, res: Response) => {
    try {
      const data = await cached('institutional-flow:commentary', COMMENTARY_CACHE_TTL_SECONDS, async () => {
        const [snapshot, biases] = await Promise.all([
          buildSentimentSnapshot(provider),
          Promise.all(INSTITUTIONAL_SYMBOLS.map((s) => buildNextDayBias(provider, s.symbol))),
        ]);
        return generateCommentary(snapshot, biases);
      });
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Institutional flow commentary failed');
      res.status(502).json({ success: false, error: { code: 'COMMENTARY_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/institutional-flow/predictions?symbol=NIFTY
   * Section 7: prediction history for one symbol, newest first.
   */
  router.get('/predictions', async (req: Request, res: Response) => {
    try {
      const symbol = ((req.query.symbol as string) || 'NIFTY').toUpperCase();
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const data = await getPredictionHistory(symbol, limit);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Prediction history fetch failed');
      res.status(502).json({ success: false, error: { code: 'PREDICTIONS_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/institutional-flow/accuracy?symbol=NIFTY
   * Section 7: rolling accuracy stats for one symbol.
   */
  router.get('/accuracy', async (req: Request, res: Response) => {
    try {
      const symbol = ((req.query.symbol as string) || 'NIFTY').toUpperCase();
      const data = await getAccuracyStats(symbol);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Accuracy stats fetch failed');
      res.status(502).json({ success: false, error: { code: 'ACCURACY_FAILED', message: error.message } });
    }
  });

  return router;
}
