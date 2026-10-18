// ============================================================
// TERMINAL API AUTH (audit 2026-10-18, SEC-1)
// ============================================================
// Until now every /api route, the /ws feed and POST /api/auth/logout (which
// ended the broker session) answered anyone who knew the URL. Now every /api
// route needs a session except the health probes and the sign-in route:
//   * POST /api/session {password} — the terminal password (TERMINAL_PASSWORD),
//     compared in constant time — returns a JWT (HS256, 7 days);
//   * REST sends it as `Authorization: Bearer <jwt>`, the /ws upgrade as `?token=<jwt>`.
// The signing key is derived from JWT_SECRET AND the password, so changing
// TERMINAL_PASSWORD signs every existing session out.
//
// Fail closed: in production without TERMINAL_PASSWORD (or with a short or
// development JWT_SECRET) every protected route answers 503
// AUTH_NOT_CONFIGURED. In development without a password the API stays open,
// as it always was.
// Pure apart from the Express glue: every decision takes its inputs as arguments.
// ============================================================

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const SESSION_TYP = 'terminal-session';
export const SESSION_TTL_S = 7 * 24 * 3600;
const MIN_SECRET_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 256;

export interface ApiAuthConfig {
  password: string | null;
  secret: string;
  production: boolean;
}

export type AuthMode = 'ENFORCED' | 'OPEN_DEV' | 'MISCONFIGURED';

/** Routes that answer without a session: the probes (status only) and the sign-in route. Lower case, no trailing slash. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/health',
  'GET /api/health/memory',
  'GET /api/health/ready',
  'GET /api/session',
  'POST /api/session',
]);

export function apiAuthConfigFrom(env: NodeJS.ProcessEnv, secret: string): ApiAuthConfig {
  return { password: env.TERMINAL_PASSWORD?.trim() || null, secret, production: env.NODE_ENV === 'production' };
}

const weakSecret = (secret: string) => secret.length < MIN_SECRET_LENGTH || secret.includes('dev-') || secret.includes('change-in-production');

export function authMode(cfg: ApiAuthConfig): { mode: AuthMode; reason: string | null } {
  if (cfg.password) {
    if (cfg.production && weakSecret(cfg.secret)) return { mode: 'MISCONFIGURED', reason: 'JWT_SECRET is unset, shorter than 32 characters or the development default.' };
    return { mode: 'ENFORCED', reason: null };
  }
  if (cfg.production) return { mode: 'MISCONFIGURED', reason: 'TERMINAL_PASSWORD is not set.' };
  return { mode: 'OPEN_DEV', reason: null };
}

/** Constant-time: both sides are hashed to 32 bytes first, so neither the length nor the content leaks through timing. */
export function passwordMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length === 0 || given.length > MAX_PASSWORD_LENGTH) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const signingKey = (cfg: ApiAuthConfig) => createHmac('sha256', cfg.secret).update(`${SESSION_TYP}\0${cfg.password ?? ''}`).digest();

export function issueSession(cfg: ApiAuthConfig, now = Date.now()): { token: string; expiresAt: number } {
  const iat = Math.floor(now / 1000);
  const token = jwt.sign({ typ: SESSION_TYP, iat }, signingKey(cfg), { algorithm: 'HS256', expiresIn: SESSION_TTL_S, subject: 'terminal' });
  return { token, expiresAt: (iat + SESSION_TTL_S) * 1000 };
}

/** A session issued by issueSession for the current password and not expired. Anything else (another typ, algorithm, key) is refused. */
export function verifySession(token: string | null | undefined, cfg: ApiAuthConfig, now = Date.now()): boolean {
  if (!token || !cfg.password) return false;
  try {
    const p = jwt.verify(token, signingKey(cfg), { algorithms: ['HS256'], clockTimestamp: Math.floor(now / 1000) }) as jwt.JwtPayload;
    return p?.typ === SESSION_TYP && p?.sub === 'terminal';
  } catch {
    return false;
  }
}

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  return m ? m[1] : null;
}

export function routeKey(method: string, path: string): string {
  const p = path.toLowerCase().replace(/\/+$/, '') || '/';
  return `${method.toUpperCase()} ${p}`;
}

export type GateVerdict = { ok: true; authenticated: boolean } | { ok: false; status: 401 | 503; code: 'AUTH_REQUIRED' | 'AUTH_NOT_CONFIGURED'; message: string };

/** The whole decision for one request. `authenticated` tells a public route whether the caller has a valid session. */
export function gateRequest(args: { method: string; path: string; authorization: string | undefined; cfg: ApiAuthConfig; now?: number }): GateVerdict {
  const { mode, reason } = authMode(args.cfg);
  if (mode === 'OPEN_DEV') return { ok: true, authenticated: true };
  const authenticated = mode === 'ENFORCED' && verifySession(bearerToken(args.authorization), args.cfg, args.now);
  if (args.method.toUpperCase() === 'OPTIONS' || PUBLIC_ROUTES.has(routeKey(args.method, args.path))) return { ok: true, authenticated };
  if (mode === 'MISCONFIGURED') return { ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED', message: `The terminal is locked: ${reason} Set it on the server and redeploy.` };
  if (authenticated) return { ok: true, authenticated };
  return { ok: false, status: 401, code: 'AUTH_REQUIRED', message: 'Sign in to use the terminal.' };
}

/** Express glue: mount with app.use('/api', requireSession(cfg)) BEFORE every /api router. */
export function requireSession(cfg: ApiAuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const verdict = gateRequest({ method: req.method, path: `${req.baseUrl}${req.path}`, authorization: req.headers.authorization, cfg });
    if (verdict.ok) {
      res.locals.authenticated = verdict.authenticated;
      next();
      return;
    }
    res.status(verdict.status).json({ success: false, error: { code: verdict.code, message: verdict.message } });
  };
}
