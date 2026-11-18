// 18 Nov (owner): a read-only API key for Claude — GET only, never a write, never /api/session or /api/auth.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ApiAuthConfig } from '../api-auth.js';

vi.mock('../logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
const db = vi.hoisted(() => ({ sql: Object.assign(vi.fn(async () => []), { begin: vi.fn() }) }));
vi.mock('../db.js', () => db);

const { gateRequest, requireSession, issueSession } = await import('../api-auth.js');
const { hashReadonlyKey, isActiveReadonlyKey, newReadonlyKey, readonlyKeyVerdict, setActiveReadonlyHashes, looksLikeReadonlyKey } = await import('../readonly-key.js');
const { createSessionRoutes } = await import('../../api/session.js');

const prod: ApiAuthConfig = { password: 'correct horse', secret: 'x'.repeat(44), production: true };
afterEach(() => setActiveReadonlyHashes([]));

describe('read-only key', () => {
  it('keys are random, prefixed and long; only hashes are compared', () => {
    const a = newReadonlyKey(), b = newReadonlyKey();
    expect(a).not.toBe(b); expect(looksLikeReadonlyKey(a)).toBe(true); expect(a.length).toBeGreaterThan(45);
    expect(isActiveReadonlyKey(a)).toBe(false);
    setActiveReadonlyHashes([hashReadonlyKey(a)]);
    expect(isActiveReadonlyKey(a)).toBe(true);
    expect(isActiveReadonlyKey(b)).toBe(false);
    expect(isActiveReadonlyKey(`${a}x`)).toBe(false);
    expect(isActiveReadonlyKey('short')).toBe(false);
  });
  it('verdict: GET / HEAD allowed, writes and the sign-in / broker routes denied', () => {
    expect(readonlyKeyVerdict('GET', '/api/paper-trades')).toBe('ALLOW');
    expect(readonlyKeyVerdict('HEAD', '/api/fresh-start/status')).toBe('ALLOW');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(readonlyKeyVerdict(m, '/api/paper-trades')).toBe('DENY_WRITE');
    expect(readonlyKeyVerdict('GET', '/api/session/readonly-key')).toBe('DENY_PATH');
    expect(readonlyKeyVerdict('GET', '/api/auth/status')).toBe('DENY_PATH');
    expect(readonlyKeyVerdict('GET', '/api/sessionx')).toBe('ALLOW');
  });
  it('the gate: a valid key opens GET, gets 403 on writes, an unknown key stays 401', () => {
    const key = newReadonlyKey(), auth = `Bearer ${key}`, valid = (t: string) => t === key;
    expect(gateRequest({ method: 'GET', path: '/api/paper-trades', authorization: auth, cfg: prod, readonlyKey: valid })).toEqual({ ok: true, authenticated: true, readOnly: true });
    expect(gateRequest({ method: 'POST', path: '/api/market-scanner/refresh', authorization: auth, cfg: prod, readonlyKey: valid })).toMatchObject({ ok: false, status: 403, code: 'READ_ONLY_KEY' });
    expect(gateRequest({ method: 'GET', path: '/api/session/readonly-key', authorization: auth, cfg: prod, readonlyKey: valid })).toMatchObject({ ok: false, status: 403 });
    expect(gateRequest({ method: 'GET', path: '/api/paper-trades', authorization: auth, cfg: prod, readonlyKey: () => false })).toMatchObject({ ok: false, status: 401 });
    expect(gateRequest({ method: 'GET', path: '/api/paper-trades', authorization: auth, cfg: prod })).toMatchObject({ ok: false, status: 401 });
    // A session still works as before and is not read-only.
    const s = issueSession(prod);
    expect(gateRequest({ method: 'POST', path: '/api/x', authorization: `Bearer ${s.token}`, cfg: prod, readonlyKey: valid })).toEqual({ ok: true, authenticated: true });
  });
  it('over HTTP: GET with the key works, a write is 403, managing the key needs the owner session, revoke stops it', async () => {
    const app = express(); app.use(express.json());
    app.use('/api', requireSession(prod));
    app.use('/api/session', createSessionRoutes(prod));
    app.get('/api/paper-trades', (_req, res) => res.json({ success: true, data: [] }));
    app.post('/api/market-scanner/refresh', (_req, res) => res.json({ success: true }));
    const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const key = newReadonlyKey(); setActiveReadonlyHashes([hashReadonlyKey(key)]);
      const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      expect((await fetch(`${base}/api/paper-trades`, { headers: h })).status).toBe(200);
      expect((await fetch(`${base}/api/market-scanner/refresh`, { method: 'POST', headers: h, body: '{}' })).status).toBe(403);
      expect((await fetch(`${base}/api/session/readonly-key`, { method: 'POST', headers: h, body: '{}' })).status).toBe(403);
      expect((await fetch(`${base}/api/session/readonly-key`, { headers: h })).status).toBe(403);
      setActiveReadonlyHashes([]);
      expect((await fetch(`${base}/api/paper-trades`, { headers: h })).status).toBe(401);
      // The owner's session reaches the key routes (the store is mocked).
      db.sql.mockResolvedValueOnce([] as never);
      const s = issueSession(prod);
      const r = await fetch(`${base}/api/session/readonly-key`, { headers: { authorization: `Bearer ${s.token}` } });
      expect(r.status).toBe(200); expect(((await r.json()) as any).data).toEqual({ active: false, createdAt: null, lastUsedAt: null });
    } finally { server.close(); }
  });
});
