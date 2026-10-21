import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), post: vi.fn(), get: vi.fn() }));
vi.mock('../../lib/redis.js', () => ({
  redis: { get: async (k: string) => mem.kv.get(k) ?? null, set: async (k: string, v: string) => void mem.kv.set(k, v) },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('axios', () => ({ default: { post: mem.post, get: mem.get } }));

const S = await import('../dhan-session.js');

const NOW = Date.UTC(2026, 9, 21, 10, 0);
const jwt = (expMs: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;
const env = (o: Partial<Record<string, string>>) => S.dhanEnv({ DHAN_CLIENT_ID: '1100000000', ...o } as never);

describe('Dhan session: kept alive without a daily paste', () => {
  beforeEach(() => {
    mem.kv.clear();
    mem.post.mockReset();
    mem.get.mockReset();
    S.resetDhanSession();
  });

  it('reads a JWT expiry; a token without one is null', () => {
    expect(S.jwtExpiry(jwt(NOW))).toBe(Math.floor(NOW / 1000) * 1000);
    expect(S.jwtExpiry('not-a-jwt')).toBeNull();
  });

  it('the longest-lasting live token wins; an expired one never', () => {
    const a = { token: 'a', expiresAt: NOW + 3600_000, source: 'ENV' as const };
    const b = { token: 'b', expiresAt: NOW + 20 * 3600_000, source: 'RENEWED' as const };
    expect(S.bestToken([a, b], NOW)?.token).toBe('b');
    expect(S.bestToken([{ ...b, expiresAt: NOW - 1 }, a], NOW)?.token).toBe('a');
    expect(S.bestToken([{ ...a, expiresAt: NOW - 1 }], NOW)).toBeNull();
  });

  it('a valid env token with hours left: used as is, nothing called', async () => {
    const tok = jwt(NOW + 10 * 3600_000);
    await S.ensureDhanSession(NOW, env({ DHAN_ACCESS_TOKEN: tok }));
    expect(S.dhanSession()).toEqual({ clientId: '1100000000', accessToken: tok });
    expect(mem.get).not.toHaveBeenCalled();
    expect(mem.post).not.toHaveBeenCalled();
  });

  it('RENEW: under 2 hours left → renewed, and the renewed token is kept for a restart', async () => {
    const renewed = jwt(NOW + 24 * 3600_000);
    mem.get.mockResolvedValue({ data: { accessToken: renewed } });
    await S.ensureDhanSession(NOW, env({ DHAN_ACCESS_TOKEN: jwt(NOW + 3600_000) }));
    expect(S.dhanSession()?.accessToken).toBe(renewed);
    expect(mem.get.mock.calls[0][0]).toBe(S.DHAN_RENEW_TOKEN_URL);
    S.resetDhanSession();
    await S.ensureDhanSession(NOW + 60_000, env({ DHAN_ACCESS_TOKEN: jwt(NOW + 3600_000) }));
    expect(S.dhanSession()?.accessToken).toBe(renewed);
    expect(S.dhanSessionStatus().source).toBe('RENEWED');
  });

  it('RENEW: an expired token cannot be renewed — no session, and the status says what to do', async () => {
    await S.ensureDhanSession(NOW, env({ DHAN_ACCESS_TOKEN: jwt(NOW - 60_000) }));
    expect(S.dhanSession()).toBeNull();
    expect(mem.get).not.toHaveBeenCalled();
    expect(S.dhanSessionStatus().lastError).toMatch(/DHAN_PIN and DHAN_TOTP_SECRET/);
  });

  it('TOTP: an expired token is replaced by a login; a rejected token too', async () => {
    const fresh = jwt(NOW + 24 * 3600_000);
    mem.post.mockResolvedValue({ data: { accessToken: fresh, expiryTime: '2026-10-22T15:30:00.000' } });
    const e = env({ DHAN_ACCESS_TOKEN: jwt(NOW - 60_000), DHAN_PIN: '123456', DHAN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' });
    await S.ensureDhanSession(NOW, e);
    expect(S.dhanSession()?.accessToken).toBe(fresh);
    const [url, body, opts] = mem.post.mock.calls[0];
    expect([url, body, opts.params.dhanClientId, opts.params.pin]).toEqual([S.DHAN_GENERATE_TOKEN_URL, null, '1100000000', '123456']);
    expect(opts.params.totp).toMatch(/^\d{6}$/);

    const second = jwt(NOW + 25 * 3600_000);
    mem.post.mockResolvedValue({ data: { accessToken: second } });
    S.markDhanTokenRejected(fresh);
    expect(S.dhanSession()).toBeNull();
    await S.ensureDhanSession(NOW + 60_000, e);
    expect(S.dhanSession()?.accessToken).toBe(second);
  });

  it('a failed login waits 10 minutes before the next attempt', async () => {
    mem.post.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 400 } }));
    const e = env({ DHAN_PIN: '123456', DHAN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' });
    await S.ensureDhanSession(NOW, e);
    await S.ensureDhanSession(NOW + 5 * 60_000, e);
    expect(mem.post).toHaveBeenCalledTimes(1);
    await S.ensureDhanSession(NOW + 11 * 60_000, e);
    expect(mem.post).toHaveBeenCalledTimes(2);
    expect(S.dhanSession()).toBeNull();
  });
});
