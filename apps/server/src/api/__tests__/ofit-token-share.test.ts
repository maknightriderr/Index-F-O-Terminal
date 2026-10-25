import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createOfitTokenShareRoutes, ofitShareSecretFrom, OFIT_SHARE_PATH, type OfitShareDeps } from '../ofit-token-share.js';

const SECRET = 's'.repeat(40);
const held = { clientId: '1100000000', accessToken: 'TOKEN-VALUE' };
const liveDeps: OfitShareDeps = { session: () => held, status: () => ({ expiresAt: 1_800_000_000_000 }) as any };

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function call(secret: string | null, deps: OfitShareDeps, init: RequestInit = {}) {
  const app = express();
  app.use(OFIT_SHARE_PATH, createOfitTokenShareRoutes(secret, deps));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}${OFIT_SHARE_PATH}`;
  const res = await fetch(url, init);
  return { res, body: (await res.json()) as any };
}
const bearer = (s: string) => ({ headers: { Authorization: `Bearer ${s}` } });

describe('ofitShareSecretFrom', () => {
  it('is off when unset, blank, or shorter than 32 characters', () => {
    expect(ofitShareSecretFrom({})).toBeNull();
    expect(ofitShareSecretFrom({ OFIT_SHARED_SECRET: '   ' })).toBeNull();
    expect(ofitShareSecretFrom({ OFIT_SHARED_SECRET: 'short' })).toBeNull();
    expect(ofitShareSecretFrom({ OFIT_SHARED_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('GET /internal/ofit/dhan-token', () => {
  it('serves the held token to the right secret, uncached', async () => {
    const { res, body } = await call(SECRET, liveDeps, bearer(SECRET));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.data).toEqual({ clientId: '1100000000', accessToken: 'TOKEN-VALUE', expiresAt: 1_800_000_000_000 });
  });

  it('refuses a wrong or missing secret without revealing anything', async () => {
    for (const init of [bearer('x'.repeat(40)), {}]) {
      const { res, body } = await call(SECRET, liveDeps, init);
      expect(res.status).toBe(401);
      expect(JSON.stringify(body)).not.toContain('TOKEN-VALUE');
    }
  });

  it('is invisible (404) when the secret is not configured, even for a guess', async () => {
    const { res } = await call(null, liveDeps, bearer(SECRET));
    expect(res.status).toBe(404);
  });

  it('answers 503 when the terminal holds no token, and never logs in itself', async () => {
    let calls = 0;
    const deps: OfitShareDeps = { session: () => (calls++, null), status: liveDeps.status };
    const { res, body } = await call(SECRET, deps, bearer(SECRET));
    expect(res.status).toBe(503);
    expect(body.error.code).toBe('DHAN_SESSION_UNAVAILABLE');
    expect(calls).toBe(1);
  });

  it('serves GET only', async () => {
    const { res } = await call(SECRET, liveDeps, { method: 'POST', ...bearer(SECRET) });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});
