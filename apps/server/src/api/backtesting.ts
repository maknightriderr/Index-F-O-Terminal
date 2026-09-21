// ============================================================
// API ROUTES — BACKTESTING (Trade Setup outcome analytics)
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { getTradeSetupHistory, getWinRateAnalytics } from '../services/backtesting.js';
import type { TradingMode } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
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
  eligibleUniverse,
  captureModeReport,
} from '../services/capture-diagnostics.js';
import {
  greekCoverage,
  nullZeroAudit,
  snapshotLineage,
  universeCoverage,
  replayStatus,
  newBoundary,
} from '../services/data-integrity.js';
import { researchMilestones } from '../services/ensure-capture-schema.js';
import { dailyReport } from '../services/daily-report.js';
import {
  generationCensus,
  greekReplayEligibility,
  researchPopulationScope,
  decisionPopulation,
  ELIGIBILITY_DEFINITIONS,
  CUTOVER_MILESTONES,
} from '../services/contract-generations.js';
import { DATA_QUALITY_CUTOVER_AT } from '../services/capture-quality.js';

export function createBacktestingRoutes(provider: MarketDataProvider): Router {
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
      // ONE boundary for the whole report. The previous release compared a
      // Greek count taken at 16:12 against a leg count taken at 16:18, and the
      // six-minute drift looked exactly like a missing 82-leg snapshot. Every
      // query below evaluates against this single instant, and every section
      // states the instant it used.
      const boundary = newBoundary();
      const eligible = await eligibleUniverse(provider);
      const [timeline, chains, maturity, universe, replay, greeks, nullZero, lineage, coverage, milestones] =
        await Promise.all([
          captureTimeline(),
          chainCompleteness(sinceHours),
          refusalMaturity(),
          captureUniverse(),
          replayStatus(boundary),
          greekCoverage(boundary),
          nullZeroAudit(boundary),
          snapshotLineage(boundary),
          universeCoverage(eligible, boundary),
          researchMilestones(),
        ]);
      res.json({
        success: true,
        data: {
          /**
           * The single instant every bounded section below was evaluated at.
           * Sections carrying their own asOf used this one; any that do not
           * are unbounded by nature and say so.
           */
          report_as_of: boundary.asOf.toISOString(),
          timestampContract:
            'Every metric carrying an asOf field was evaluated against report_as_of. Never compare a figure from this report against one from another reading without checking both asOf values.',
          timeline,
          chains,
          maturity,
          universe,
          replay,
          greeks,
          nullZero,
          lineage,
          universeCoverage: coverage,
          captureMode: captureModeReport(),
          milestones,
        },
      });
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

  /**
   * GET /api/backtesting/data-contract
   *
   * The formal data-contract health check. One boundary, one denominator, and
   * every metric carrying its own as_of and population_definition — so a
   * future report cannot mix denominators the way the last one did.
   *
   * Observability only. Nothing here is read by the trading engine.
   */
  router.get('/data-contract', async (req: Request, res: Response) => {
    try {
      const asOf = new Date();
      const sinceHours = Math.min(Number(req.query.sinceHours ?? 48) || 48, 24 * 400);

      const [generations, eligibility, scope, decisions, lineage, milestones] = await Promise.all([
        generationCensus(asOf, DATA_QUALITY_CUTOVER_AT),
        greekReplayEligibility(asOf, DATA_QUALITY_CUTOVER_AT),
        researchPopulationScope(asOf, DATA_QUALITY_CUTOVER_AT),
        decisionPopulation(asOf, sinceHours),
        snapshotLineage(newBoundary(asOf)),
        researchMilestones(),
      ]);

      const cutovers = Object.fromEntries(
        CUTOVER_MILESTONES.map((m) => {
          const found = milestones.find((x) => x.layer === m);
          return [m, found?.recording_started_at ?? null];
        })
      );

      res.json({
        success: true,
        data: {
          report_as_of: asOf.toISOString(),
          timestampContract:
            'Every metric below was evaluated against report_as_of and carries its own as_of and population_definition. Never compare a figure here against one from another reading without checking both.',
          contract_generations: generations,
          cutover_timestamps: {
            as_of: asOf.toISOString(),
            population_definition: 'Immutable milestones from research_milestones, written once and never moved on restart.',
            ...cutovers,
            // The data-quality cutover is a compiled constant rather than a
            // recorded milestone, because it names the deploy that changed the
            // write contract and must not drift with a restart.
            data_quality_cutover_at_constant: new Date(DATA_QUALITY_CUTOVER_AT).toISOString(),
            note:
              'Four independent transitions. They landed close together and are NOT the same event: a row written between two of them belongs to neither the old contract nor the new one.',
          },
          replay_eligibility: {
            definitions: ELIGIBILITY_DEFINITIONS,
            ...eligibility,
          },
          research_population: scope,
          lineage_integrity: lineage,
          decision_population: decisions,
          allMilestones: milestones,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Data-contract health check failed');
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
