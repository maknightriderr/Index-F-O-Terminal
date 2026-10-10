import { describe, expect, it } from 'vitest';
import { PLANNED_SERVICES, buildHealthModel, type HealthResponse } from '../health-model';

const now = Date.UTC(2026, 9, 13, 5, 30, 0); // 11:00 IST, a Tuesday
const browserSocket = { connected: true, lastTickAt: now };

const healthy = (over: Partial<HealthResponse> = {}): HealthResponse => ({
  status: 'ok',
  uptime: 1000,
  timestamp: now,
  services: {
    provider: { name: 'Angel One', authenticated: true },
    redis: { status: 'HEALTHY', latencyMs: 2 },
    database: { status: 'HEALTHY', latencyMs: 4 },
    websocket: { status: 'HEALTHY', connected: true, subscriptionCount: 5, lastTickAt: now - 3000 },
  },
  sessions: [{ exchange: 'NSE', open: true }],
  orderFlow: { status: 'DATA_PLAN_INACTIVE' },
  ...over,
});

const row = (m: ReturnType<typeof buildHealthModel>, id: string) => m.rows.find((r) => r.id === id)!;

describe('buildHealthModel', () => {
  it('an unreachable API is one finding, not every service down', () => {
    const m = buildHealthModel({ data: null, apiError: 'timeout', now, browserSocket: { connected: false } });
    expect(m.overall).toBe('API_UNREACHABLE');
    expect(m.apiReachable).toBe(false);
    expect(row(m, 'api').status).toBe('API_UNREACHABLE');
    for (const id of ['redis', 'database', 'provider', 'order-flow']) expect(row(m, id).status).toBe('UNAVAILABLE');
    expect(m.rows.some((r) => r.status === 'DISCONNECTED' && r.id !== 'browser-socket')).toBe(false);
  });

  it('never marks planned services as down', () => {
    const m = buildHealthModel({ data: healthy(), apiError: null, now, browserSocket });
    expect(m.planned).toHaveLength(PLANNED_SERVICES.length);
    for (const p of m.planned) expect(p.status).toBe('NOT_IMPLEMENTED');
  });

  it('is healthy with fresh ticks in session', () => {
    const m = buildHealthModel({ data: healthy(), apiError: null, now, browserSocket });
    expect(row(m, 'tick-feed').status).toBe('HEALTHY');
    expect(m.overall).toBe('HEALTHY');
  });

  it('a connected socket with an old tick in session is STALE, never healthy', () => {
    const d = healthy();
    d.services!.websocket!.lastTickAt = now - 20 * 60_000;
    const m = buildHealthModel({ data: d, apiError: null, now, browserSocket });
    expect(row(m, 'tick-feed').status).toBe('STALE');
    expect(m.overall).toBe('STALE');
  });

  it('a connected socket that never ticked is not healthy', () => {
    const d = healthy();
    delete d.services!.websocket!.lastTickAt;
    const m = buildHealthModel({ data: d, apiError: null, now, browserSocket });
    expect(row(m, 'tick-feed').status).not.toBe('HEALTHY');
  });

  it('a closed market is not a feed failure', () => {
    const d = healthy({ sessions: [{ exchange: 'NSE', open: false }] });
    d.services!.websocket!.lastTickAt = now - 5 * 3_600_000;
    const m = buildHealthModel({ data: d, apiError: null, now, browserSocket });
    expect(row(m, 'tick-feed').status).toBe('MARKET_CLOSED');
    expect(m.overall).toBe('HEALTHY');
    expect(m.headline).toMatch(/Markets are closed/);
  });

  it('an inactive Dhan plan is UNAVAILABLE, and an optional feed does not degrade the overall status', () => {
    const m = buildHealthModel({ data: healthy(), apiError: null, now, browserSocket });
    expect(row(m, 'order-flow').status).toBe('UNAVAILABLE');
    expect(m.overall).toBe('HEALTHY');
  });

  it('a failed core service is reported with its error', () => {
    const d = healthy();
    d.services!.redis = { status: 'DOWN', error: 'ECONNREFUSED' };
    const m = buildHealthModel({ data: d, apiError: null, now, browserSocket });
    expect(row(m, 'redis').status).toBe('DISCONNECTED');
    expect(row(m, 'redis').detail).toMatch(/ECONNREFUSED/);
    expect(m.overall).toBe('DISCONNECTED');
  });

  it('a non-critical stopped supervised service does not change the overall status', () => {
    const d = healthy({ supervisor: { services: [{ name: 'report-job', critical: false, state: 'STOPPED', lastSuccessAt: null, lastFailureAt: null, lastError: null, note: null }] } });
    const m = buildHealthModel({ data: d, apiError: null, now, browserSocket });
    expect(m.overall).toBe('HEALTHY');
  });
});
