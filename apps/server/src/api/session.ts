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
import { createReadonlyKey, readonlyKeyStatus, revokeReadonlyKeys } from '../lib/readonly-key.js';

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

  // ---- Read-only API key (18 Nov). The gate already demands a session here; a read-only key never reaches these. ----
  const ownerOnly = (res: Response) => {
    if (res.locals.authenticated === true && res.locals.readOnly !== true) return true;
    res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Sign in to manage the read-only key.' } });
    return false;
  };
  router.get('/readonly-key', async (_req: Request, res: Response) => {
    if (!ownerOnly(res)) return;
    try { res.json({ success: true, data: await readonlyKeyStatus() }); }
    catch (e: any) { logger.error({ error: e.message }, 'Read-only key status failed'); res.status(503).json({ success: false, error: { code: 'READONLY_KEY_UNAVAILABLE', message: 'The read-only key store is unavailable.' } }); }
  });
  /** Creates a new key (revoking the old one) and returns it once. */
  router.post('/readonly-key', async (req: Request, res: Response) => {
    if (!ownerOnly(res)) return;
    try {
      const created = await createReadonlyKey();
      logger.info({ event: 'readonlyKeyCreated', ip: req.ip }, 'Read-only API key created (previous one revoked)');
      res.json({ success: true, data: created });
    } catch (e: any) { logger.error({ error: e.message }, 'Read-only key create failed'); res.status(503).json({ success: false, error: { code: 'READONLY_KEY_UNAVAILABLE', message: 'The key could not be created.' } }); }
  });
  router.post('/readonly-key/revoke', async (req: Request, res: Response) => {
    if (!ownerOnly(res)) return;
    try {
      const revoked = await revokeReadonlyKeys();
      logger.info({ event: 'readonlyKeyRevoked', revoked, ip: req.ip }, 'Read-only API key revoked');
      res.json({ success: true, data: { revoked } });
    } catch (e: any) { logger.error({ error: e.message }, 'Read-only key revoke failed'); res.status(503).json({ success: false, error: { code: 'READONLY_KEY_UNAVAILABLE', message: 'The key could not be revoked.' } }); }
  });

  return router;
}
