import { describe, it, expect, beforeEach } from 'vitest';
import { brokerCallStats, currentCaller, endpointOf, recordBrokerCall, resetBrokerCallStats, runAsCaller } from '../broker-call-stats.js';
import { runInteractive } from '../request-priority.js';
import { ServiceSupervisor } from '../service-supervisor.js';

describe('broker call stats (measurement only)', () => {
  beforeEach(() => resetBrokerCallStats());

  it('endpoint families', () => {
    expect(endpointOf('/rest/secure/angelbroking/market/v1/quote/')).toBe('quote');
    expect(endpointOf('/rest/secure/angelbroking/historical/v1/getCandleData')).toBe('historical');
    expect(endpointOf('/rest/secure/angelbroking/marketData/v1/optionGreek')).toBe('greeks');
    expect(endpointOf('/v2/optionchain')).toBe('optionChain');
    expect(endpointOf(undefined)).toBe('other');
  });

  it('the caller follows the async context: a service, a person, else other', async () => {
    expect(currentCaller()).toBe('other');
    expect(await runAsCaller('marketScanner', async () => { await Promise.resolve(); return currentCaller(); })).toBe('marketScanner');
    expect(runInteractive(() => currentCaller())).toBe('terminal');
  });

  it('counts the last hour by provider, endpoint and caller, busiest first', () => {
    const t = Date.UTC(2026, 9, 21, 9, 0);
    recordBrokerCall('ANGEL', 'quote', 'fnoScan', 'OK', t);
    recordBrokerCall('ANGEL', 'quote', 'fnoScan', 'RATE_LIMITED', t);
    recordBrokerCall('ANGEL', 'quote', 'fnoScan', 'RATE_LIMITED', t + 60_000);
    recordBrokerCall('ANGEL', 'historical', 'marketScanner', 'FAILED', t);
    recordBrokerCall('ANGEL', 'quote', 'old', 'OK', t - 61 * 60_000);
    expect(brokerCallStats(t + 60_000)).toEqual({
      windowMinutes: 60,
      rows: [
        { provider: 'ANGEL', endpoint: 'quote', caller: 'fnoScan', ok: 1, rateLimited: 2, failed: 0 },
        { provider: 'ANGEL', endpoint: 'historical', caller: 'marketScanner', ok: 0, rateLimited: 0, failed: 1 },
      ],
    });
  });

  it('a supervised service timer runs attributed to its name', async () => {
    let seen: string | null = null;
    const sup = new ServiceSupervisor();
    sup.register({ name: 'probeService', critical: false, startupTimeoutMs: 1_000, heartbeatIntervalMs: 0, kind: 'TIMER', start: () => { setTimeout(() => (seen = currentCaller()), 1); } });
    await sup.startAll();
    await new Promise((r) => setTimeout(r, 30));
    sup.stopAll();
    expect(seen).toBe('probeService');
  });
});
