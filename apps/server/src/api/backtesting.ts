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
} from '../services/data-integrity.js';
import { createReportAsOf, checkBoundaries, type SectionBoundary } from '../services/report-boundary.js';
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
import {
  getSnapshotPopulations,
  populationInvocationCount,
} from '../services/snapshot-populations.js';
import {
  LineageContractError,
  LINEAGE_ACTIVATION_EVIDENCE_NOTE,
  RUNTIME_ACTIVATION_TIMESTAMP_UNVERIFIED,
  AUTHORITATIVE_SOURCES,
} from '../services/lineage-contract.js';

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
      // One clock read here too. Both windows are measured back from the
      // same instant; two Date.now() calls are two instants even when they
      // land in the same millisecond, and "usually identical" is not a
      // property a report should rest on.
      const boundary = createReportAsOf();
      const since = new Date(boundary.asOf.getTime() - 24 * 60 * 60 * 1000);
      const missedSince = new Date(boundary.asOf.getTime() - 90 * 24 * 60 * 60 * 1000);
      const [tables, decisions, rejections, missed, dataQuality] = await Promise.all([
        captureCoverage(),
        decisionCoverage(),
        rejectionBreakdown(since),
        missedWinnerReport(missedSince),
        dataQualitySummary(since),
      ]);
      res.json({
        success: true,
        data: {
          report_as_of: boundary.asOf.toISOString(),
          windows: {
            rejectionsLast24h: { since: since.toISOString(), until: boundary.asOf.toISOString() },
            missedWinners: { since: missedSince.toISOString(), until: boundary.asOf.toISOString() },
          },
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

      // THE ONLY CLOCK READ IN THIS REQUEST.
      //
      // Every bounded section below receives this instant. Sections used to
      // be free to call new Date() themselves, and did: report_as_of came
      // back at .097, coverage_as_of at .172, chains.asOf at .244. Small
      // drift, but it meant the response as a whole described no single
      // instant — and nothing in it said so.
      const boundary = createReportAsOf();
      const eligible = await eligibleUniverse(provider);

      // ONE population calculation for the whole report.
      //
      // 1 as_of -> 1 calculation -> 1 immutable result -> 2 consumers.
      //
      // The lineage section and the universe section used to call the same
      // function separately. Same question, same boundary — but two reads of
      // a live table milliseconds apart, which is a shared question and not
      // a shared answer. The result is computed here, once, and handed down.
      const populationCallsBefore = populationInvocationCount();
      const populations = await getSnapshotPopulations(boundary.asOf);
      const populationCalculations = populationInvocationCount() - populationCallsBefore;

      const [timeline, chains, maturity, universe, replay, greeks, nullZero, lineage, coverage, milestones] =
        await Promise.all([
          captureTimeline(boundary),
          chainCompleteness(sinceHours, boundary),
          refusalMaturity(boundary),
          captureUniverse(boundary),
          replayStatus(boundary),
          greekCoverage(boundary),
          nullZeroAudit(boundary),
          snapshotLineage(boundary, populations),
          universeCoverage(eligible, boundary, populations),
          researchMilestones(),
        ]);

      // Every instant this response carries, checked against the one
      // boundary. Sections carrying evidence time are listed separately —
      // forcing a milestone to equal the reading instant would be the
      // opposite error.
      const asOfOf = (v: unknown, k = 'asOf'): string | null =>
        (v as Record<string, unknown> | null)?.[k] as string | null ?? null;
      const sections: SectionBoundary[] = [
        { section: 'populations', as_of: populations.as_of, kind: 'query_bound' },
        { section: 'lineage', as_of: asOfOf(lineage), kind: 'query_bound' },
        { section: 'universeCoverage', as_of: asOfOf(coverage), kind: 'query_bound' },
        { section: 'chains', as_of: asOfOf(chains), kind: 'query_bound' },
        { section: 'timeline', as_of: asOfOf(timeline, 'coverage_as_of'), kind: 'query_bound' },
        { section: 'greeks', as_of: asOfOf(greeks), kind: 'query_bound' },
        { section: 'nullZero', as_of: asOfOf(nullZero), kind: 'query_bound' },
        { section: 'replay', as_of: asOfOf(replay), kind: 'query_bound' },
        { section: 'maturity', as_of: asOfOf(maturity), kind: 'query_bound' },
        { section: 'universe', as_of: asOfOf(universe), kind: 'query_bound' },
        {
          section: 'milestones',
          as_of: null,
          kind: 'evidence_time',
          reason:
            'every milestone records when a layer first recorded something. These are historical instants, older than report_as_of by construction, and must NOT be forced to equal it.',
        },
        {
          section: 'captureMode',
          as_of: null,
          kind: 'unbounded',
          reason: 'declared configuration; reads no time-varying data.',
        },
      ];
      const boundaryContract = checkBoundaries(boundary.asOf, sections);
      res.json({
        success: true,
        data: {
          /**
           * The single instant every bounded section below was evaluated at.
           * Sections carrying their own asOf used this one; any that do not
           * are unbounded by nature and say so.
           */
          report_as_of: boundary.asOf.toISOString(),
          /**
           * Proof that this whole response describes ONE instant — not just
           * the sections that were already bounded.
           */
          boundaryContract,
          timestampContract:
            'report_as_of is the instant THIS REPORT was generated — the upper bound every bounded query evaluated against. It is NOT the time any captured evidence was recorded. Timestamps describing when something was first observed, when a layer started recording, or when a cutover happened are historical facts derived from the evidence itself and are older than report_as_of; a field named *_at or *_started_at is evidence time, while report_as_of and any as_of field is reading time. Never compare a figure from this report against one from another reading without checking both as_of values.',
          /**
           * Proof that every population figure in this report came from ONE
           * calculation, not from several that happened to agree.
           */
          populationContract: {
            population_calculation_invocation_count: populationCalculations,
            single_calculation:
              populationCalculations === 1
                ? 'PASS: exactly one population calculation for this report'
                : `FAIL: ${populationCalculations} population calculations in one report`,
            consumers: ['lineage', 'universeCoverage'],
            population_as_of: populations.as_of,
            as_of_consistent:
              populations.as_of === boundary.asOf.toISOString() &&
              (lineage as any)?.asOf === boundary.asOf.toISOString() &&
              (coverage as any)?.asOf === boundary.asOf.toISOString(),
            as_of_values: {
              report_as_of: boundary.asOf.toISOString(),
              population_as_of: populations.as_of,
              lineage_as_of: (lineage as any)?.asOf ?? null,
              universe_as_of: (coverage as any)?.asOf ?? null,
            },
            note: 'The lineage and universe sections are consumers of one immutable result. Neither runs its own snapshot query, so neither can report a different denominator for the same population.',
          },
          /**
           * Where the pre/post lineage boundary comes from.
           *
           * It is read from a persisted marker recording the deployment that
           * made capture_run_id stamping mandatory — NOT from the earliest
           * row that happens to carry one. A boundary derived from the first
           * surviving row cannot detect a stamping failure before it,
           * because the failure simply moves the boundary.
           */
          lineageContract: {
            lineage_era_started_at: populations.lineage_era_started_at,
            lineage_era_source: populations.lineage_era_source,
            lineage_era_source_reference: populations.lineage_era_source_reference,
            lineage_era_derivation: populations.lineage_era_derivation,
            // Checked against the authority LIST, not a literal. Comparing to
            // one hard-coded source string is why this field read false the
            // moment the marker was raised to a stronger source than the one
            // the comparison happened to name.
            authoritative: AUTHORITATIVE_SOURCES.includes(populations.lineage_era_source),
            fallback_policy:
              'NONE. If the authoritative marker is missing or non-authoritative this endpoint returns a contract error instead of classifying, because a boundary that silently degrades to the inferred value is the original defect under a new name.',
            /**
             * Whether the boundary rests on runtime evidence or on a
             * stand-in. It now rests on the deployment's own startup log, so
             * there is no build window left to caveat — but the field stays
             * so a reader can see the question was asked and answered rather
             * than inferring it from silence.
             */
            runtime_activation_timestamp_unverified: RUNTIME_ACTIVATION_TIMESTAMP_UNVERIFIED,
            activation_evidence: LINEAGE_ACTIVATION_EVIDENCE_NOTE,
          },
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
          /**
           * How to read a milestone timestamp.
           *
           * These are EVIDENCE times, not reading times. Each one is the
           * instant a layer first recorded something, derived once from the
           * evidence named in `derivation` and then frozen. They are older
           * than report_as_of by construction, and a reader comparing one
           * against report_as_of is comparing when a thing happened against
           * when this report was generated.
           */
          milestonesContract: {
            recording_started_at:
              'EVIDENCE TIME. When this layer first recorded data, derived from the evidence named in `derivation` and frozen on first write. Not the time this report ran.',
            derivation:
              'The evidence the timestamp was read from. A milestone with a null derivation predates the evidence-seeding fix and was written at boot time; it is the one case where a milestone timestamp is not evidence-derived, and it is labelled rather than silently corrected.',
            report_as_of:
              'READING TIME. When this report was generated. Every bounded query used it as its upper bound. No milestone should ever equal it.',
          },
        },
      });
    } catch (err: any) {
      // A missing or non-authoritative lineage boundary is reported as a
      // CONTRACT error, not as a server fault and not by falling back to the
      // derived boundary. Without an authoritative marker the pre/post
      // classification of every snapshot is unknown, and a report that
      // quietly reverted to inferring it would be the original defect under
      // a new name.
      if (err instanceof LineageContractError) {
        logger.error({ error: err.message }, 'Capture diagnostics failed: lineage contract unavailable');
        res.status(409).json({
          success: false,
          error: err.message,
          contract_error: 'LINEAGE_CONTRACT_UNAVAILABLE',
          remedy:
            'The authoritative lineage marker (research_milestones.layer = capture_lineage_cutover_at with source = authoritative_contract_marker) is seeded at boot from LINEAGE_CONTRACT_ACTIVATED_AT. Confirm migration 013 applied and the service has restarted since.',
          fallback_used: false,
        });
        return;
      }
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
      const sinceHours = Math.min(Number(req.query.sinceHours ?? 48) || 48, 24 * 400);

      // The only clock read in this request too, through the same creator.
      const boundary = createReportAsOf();
      const asOf = boundary.asOf;
      const populations = await getSnapshotPopulations(boundary.asOf);

      const [generations, eligibility, scope, decisions, lineage, milestones] = await Promise.all([
        generationCensus(asOf, DATA_QUALITY_CUTOVER_AT),
        greekReplayEligibility(asOf, DATA_QUALITY_CUTOVER_AT),
        researchPopulationScope(asOf, DATA_QUALITY_CUTOVER_AT),
        decisionPopulation(asOf, sinceHours),
        snapshotLineage(boundary, populations),
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
      // A missing or non-authoritative lineage boundary is reported as a
      // CONTRACT error, not as a server fault and not by falling back to the
      // derived boundary. Without an authoritative marker the pre/post
      // classification of every snapshot is unknown, and a report that
      // quietly reverted to inferring it would be the original defect under
      // a new name.
      if (err instanceof LineageContractError) {
        logger.error({ error: err.message }, 'Data-contract health check failed: lineage contract unavailable');
        res.status(409).json({
          success: false,
          error: err.message,
          contract_error: 'LINEAGE_CONTRACT_UNAVAILABLE',
          remedy:
            'The authoritative lineage marker (research_milestones.layer = capture_lineage_cutover_at with source = authoritative_contract_marker) is seeded at boot from LINEAGE_CONTRACT_ACTIVATED_AT. Confirm migration 013 applied and the service has restarted since.',
          fallback_used: false,
        });
        return;
      }
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
