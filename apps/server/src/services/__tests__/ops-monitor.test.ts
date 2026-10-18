// ============================================================
// OBS-1 (audit 2026-10-18): each seeded failure degrades health and alerts once; recovery sends one note.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), alerts: [] as string[], watched: [] as any[], computed: new Map<string, number>(), mismatches: 0 }));
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: async (k: string) => mem.kv.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && mem.kv.has(k)) return null;
      mem.kv.set(k, v);
      return 'OK';
    },
    del: async (k: string) => (mem.kv.delete(k) ? 1 : 0),
  },
  scanKeys: async (p: string) => [...mem.kv.keys()].filter((k) => k.startsWith(p.replace('*', ''))),
}));
vi.mock('../../lib/db.js', () => {
  const sql: any = () => Promise.resolve([{ n: 0 }]);
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../telegram.js', () => ({ notifyOperationalAlert: async (m: string) => (mem.alerts.push(m), true) }));
vi.mock('../market-bias.js', () => ({ lastBiasComputedAt: (ex: string, s: string, m: string) => mem.computed.get(`${ex}:${s}:${m}`) }));
vi.mock('../trade-setup-monitor.js', () => ({ watchedSetups: () => mem.watched }));
vi.mock('../record-reconciliation.js', () => ({ readReconciliationReport: async () => ({ mismatches: Array.from({ length: mem.mismatches }) }) }));

const O = await import('../ops-monitor.js');
type Inputs = import('../ops-monitor.js').OpsInputs;

const NOW = Date.UTC(2026, 9, 16, 5, 30); // Fri 16 Oct 11:00 IST: NSE, BSE and MCX all open
const base = (o: Partial<Inputs> = {}): Inputs => ({
  now: NOW,
  today: '2026-10-16',
  uptimeMs: 60 * 60_000,
  inSession: () => true,
  minutesSinceOpen: () => 105,
  slots: [{ exchange: 'NSE', underlying: 'TCS', mode: 'POSITIONAL', naked: true, expiry: '2026-10-27' }],
  watched: new Map([['NSE:TCS:POSITIONAL', '43210']]),
  feedConnected: true,
  feedUpstreamDown: false,
  feedStateOf: () => 'DATA_FRESH',
  expectedSymbols: [{ symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY' }],
  computedAt: () => NOW - 60_000,
  pastExpiryRows: 0,
  reconciliationMismatches: 0,
  ...o,
});
const checks = (i: Inputs) => O.evaluateOpsChecks(i).map((f) => f.key);

describe('evaluateOpsChecks (pure): one seeded failure each', () => {
  it('all well: nothing', () => expect(checks(base())).toEqual([]));
  it('an open trade in session that no subscription watches', () => {
    const f = O.evaluateOpsChecks(base({ watched: new Map() }));
    expect(f.map((x) => x.key)).toEqual(['FEED_COVERAGE']);
    expect(f[0].detail).toMatch(/NSE:TCS:POSITIONAL/);
  });
  it('the feed down in session with open trades (not also a gap per trade)', () => {
    expect(checks(base({ feedConnected: false, feedStateOf: () => 'DATA_GAP' }))).toEqual(['FEED_DOWN']);
    expect(checks(base({ feedUpstreamDown: true }))).toEqual(['FEED_DOWN']);
  });
  it('an open trade whose contract has been silent for 5+ minutes', () => {
    expect(checks(base({ feedStateOf: () => 'DATA_GAP' }))).toEqual(['FEED_GAP:NSE:TCS:POSITIONAL']);
    expect(checks(base({ feedStateOf: () => 'DATA_STALE' }))).toEqual([]);
  });
  it('an expected symbol the engine stopped computing — only after the session and process warm-ups', () => {
    expect(checks(base({ computedAt: () => NOW - 16 * 60_000 }))).toEqual(['ENGINE_STALE:NSE:NIFTY']);
    expect(checks(base({ computedAt: () => undefined }))).toEqual(['ENGINE_STALE:NSE:NIFTY']);
    expect(checks(base({ computedAt: () => undefined, minutesSinceOpen: () => 10 }))).toEqual([]);
    expect(checks(base({ computedAt: () => undefined, uptimeMs: 5 * 60_000 }))).toEqual([]);
    expect(checks(base({ computedAt: () => undefined, inSession: (ex) => ex !== 'NSE' }))).toEqual([]);
  });
  it('an open trade past its option expiry (slot or database row)', () => {
    expect(checks(base({ slots: [{ exchange: 'MCX', underlying: 'CRUDEOIL', mode: 'POSITIONAL', naked: true, expiry: '2026-10-15' }] }))).toEqual(['OPEN_PAST_EXPIRY']);
    expect(checks(base({ pastExpiryRows: 1 }))).toEqual(['OPEN_PAST_EXPIRY']);
  });
  it('a record mismatch is a WARN', () => {
    const f = O.evaluateOpsChecks(base({ reconciliationMismatches: 2 }));
    expect(f).toEqual([expect.objectContaining({ key: 'RECORD_MISMATCH', severity: 'WARN' })]);
  });
  it('outside the session an open positional trade needs no ticks', () => {
    expect(checks(base({ inSession: () => false, watched: new Map(), feedConnected: false }))).toEqual([]);
  });
});

describe('stepIncidents (pure): grace periods', () => {
  it('a finding becomes an incident only after its grace period, and resolves when it is gone', () => {
    const st = new Map();
    const f = O.evaluateOpsChecks(base({ watched: new Map() }));
    expect(O.stepIncidents(st, f, NOW).opened).toEqual([]);
    expect(O.stepIncidents(st, f, NOW + 60_000).opened).toEqual([]);
    const t = O.stepIncidents(st, f, NOW + 120_000);
    expect(t.opened.map((i) => [i.key, i.since])).toEqual([['FEED_COVERAGE', NOW]]);
    expect(O.stepIncidents(st, f, NOW + 180_000).opened).toEqual([]);
    expect(O.stepIncidents(st, [], NOW + 240_000).resolved.map((i) => i.key)).toEqual(['FEED_COVERAGE']);
    expect(st.size).toBe(0);
  });
  it('a finding that clears inside its grace period never opens an incident', () => {
    const st = new Map();
    O.stepIncidents(st, O.evaluateOpsChecks(base({ watched: new Map() })), NOW);
    expect(O.stepIncidents(st, [], NOW + 60_000)).toEqual({ opened: [], resolved: [] });
  });
});

describe('runOpsChecks (IO shell): alerts once per incident, then a resolved note', () => {
  beforeEach(() => {
    mem.kv.clear();
    mem.alerts.length = 0;
    mem.watched = [];
    mem.computed.clear();
    mem.mismatches = 0;
  });
  const subs = (connected = true) => ({ getStatus: () => ({ connected, feed: { upstreamDown: false } }), feedStateOfToken: () => 'DATA_FRESH' }) as never;

  it('an unwatched open trade: DEGRADED in the status, one alert, one resolved note', async () => {
    mem.kv.set('trade_setup:NSE:TCS:POSITIONAL', JSON.stringify({ available: true, expiry: '2026-10-27' }));
    for (const s of ['NIFTY', 'BANKNIFTY', 'FINNIFTY']) mem.computed.set(`NSE:${s}:INTRADAY`, NOW);
    for (const s of ['SENSEX:BSE', 'CRUDEOIL:MCX', 'GOLD:MCX']) mem.computed.set(`${s.split(':')[1]}:${s.split(':')[0]}:INTRADAY`, NOW);
    await O.runOpsChecks(subs(), NOW);
    expect(O.opsStatus().incidents).toEqual([]);
    await O.runOpsChecks(subs(), NOW + 125_000);
    expect(O.opsStatus().incidents.map((i) => i.key)).toEqual(['FEED_COVERAGE']);
    expect(mem.alerts).toHaveLength(1);
    expect(mem.alerts[0]).toMatch(/^⚠️ 1 open trade\(s\) in session have no live tick subscription/);
    await O.runOpsChecks(subs(), NOW + 185_000);
    expect(mem.alerts).toHaveLength(1);
    mem.watched = [{ exchange: 'NSE', underlying: 'TCS', mode: 'POSITIONAL', token: '43210', stopLoss: 1, target: 2 }];
    await O.runOpsChecks(subs(), NOW + 245_000);
    expect(O.opsStatus().incidents).toEqual([]);
    expect(mem.alerts).toHaveLength(2);
    expect(mem.alerts[1]).toMatch(/^✅ Resolved after 4 min: /);
  });

  it('a WARN (record mismatch) reports but never pages', async () => {
    for (const s of ['NIFTY', 'BANKNIFTY', 'FINNIFTY']) mem.computed.set(`NSE:${s}:INTRADAY`, NOW);
    for (const s of ['SENSEX:BSE', 'CRUDEOIL:MCX', 'GOLD:MCX']) mem.computed.set(`${s.split(':')[1]}:${s.split(':')[0]}:INTRADAY`, NOW);
    mem.mismatches = 1;
    await O.runOpsChecks(subs(), NOW + 10 * 60_000);
    expect(O.opsStatus().incidents.map((i) => [i.key, i.severity])).toEqual([['RECORD_MISMATCH', 'WARN']]);
    expect(mem.alerts).toEqual([]);
    mem.mismatches = 0;
    await O.runOpsChecks(subs(), NOW + 11 * 60_000);
  });
});

describe('wiring', () => {
  const index = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.ts'), 'utf8');
  it('a DEGRADES incident degrades /api/health; the report carries the incidents', () => {
    expect(index).toMatch(/const opsDegraded = ops\.incidents\.some\(\(i\) => i\.severity === 'DEGRADES'\);/);
    expect(index).toMatch(/supervisor\.degradedCritical\.length === 0 && !opsDegraded/);
    expect(index).toMatch(/memory: memoryStatus\(\),\s+ops,/);
    expect(index).toMatch(/timerService\('opsMonitor', \(\) => startOpsMonitor\(subscriptionManager\), \{ ready: \(\) => recoveryReady \}\)/);
  });
});
