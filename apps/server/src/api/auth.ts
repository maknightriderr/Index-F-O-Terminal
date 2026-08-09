// ============================================================
// API ROUTES — AUTHENTICATION
// ============================================================

import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import type { MarketDataProvider } from '../providers/interface.js';

export function createAuthRoutes(provider: MarketDataProvider): Router {
  const router = Router();

  /**
   * POST /api/auth/login
   * Authenticate with the market data provider.
   * Body: { apiKey, clientId, password, totpSecret }
   */
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { apiKey, clientId, password, totpSecret } = req.body;

      if (!apiKey || !clientId || !password) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'apiKey, clientId, and password are required' },
        });
        return;
      }

      const result = await provider.authenticate({
        apiKey,
        clientId,
        password,
        totpSecret,
      });

      if (result.success) {
        // Create a session JWT
        const sessionToken = jwt.sign(
          { clientId, provider: provider.name, authenticatedAt: Date.now() },
          config.jwt.secret,
          { expiresIn: config.jwt.expiry as jwt.SignOptions['expiresIn'] }
        );

        res.json({
          success: true,
          data: {
            sessionToken,
            provider: provider.name,
            expiresAt: result.expiresAt,
          },
        });
      } else {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_FAILED', message: result.error || 'Authentication failed' },
        });
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Login failed');
      res.status(500).json({
        success: false,
        error: { code: 'LOGIN_ERROR', message: error.message },
      });
    }
  });

  /**
   * GET /api/auth/status
   * Check authentication status.
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

  /**
   * POST /api/auth/logout
   * Logout from the provider.
   */
  router.post('/logout', async (_req: Request, res: Response) => {
    try {
      await provider.logout();
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'LOGOUT_ERROR', message: error.message },
      });
    }
  });

  return router;
}
