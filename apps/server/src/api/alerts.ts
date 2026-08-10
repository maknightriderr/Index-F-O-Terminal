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
   * GET /api/alerts?limit=50
   * Most recent alerts, newest first.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10) || 50, 1), 200);

      const rows = await sql<AlertRow[]>`
        SELECT id, symbol, alert_type, message, severity, channels, condition, triggered, triggered_at, created_at
        FROM alerts
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
