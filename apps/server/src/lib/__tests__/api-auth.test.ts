// ============================================================
// SEC-1 (audit 2026-10-18): every /api route needs a session except the probes and the sign-in route.
// ============================================================

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { ApiAuthConfig } from '../api-auth.js';

vi.mock('../logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { authMode, passwordMatches, issueSession, verifySession, gateRequest, requireSession, bearerToken, SESSION_TTL_S } = await import('../api-auth.js');
const { createSessionRoutes } = await import('../../api/session.js');

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'x'.repeat(44);
const prod: ApiAuthConfig = { password: 'correct horse', secret: SECRET, production: true };

describe('auth mode', () => {
  it('production without a password, or with a weak secret, is locked (fail closed)', () => {
    expect(authMode({ password: null, secret: SECRET, production: true }).mode).toBe('MISCONFIGURED');
    expect(authMode({ password: 'p', secret: 'dev-jwt-secret-change-in-production-min-32-chars', production: true }).mode).toBe('MISCONFIGURED');
    expect(authMode({ password: 'p', secret: 'short', production: true }).mode).toBe('MISCONFIGURED');
    expect(authMode(prod).mode).toBe('ENFORCED');
  });
  it('development without a password stays open; with one it is enforced', () => {
    expect(authMode({ password: null, secret: 'dev-x', production: false }).mode).toBe('OPEN_DEV');
    expect(authMode({ password: 'p', secret: 'dev-x', production: false }).mode).toBe('ENFORCED');
  });
});

describe('password and session token', () => {
  it('password: exact match only, bounded, non-strings refused', () => {
    expect(passwordMatches('correct horse', 'correct horse')).toBe(true);
    expect(passwordMatches('correct horse ', 'correct horse')).toBe(false);
    expect(passwordMatches('', 'correct horse')).toBe(false);
    expect(passwordMatches(undefined, 'correct horse')).toBe(false);
    expect(passwordMatches(['correct horse'], 'correct horse')).toBe(false);
    expect(passwordMatches('a'.repeat(300), 'a'.repeat(300))).toBe(false);
  });
  it('a session is valid for 7 days, and only for the current password', () => {
    const now = Date.UTC(2026, 9, 18, 6, 0);
    const s = issueSession(prod, now);
    expect(s.expiresAt).toBe(now + SESSION_TTL_S * 1000);
    expect(verifySession(s.token, prod, now + 1000)).toBe(true);
    expect(verifySession(s.token, prod, now + SESSION_TTL_S * 1000 + 1000)).toBe(false);
    expect(verifySession(s.token, { ...prod, password: 'rotated' }, now + 1000)).toBe(false);
    expect(verifySession(s.token, { ...prod, secret: 'y'.repeat(44) }, now + 1000)).toBe(false);
    expect(verifySession(null, prod)).toBe(false);
  });
  it('a token signed with the bare secret, another typ, or alg none is refused', () => {
    const bare = jwt.sign({ typ: 'terminal-session', sub: 'terminal' }, SECRET, { expiresIn: 60 });
    expect(verifySession(bare, prod)).toBe(false);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"typ":"terminal-session","sub":"terminal"}').toString('base64url')}.`;
    expect(verifySession(none, prod)).toBe(false);
    // The removed /api/auth/login signed {clientId, provider} with JWT_SECRET: never a terminal session.
    const legacy = jwt.sign({ clientId: 'C1', provider: 'angel-one' }, SECRET, { expiresIn: '24h' });
    expect(verifySession(legacy, prod)).toBe(false);
  });
  it('bearer header parsing', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('request gate', () => {
  const token = issueSession(prod).token;
  const gate = (method: string, p: string, authorization?: string, cfg: ApiAuthConfig = prod) => gateRequest({ method, path: p, authorization, cfg });
  it('probes and sign-in are public; everything else needs a session', () => {
    for (const [m, p] of [['GET', '/api/health'], ['GET', '/api/health/memory'], ['GET', '/api/health/ready'], ['GET', '/api/session'], ['POST', '/api/session']]) {
      expect(gate(m, p)).toEqual({ ok: true, authenticated: false });
    }
    for (const [m, p] of [['GET', '/api/paper-trades'], ['POST', '/api/health'], ['GET', '/api/auth/status'], ['POST', '/api/market-scanner/refresh'], ['GET', '/api/health/../paper-trades'], ['GET', '/api/healthz']]) {
      expect(gate(m, p)).toMatchObject({ ok: false, status: 401, code: 'AUTH_REQUIRED' });
    }
    expect(gate('GET', '/api/paper-trades', `Bearer ${token}`)).toEqual({ ok: true, authenticated: true });
    expect(gate('GET', '/api/paper-trades', 'Bearer nope')).toMatchObject({ ok: false, status: 401 });
  });
  it('matches the router: case-insensitive, trailing slash ignored; preflight passes', () => {
    expect(gate('GET', '/API/Health/')).toEqual({ ok: true, authenticated: false });
    expect(gate('GET', '/api/Paper-Trades/')).toMatchObject({ ok: false, status: 401 });
    expect(gate('OPTIONS', '/api/paper-trades')).toEqual({ ok: true, authenticated: false });
  });
  it('locked server: probes still answer, everything else 503; development without a password is open', () => {
    const locked = { password: null, secret: SECRET, production: true };
    expect(gate('GET', '/api/health', undefined, locked)).toEqual({ ok: true, authenticated: false });
    expect(gate('GET', '/api/paper-trades', `Bearer ${token}`, locked)).toMatchObject({ ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED' });
    expect(gate('GET', '/api/paper-trades', undefined, { password: null, secret: 'dev', production: false })).toEqual({ ok: true, authenticated: true });
  });
});

describe('Express wiring (real HTTP)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', requireSession(prod));
    app.use('/api/session', createSessionRoutes(prod));
    app.get('/api/health', (_req, res) => res.json({ success: true, data: { full: res.locals.authenticated === true } }));
    const trades = express.Router();
    trades.get('/', (_req, res) => res.json({ success: true, data: [] }));
    app.use('/api/paper-trades', trades);
    await new Promise<void>((r) => {
      server = app.listen(0, '127.0.0.1', () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sign in, then use the API; a wrong password and a missing token are refused', async () => {
    expect((await fetch(`${base}/api/paper-trades`)).status).toBe(401);
    const bad = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
    expect(ok.status).toBe(200);
    const { data } = (await ok.json()) as { data: { token: string; mode: string } };
    expect(data.mode).toBe('ENFORCED');
    const auth = { Authorization: `Bearer ${data.token}` };
    expect((await fetch(`${base}/api/paper-trades`, { headers: auth })).status).toBe(200);
    const status = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { data: { authenticated: boolean } };
    expect(status.data.authenticated).toBe(true);
    // The probe answers either way; only a session gets the full report.
    expect(((await (await fetch(`${base}/api/health`)).json()) as { data: { full: boolean } }).data.full).toBe(false);
    expect(((await (await fetch(`${base}/api/health`, { headers: auth })).json()) as { data: { full: boolean } }).data.full).toBe(true);
  });
});

describe('index.ts wiring', () => {
  const src = readFileSync(path.join(SERVER, 'src/index.ts'), 'utf8');
  it('the session gate is registered before every /api router and route', () => {
    const gateAt = src.indexOf("app.use('/api', requireSession(apiAuth));");
    expect(gateAt).toBeGreaterThan(0);
    const routes = [...src.matchAll(/app\.(use|get|post|put|delete)\('\/api\/[a-z]/g)].map((m) => m.index ?? 0);
    expect(routes.length).toBeGreaterThan(15);
    for (const at of routes) expect(at).toBeGreaterThan(gateAt);
  });
  it('the WebSocket bridge gets the same auth config', () => {
    expect(src).toMatch(/createMarketWebSocketServer\(server, subscriptionManager, apiAuth\)/);
  });
  it('the broker login/logout routes are gone', () => {
    const auth = readFileSync(path.join(SERVER, 'src/api/auth.ts'), 'utf8');
    expect(auth).not.toMatch(/router\.post\(/);
    expect(auth).not.toMatch(/provider\.(authenticate|logout)\(/);
  });
});
