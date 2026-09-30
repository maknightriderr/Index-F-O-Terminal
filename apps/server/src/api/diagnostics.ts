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
//
// Query: from=YYYY-MM-DD, to=YYYY-MM-DD, instrument=SYMBOL (optional; when
// absent every instrument is returned SEPARATELY — never pooled).
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { diagnosticsSummary, diagnosticsRejections, diagnosticsCensus, diagnosticsGrades, diagnosticsLeakage, type DiagnosticsQuery } from '../services/signal-diagnostics.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseQuery(req: Request): DiagnosticsQuery {
  const from = typeof req.query.from === 'string' && DATE.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && DATE.test(req.query.to) ? req.query.to : null;
  const instrument = typeof req.query.instrument === 'string' && req.query.instrument.trim() !== '' ? req.query.instrument.trim().toUpperCase().slice(0, 40) : null;
  return {
    since: from ? new Date(`${from}T00:00:00+05:30`) : null,
    until: to ? new Date(`${to}T23:59:59+05:30`) : null,
    instrument,
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

  return router;
}
