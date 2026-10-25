// ============================================================
// OFIT TOKEN SHARE (2026-10-25)
// ============================================================
// Dhan keeps ONE live access token per client id: generating a new one kills the
// old one, and a login is allowed once every 2 minutes. OFIT (a separate,
// analysis-only project) uses the same Dhan account, so if it logged in on its own
// the two apps would keep logging each other out. This terminal stays the only
// app that logs in; OFIT asks it for the token it already holds.
//
//   GET /internal/ofit/dhan-token   Authorization: Bearer <OFIT_SHARED_SECRET>
//
// * Outside /api on purpose: /api needs a terminal session (api-auth.ts); this
//   route has its own machine secret instead.
// * OFF unless OFIT_SHARED_SECRET is set (>= 32 characters). Off, it answers 404
//   exactly like an unknown route.
// * Read only: it hands out the token dhan-session.ts already holds. It never
//   logs in or renews, so it cannot burn the 2-minute login allowance or kick
//   the feed's own token. No order API is involved.
// * The token is never logged; responses are marked no-store.
// ============================================================

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { bearerToken, passwordMatches } from '../lib/api-auth.js';
import { dhanSession, dhanSessionStatus } from '../services/dhan-session.js';
import { logger } from '../lib/logger.js';

export const OFIT_SHARE_PATH = '/internal/ofit/dhan-token';
const MIN_SECRET_LENGTH = 32;

/** The shared secret, or null when the route must stay off (unset or too short to be safe). */
export function ofitShareSecretFrom(env: NodeJS.ProcessEnv): string | null {
  const s = env.OFIT_SHARED_SECRET?.trim();
  return s && s.length >= MIN_SECRET_LENGTH ? s : null;
}

/** Ten refused requests per 15 minutes per address; a correct one does not count. */
const refusedLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many refused requests.' } },
});

export interface OfitShareDeps {
  session: typeof dhanSession;
  status: typeof dhanSessionStatus;
}

export function createOfitTokenShareRoutes(
  secret: string | null,
  deps: OfitShareDeps = { session: dhanSession, status: dhanSessionStatus },
): Router {
  const router = Router();

  router.get('/', refusedLimiter, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!secret) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
      return;
    }
    if (!passwordMatches(bearerToken(req.headers.authorization) ?? undefined, secret)) {
      logger.warn({ ip: req.ip }, 'OFIT token share refused: bad or missing secret');
      res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Unauthorized.' } });
      return;
    }
    const held = deps.session();
    if (!held) {
      res.status(503).json({ success: false, error: { code: 'DHAN_SESSION_UNAVAILABLE', message: 'The terminal holds no valid Dhan token right now. Retry shortly.' } });
      return;
    }
    logger.info({ ip: req.ip }, 'OFIT token share: token served');
    res.json({ success: true, data: { clientId: held.clientId, accessToken: held.accessToken, expiresAt: deps.status().expiresAt } });
  });

  // Nothing else is served here, whatever the method.
  router.all('/', (_req, res) => {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only.' } });
  });

  return router;
}
