// ============================================================
// API ROUTES — BACKTESTING (Trade Setup outcome analytics)
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { getTradeSetupHistory, getWinRateAnalytics } from '../services/backtesting.js';
import type { TradingMode } from '@fno/shared';
import { captureCoverage } from '../services/market-state-capture.js';
import { captureSchemaStatus } from '../services/ensure-capture-schema.js';
import { decisionCoverage, rejectionBreakdown } from '../services/decision-snapshot.js';
import { missedWinnerReport } from '../services/missed-winner-audit.js';
import { dataQualitySummary } from '../services/data-quality.js';
import {
  captureTimeline,
  chainCompleteness,
  refusalMaturity,
  captureUniverse,
  replayReadiness,
} from '../services/capture-diagnostics.js';
import { dailyReport } from '../services/daily-report.js';

export function createBacktestingRoutes(): Router {
  const router = Router();

  /**
   * GET /api/backtesting/win-rate
   * Day/week/month/year win-rate breakdown, overall, and per-symbol —
   * built entirely from trade setups the system has actually generated.
   */
  /**
   * GET /api/backtesting/coverage
   *
   * What the research record actually contains. Every promotion decision from
   * here on depends on these counts: a shadow rule with no forward
   * observations cannot be judged, and this is the only honest way to see how
   * many it has. Also reports whether the boot-time schema check succeeded,
   * because a capture that silently writes nothing looks exactly like a
   * capture that is merely young.
   */
  router.get('/coverage', async (_req: Request, res: Response) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [tables, decisions, rejections, missed, dataQuality] = await Promise.all([
        captureCoverage(),
        decisionCoverage(),
        rejectionBreakdown(since),
        missedWinnerReport(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
        dataQualitySummary(since),
      ]);
      res.json({
        success: true,
        data: {
          schema: captureSchemaStatus(),
          tables,
          decisions,
          rejectionsLast24h: rejections,
          missedWinnerByReason: missed,
          dataQualityLast24h: dataQuality,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Coverage report failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/backtesting/diagnostics
   *
   * Answers, from rows rather than inference, the questions the first capture
   * report could not: when capture actually started, whether each chain
   * snapshot was complete and why not when it was not, which instruments are
   * being collected, how many refusals have aged far enough to grade, and
   * whether the data contract can support a replay yet.
   *
   * Observability only. Nothing here is read by the trading engine.
   */
  router.get('/diagnostics', async (req: Request, res: Response) => {
    try {
      const sinceHours = Math.min(Number(req.query.sinceHours ?? 48) || 48, 720);
      const [timeline, chains, maturity, universe, replay] = await Promise.all([
        captureTimeline(),
        chainCompleteness(sinceHours),
        refusalMaturity(),
        captureUniverse(),
        replayReadiness(),
      ]);
      res.json({ success: true, data: { timeline, chains, maturity, universe, replay } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Capture diagnostics failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/backtesting/daily-report
   *
   * End-of-day capture health, decision health, data quality, stop
   * classifications, the live-versus-shadow agreement table, and every
   * breakdown the accumulating record can support — each one carrying its
   * sample size, its mature/immature split, and an exploratory flag when the
   * graded sample is below the inference minimum.
   *
   * Observability only. Nothing here is read by the trading engine.
   */
  router.get('/daily-report', async (req: Request, res: Response) => {
    try {
      const sinceHours = Math.min(Number(req.query.sinceHours ?? 24) || 24, 24 * 400);
      res.json({ success: true, data: await dailyReport(sinceHours) });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Daily report failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/win-rate', async (req: Request, res: Response) => {
    try {
      const modeParam = (req.query.mode as string || '').toUpperCase();
      const mode: TradingMode | 'ALL' = modeParam === 'INTRADAY' || modeParam === 'POSITIONAL' ? modeParam : 'ALL';
      const sinceParam = Number(req.query.since);
      const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : undefined;
      const data = await getWinRateAnalytics(mode, since);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Win-rate analytics fetch failed');
      res.status(502).json({ success: false, error: { code: 'WIN_RATE_FAILED', message: error.message } });
    }
  });

  /**
   * GET /api/backtesting/trade-setups?limit=100
   * Raw trade-setup history, newest first.
   */
  router.get('/trade-setups', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 2000);
      const data = await getTradeSetupHistory(limit);
      res.json({ success: true, data, meta: { timestamp: Date.now(), source: 'LIVE' } });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Trade setup history fetch failed');
      res.status(502).json({ success: false, error: { code: 'TRADE_SETUPS_FAILED', message: error.message } });
    }
  });

  return router;
}
