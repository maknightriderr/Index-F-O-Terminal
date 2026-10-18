// ============================================================
// API ROUTES — BROKER SESSION STATUS
// ============================================================
// The broker session is opened from environment credentials at boot
// (index.ts authenticateOnBoot) and kept alive by the refresh timer.
// POST /login and POST /logout were removed (audit 2026-10-18, SEC-1): they
// let anyone who could reach the API open or end the broker session. Signing
// in to the TERMINAL is /api/session.
// ============================================================

import { Router, type Request, type Response } from 'express';
import type { MarketDataProvider } from '../providers/interface.js';

export function createAuthRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * GET /api/auth/status
   * Is the broker session open?
   */
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        authenticated: provider.isAuthenticated(),
        provider: provider.name,
      },
    });
  });

  return router;
}
