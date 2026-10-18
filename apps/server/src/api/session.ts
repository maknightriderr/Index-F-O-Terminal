// ============================================================
// API ROUTES — TERMINAL SESSION (audit 2026-10-18, SEC-1)
// ============================================================
// GET  /api/session  public: is the API locked, and is this caller signed in?
// POST /api/session  public: {password} → a session token (lib/api-auth.ts).
// Sign-out is the browser dropping its token; changing TERMINAL_PASSWORD
// signs every session out.
// ============================================================

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMode, issueSession, passwordMatches, type ApiAuthConfig } from '../lib/api-auth.js';
import { logger } from '../lib/logger.js';

/** Ten wrong passwords per 15 minutes per address; a correct one does not count. */
const signInLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Wait 15 minutes and try again.' } },
});

export function createSessionRoutes(cfg: ApiAuthConfig): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const { mode, reason } = authMode(cfg);
    res.json({ success: true, data: { mode, authenticated: res.locals.authenticated === true, reason } });
  });

  router.post('/', signInLimiter, (req: Request, res: Response) => {
    const { mode, reason } = authMode(cfg);
    if (mode === 'MISCONFIGURED') {
      res.status(503).json({ success: false, error: { code: 'AUTH_NOT_CONFIGURED', message: `The terminal is locked: ${reason} Set it on the server and redeploy.` } });
      return;
    }
    if (mode === 'OPEN_DEV') {
      res.json({ success: true, data: { mode, token: null, expiresAt: null } });
      return;
    }
    if (!passwordMatches(req.body?.password, cfg.password as string)) {
      logger.warn({ ip: req.ip }, 'Terminal sign-in refused: wrong password');
      res.status(401).json({ success: false, error: { code: 'WRONG_PASSWORD', message: 'That password is not right.' } });
      return;
    }
    const session = issueSession(cfg);
    res.json({ success: true, data: { mode, token: session.token, expiresAt: session.expiresAt } });
  });

  return router;
}
