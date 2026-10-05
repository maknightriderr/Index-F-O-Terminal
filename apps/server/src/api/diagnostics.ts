// ============================================================
// API ROUTES — SIGNAL DIAGNOSTICS (Stage 2: signal-diagnostics)
// ============================================================
// Read-only. Every endpoint is a SELECT over setup_events /
// opportunity_census(_daily); none of them touches a live decision.
//
//   GET /api/diagnostics/summary     detection + decision, by instrument
//   GET /api/diagnostics/rejections  rejection-reason distribution
//   GET /api/diagnostics/census      the daily opportunity census
//   GET /api/diagnostics/grades      performance by grade/pool/trigger
//   GET /api/diagnostics/leakage     filter leakage (rejected setups that
//                                    later hit 2R)
//   GET /api/diagnostics/performance PF, drawdown, gross/net R, MFE/MAE and
//                                    cost leakage, per instrument and cohort
//   GET /api/diagnostics/opportunity objective opportunities, detection and
//                                    capture rates with numerator/denominator
//   GET /api/diagnostics/major-moves large moves: what started them, who
//                                    recognised them, traded / missed / why
//   GET /api/diagnostics/triggers    the trigger registry, live stages, who needs displacement
//   GET /api/diagnostics/shadow      SHADOW families' forward record
//   GET /api/diagnostics/versions    strategy/cost versions present
//   GET /api/diagnostics/setup-outcomes?lifecycleIds=a,b  per-setup measurement
//                                    for the Trade Setup card
//
// Query: from=YYYY-MM-DD, to=YYYY-MM-DD, instrument=SYMBOL, strategyVersion,
// costVersion (all optional; without an instrument every instrument is
// returned SEPARATELY — never pooled).
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { redis, scanKeys } from '../lib/redis.js';
import { decisionDiagnostics, listDecisions } from '../services/decision-diagnostics.js';

const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import {
  diagnosticsSummary,
  diagnosticsRejections,
  diagnosticsCensus,
  diagnosticsGrades,
  diagnosticsLeakage,
  diagnosticsPerformance,
  diagnosticsOpportunity,
  diagnosticsVersions,
  diagnosticsSetupOutcomes,
  diagnosticsMajorMoves,
  diagnosticsShadow,
  type DiagnosticsQuery,
} from '../services/signal-diagnostics.js';
import { TRIGGER_REGISTRY, DISPLACEMENT_REQUIRED_BY } from '@fno/analytics';
import { liveTriggerStages } from '../services/trigger-router.js';
import { EVENT_ENGINE_VERSION } from '../config/trading-flags.js';
import { signalEngineMetrics } from '../services/signal-engine-metrics.js';
import { replayFull } from '../services/full-replay.js';

/** One full replay at a time: it re-runs the whole decision path in this process. */
let fullReplayRunning = false;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^[A-Za-z0-9._-]{1,32}$/;
const LIFECYCLE_ID = /^[A-Za-z0-9:._&-]{1,120}$/;

function parseQuery(req: Request): DiagnosticsQuery {
  const from = typeof req.query.from === 'string' && DATE.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && DATE.test(req.query.to) ? req.query.to : null;
  const instrument = typeof req.query.instrument === 'string' && req.query.instrument.trim() !== '' ? req.query.instrument.trim().toUpperCase().slice(0, 40) : null;
  const version = (v: unknown) => (typeof v === 'string' && VERSION.test(v) ? v : null);
  return {
    since: from ? new Date(`${from}T00:00:00+05:30`) : null,
    until: to ? new Date(`${to}T23:59:59+05:30`) : null,
    instrument,
    strategyVersion: version(req.query.strategyVersion),
    costVersion: version(req.query.costVersion),
  };
}

const SIMULATION_NOTE = 'Every figure is a simulated paper-trade outcome from recorded setup_events, never a broker fill or account P&L. Instruments are reported separately — never pooled across index and MCX.';

export function createDiagnosticsRoutes(): Router {
  const router = Router();

  router.get('/summary', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, byInstrument: await diagnosticsSummary(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics summary failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/rejections', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, rows: await diagnosticsRejections(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics rejections failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/census', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, rows: await diagnosticsCensus(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics census failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/grades', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, rows: await diagnosticsGrades(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics grades failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/leakage', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, rows: await diagnosticsLeakage(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics leakage failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/performance', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, ...(await diagnosticsPerformance(q)) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics performance failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/opportunity', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, ...(await diagnosticsOpportunity(q)) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics opportunity failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/major-moves', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, rows: await diagnosticsMajorMoves(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics major moves failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // The trigger registry: every rule's pre-registered definition, its live stage, and which rules need a displacement.
  router.get('/triggers', (_req: Request, res: Response) => {
    res.json({ success: true, data: { engineVersion: EVENT_ENGINE_VERSION, triggers: TRIGGER_REGISTRY, stages: liveTriggerStages(), displacementRequiredBy: DISPLACEMENT_REQUIRED_BY } });
  });

  // SHADOW families' forward record: live candidates, would-have-traded, graded outcomes.
  router.get('/shadow', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { note: SIMULATION_NOTE, rows: await diagnosticsShadow(q) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics shadow failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/versions', async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await diagnosticsVersions() });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics versions failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/setup-outcomes', async (req: Request, res: Response) => {
    try {
      const raw = typeof req.query.lifecycleIds === 'string' ? req.query.lifecycleIds.split(',') : [];
      const ids = [...new Set(raw.map((s) => s.trim()).filter((s) => LIFECYCLE_ID.test(s)))].slice(0, 20);
      res.json({ success: true, data: { rows: await diagnosticsSetupOutcomes(ids) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics setup outcomes failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Phase 8: the DecisionRecord research view.
  router.get('/decisions', async (req: Request, res: Response) => {
    try {
      const symbol = typeof req.query.symbol === 'string' && /^[A-Z0-9&_-]{1,30}$/.test(req.query.symbol) ? req.query.symbol : undefined;
      const limit = Number(req.query.limit);
      res.json({ success: true, data: { rows: await listDecisions({ symbol, limit: Number.isFinite(limit) ? limit : undefined }) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics decisions failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/decision/:snapshotId', async (req: Request, res: Response) => {
    const id = req.params.snapshotId;
    if (!SNAPSHOT_ID.test(id)) {
      res.status(400).json({ success: false, error: 'snapshotId must be a UUID.' });
      return;
    }
    try {
      const view = await decisionDiagnostics(id, { replay: req.query.replay === '1' });
      if (!view) {
        res.status(404).json({ success: false, error: 'No decision snapshot with this id.' });
        return;
      }
      res.json({ success: true, data: view });
    } catch (err: any) {
      logger.error({ error: err.message, snapshotId: id }, 'Signal diagnostics decision failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Full replay (io-tape.ts): the unchanged decision path re-run at the poll's
  // own instant with every read served from its tape — no network, no writes
  // (writes are compared as effects). Read-only; one at a time.
  router.get('/decision/:snapshotId/replay-full', async (req: Request, res: Response) => {
    const id = req.params.snapshotId;
    if (!SNAPSHOT_ID.test(id)) {
      res.status(400).json({ success: false, error: 'snapshotId must be a UUID.' });
      return;
    }
    if (fullReplayRunning) {
      res.status(429).json({ success: false, error: 'A full replay is already running — try again shortly.' });
      return;
    }
    fullReplayRunning = true;
    try {
      const report = await replayFull(id);
      res.status(report.status === 'NOT_FOUND' ? 404 : 200).json({ success: report.status !== 'NOT_FOUND', data: report });
    } catch (err: any) {
      logger.error({ error: err.message, snapshotId: id }, 'Full replay failed');
      res.status(500).json({ success: false, error: err.message });
    } finally {
      fullReplayRunning = false;
    }
  });

  // The slot's behaviour and forward validation (signal-engine-metrics.ts).
  router.get('/signal-engine', async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: { note: SIMULATION_NOTE, ...(await signalEngineMetrics(parseQuery(req))) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics signal-engine metrics failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Phase 5: feed-gap checks of open paper trades (last 3 days) — FILL_UNCERTAIN /
  // MISSED_TOUCH_POSSIBLE are surfaced here; nothing was assumed for them.
  router.get('/feed-gaps', async (_req: Request, res: Response) => {
    try {
      const keys = (await scanKeys('feed_gap:*')).slice(0, 500);
      const values = keys.length ? await redis.mget(...keys) : [];
      const rows = values
        .map((v) => {
          try {
            return v ? JSON.parse(v) : null;
          } catch {
            return null;
          }
        })
        .filter((r): r is Record<string, unknown> & { checkedAt: number } => r != null)
        .sort((a, b) => b.checkedAt - a.checkedAt);
      res.json({ success: true, data: { rows } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Signal diagnostics feed gaps failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
