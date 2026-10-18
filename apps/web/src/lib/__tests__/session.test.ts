import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { api } from '@/lib/api';
import { SESSION_REQUIRED_EVENT, clearSession, resetSessionCacheForTests, saveSession, sessionToken } from '@/lib/session';
import { marketSocketUrl } from '@/lib/ws';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; headers: Record<string, string> }> = [];
let respond: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: { success: true, data: {} } });

beforeEach(() => {
  window.localStorage.clear();
  resetSessionCacheForTests();
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = respond(url);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearSession();
});

describe('terminal session (SEC-1)', () => {
  it('signing in stores the token; every call then sends it as a bearer header', async () => {
    respond = (url) =>
      url.endsWith('/api/session') ? { status: 200, body: { success: true, data: { mode: 'ENFORCED', token: 'jwt-1', expiresAt: Date.now() + 60_000 } } } : { status: 200, body: { success: true, data: [] } };
    await api.signIn('pw');
    expect(sessionToken()).toBe('jwt-1');
    await api.get('/api/paper-trades');
    expect(calls.at(-1)?.headers.Authorization).toBe('Bearer jwt-1');
    // A reload reads it back from storage.
    resetSessionCacheForTests();
    expect(sessionToken()).toBe('jwt-1');
  });

  it('an expired token is dropped, not sent', async () => {
    saveSession({ token: 'old', expiresAt: Date.now() - 1 });
    expect(sessionToken()).toBeNull();
    await api.get('/api/health');
    expect(calls.at(-1)?.headers.Authorization).toBeUndefined();
  });

  it('a 401 AUTH_REQUIRED clears the token and tells the gate; a wrong password does not', async () => {
    saveSession({ token: 'jwt-2', expiresAt: Date.now() + 60_000 });
    const seen: string[] = [];
    const onRequired = (e: Event) => seen.push((e as CustomEvent<{ code: string }>).detail.code);
    window.addEventListener(SESSION_REQUIRED_EVENT, onRequired);
    respond = () => ({ status: 401, body: { success: false, error: { code: 'WRONG_PASSWORD', message: 'That password is not right.' } } });
    await expect(api.signIn('nope')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    expect(seen).toEqual([]);
    expect(sessionToken()).toBe('jwt-2');
    respond = () => ({ status: 401, body: { success: false, error: { code: 'AUTH_REQUIRED', message: 'Sign in to use the terminal.' } } });
    await expect(api.get('/api/paper-trades')).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['AUTH_REQUIRED']);
    expect(sessionToken()).toBeNull();
    window.removeEventListener(SESSION_REQUIRED_EVENT, onRequired);
  });

  it('the feed URL carries the session token, read at connect time', () => {
    expect(marketSocketUrl(null)).toMatch(/\/ws$/);
    expect(marketSocketUrl('a b')).toMatch(/\/ws\?token=a%20b$/);
    saveSession({ token: 'jwt-3', expiresAt: Date.now() + 60_000 });
    expect(marketSocketUrl()).toMatch(/\?token=jwt-3$/);
  });
});

vi.mock('@/stores', () => ({ useSystemHealthStore: () => () => undefined }));
