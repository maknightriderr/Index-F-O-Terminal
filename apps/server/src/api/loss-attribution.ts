// ============================================================
// API ROUTES — LOSS ATTRIBUTION (Phase 1)
// ============================================================
// Read-only. Every endpoint is a SELECT over recorded decisions; none of
// them filters, gates or changes a live setup, and every figure returned is
// a SIMULATED paper-trade outcome, not account P&L.
//
//   GET /api/loss-attribution/report  the 12 pre-built questions
//   GET /api/loss-attribution/split   in-sample vs out-of-sample at
//                                     DATA_QUALITY_CUTOVER_AT
//   GET /api/loss-attribution/gates   per-gate pass/fail from gate_diagnostics
//   GET /api/loss-attribution/shadow  Phase 2 shadow-vs-live comparison
//   (the report also carries Phase 2 `invalidation` and `exposure` panels)
//
// Query: since=YYYY-MM-DD, until=YYYY-MM-DD, scope=TAKE|REFUSE|ALL
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import {
  lossAttributionReport,
  lossAttributionSplitReport,
  gateFailureSummary,
  shadowComparisonReport,
  type AttributionQuery,
  type DecisionScope,
} from '../services/loss-attribution.js';
import { SIMULATION_NOTE } from '../services/loss-attribution-model.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseQuery(req: Request): AttributionQuery {
  const since = typeof req.query.since === 'string' && DATE.test(req.query.since) ? req.query.since : null;
  const until = typeof req.query.until === 'string' && DATE.test(req.query.until) ? req.query.until : null;
  const rawScope = typeof req.query.scope === 'string' ? req.query.scope.toUpperCase() : 'TAKE';
  const decision: DecisionScope = rawScope === 'REFUSE' || rawScope === 'ALL' ? rawScope : 'TAKE';
  return {
    since: since ? new Date(`${since}T00:00:00+05:30`) : null,
    until: until ? new Date(`${until}T00:00:00+05:30`) : null,
    decision,
  };
}

export function createLossAttributionRoutes(): Router {
  const router = Router();

  router.get('/report', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { scope: q.decision, ...(await lossAttributionReport(q)) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Loss attribution report failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/split', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: { scope: q.decision, note: SIMULATION_NOTE, ...(await lossAttributionSplitReport(q)) } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Loss attribution split report failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/gates', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({
        success: true,
        data: {
          note: 'Each gate evaluated independently for every recorded decision. Observation only — the live first-match chain is unchanged.',
          gates: await gateFailureSummary(q),
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Gate diagnostics summary failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Phase 2: shadow strike / execution / target vs live. Taken paper trades
  // only (shadow models are recorded on TAKE rows). Switches nothing.
  router.get('/shadow', async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      res.json({ success: true, data: await shadowComparisonReport(q) });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Shadow comparison report failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
