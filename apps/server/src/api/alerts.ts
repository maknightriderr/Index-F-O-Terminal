// ============================================================
// API ROUTES — ALERTS
// ============================================================

import { Router, type Request, type Response } from 'express';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { Alert } from '@fno/shared';

interface AlertRow {
  id: string;
  symbol: string;
  alert_type: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  channels: string[];
  condition: Record<string, unknown> | null;
  triggered: boolean;
  triggered_at: Date | null;
  created_at: Date;
}

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    symbol: row.symbol,
    type: row.alert_type as Alert['type'],
    message: row.message,
    severity: row.severity,
    channels: row.channels as Alert['channels'],
    triggered: row.triggered,
    triggeredAt: row.triggered_at ? new Date(row.triggered_at).getTime() : undefined,
    createdAt: new Date(row.created_at).getTime(),
    data: row.condition ?? undefined,
  };
}

export function createAlertRoutes(): Router {
  const router = Router();

  /**
   * GET /api/alerts?limit=50&type=IV_SPIKE&severity=WARNING
   * Most recent alerts, newest first. `type`/`severity` filter server-side
   * so a filtered view isn't silently limited to whatever happened to be
   * in the last `limit` unfiltered rows (e.g. a CRITICAL-only filter
   * previously could show nothing even with real CRITICAL alerts further
   * back than the fetch window, since filtering only ever happened
   * client-side after the fact).
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10) || 50, 1), 200);
      const type = (req.query.type as string) || null;
      const severity = (req.query.severity as string) || null;

      const rows = await sql<AlertRow[]>`
        SELECT id, symbol, alert_type, message, severity, channels, condition, triggered, triggered_at, created_at
        FROM alerts
        WHERE 1=1
          ${type ? sql`AND alert_type = ${type}` : sql``}
          ${severity ? sql`AND severity = ${severity}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      res.json({
        success: true,
        data: rows.map(toAlert),
        meta: { count: rows.length, timestamp: Date.now() },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Alerts fetch failed');
      res.status(500).json({
        success: false,
        error: { code: 'ALERTS_FETCH_FAILED', message: error.message },
      });
    }
  });

  return router;
}
