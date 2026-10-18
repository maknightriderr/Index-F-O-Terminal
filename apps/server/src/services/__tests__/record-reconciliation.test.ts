// ============================================================
// REC-1 (audit 2026-10-18): every closed plan is checked against its trade row once a day; a disagreement alerts once.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), alerts: [] as string[], rows: [] as any[] }));
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
}));
vi.mock('../../lib/db.js', () => {
  const sql: any = () => Promise.resolve(mem.rows);
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../telegram.js', () => ({ notifyOperationalAlert: async (m: string) => (mem.alerts.push(m), true) }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));

const R = await import('../record-reconciliation.js');

const NOW = Date.parse('2026-10-19T21:00:00Z');
const plan = (o: Partial<import('../record-reconciliation.js').PlanTradeRow>) => ({
  signalId: 'aaaaaaaa-0000-0000-0000-000000000000',
  firstClose: 'WIN (TARGET) at 328.4',
  firstAt: NOW - 3_600_000,
  closedEvents: 1,
  outcome: 'WIN',
  closeReason: 'TARGET',
  exitPrice: 328.4,
  voided: false,
  ...o,
});

describe('classifyPlanTrade (pure)', () => {
  it('agrees when the row holds the plan’s first close', () => {
    expect(R.classifyPlanTrade(plan({}), NOW)).toBe('AGREES');
    expect(R.classifyPlanTrade(plan({ firstClose: 'EXPIRED (SESSION_ENDED) at 12.5', outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 12.5 }), NOW)).toBe('AGREES');
    // A plan close without a price compares outcome and reason only.
    expect(R.classifyPlanTrade(plan({ firstClose: 'EXPIRED (BIAS_REVERSED)', outcome: 'EXPIRED', closeReason: 'BIAS_REVERSED', exitPrice: 99 }), NOW)).toBe('AGREES');
  });
  it('the REC-1 shape: first close a WIN at 328.4, the row overwritten EXPIRED at 261.3', () => {
    expect(R.classifyPlanTrade(plan({ closedEvents: 2, outcome: 'EXPIRED', closeReason: 'BIAS_REVERSED', exitPrice: 261.3 }), NOW)).toBe('DIFFERS');
    expect(R.classifyPlanTrade(plan({ exitPrice: 330 }), NOW)).toBe('DIFFERS');
    expect(R.classifyPlanTrade(plan({ exitPrice: null }), NOW)).toBe('DIFFERS');
  });
  it('voided rows are listed apart; an open row is judged only once its close has had time to settle', () => {
    expect(R.classifyPlanTrade(plan({ voided: true, outcome: 'EXPIRED', closeReason: 'BIAS_REVERSED', exitPrice: 261.3 }), NOW)).toBe('VOIDED');
    expect(R.classifyPlanTrade(plan({ outcome: null, closeReason: null, exitPrice: null }), NOW)).toBe('TRADE_OPEN');
    expect(R.classifyPlanTrade(plan({ outcome: null, closeReason: null, exitPrice: null, firstAt: NOW - 60_000 }), NOW)).toBeNull();
    expect(R.classifyPlanTrade(plan({ firstClose: 'something else' }), NOW)).toBe('UNPARSED');
  });
});

describe('the nightly run', () => {
  beforeEach(() => {
    mem.kv.clear();
    mem.alerts.length = 0;
    mem.rows = [];
  });
  const dbRow = (id: string, first: string, outcome: string | null, reason: string | null, exit: string | null, voided = false, n = 1) => ({
    signal_id: id, first_close: first, first_at: new Date(NOW - 7_200_000), closed_events: n, outcome, close_reason: reason, exit_price: exit, voided,
  });

  it('a seeded mismatch alerts once; the report is kept; voided rows never alert', async () => {
    mem.rows = [
      dbRow('11111111-a', 'WIN (TARGET) at 182.68', 'WIN', 'TARGET', '182.68', false, 2),
      dbRow('22222222-b', 'WIN (TARGET) at 328.4', 'EXPIRED', 'BIAS_REVERSED', '261.3'),
      dbRow('33333333-c', 'EXPIRED (BIAS_REVERSED) at 257.1', 'EXPIRED', 'TRACKING_LOST', null, true),
    ];
    const r = await R.runPlanTradeReconciliation(NOW);
    expect(r).toMatchObject({ plans: 3, agrees: 1, multiClose: 1, unparsed: 0 });
    expect(r?.mismatches).toEqual([{ signalId: '22222222-b', cls: 'DIFFERS', plan: 'WIN (TARGET) at 328.4', trade: 'EXPIRED (BIAS_REVERSED) at 261.3' }]);
    expect(r?.voided.map((v) => v.signalId)).toEqual(['33333333-c']);
    expect(mem.alerts).toHaveLength(1);
    expect(mem.alerts[0]).toMatch(/1 trade row\(s\) disagree/);
    expect(mem.alerts[0]).toMatch(/22222222: plan says WIN \(TARGET\) at 328\.4, the trade row says EXPIRED \(BIAS_REVERSED\) at 261\.3/);
    expect(mem.alerts[0]).toMatch(/Nothing was changed/);
    expect(await R.readReconciliationReport()).toMatchObject({ plans: 3, agrees: 1 });
    // The same disagreement the next night: reported, not alerted again.
    await R.runPlanTradeReconciliation(NOW + 86_400_000);
    expect(mem.alerts).toHaveLength(1);
  });

  it('everything agrees: no alert', async () => {
    mem.rows = [dbRow('44444444-d', 'LOSS (STOP_LOSS) at 184', 'LOSS', 'STOP_LOSS', '184')];
    expect((await R.runPlanTradeReconciliation(NOW))?.mismatches).toEqual([]);
    expect(mem.alerts).toEqual([]);
  });

  it('runs only between 01:00 and 07:00 IST', () => {
    expect(R.reconcileRunDate(Date.parse('2026-10-19T19:30:00Z'))).toBe('2026-10-20'); // 01:00 IST
    expect(R.reconcileRunDate(Date.parse('2026-10-20T01:29:00Z'))).toBe('2026-10-20'); // 06:59 IST
    expect(R.reconcileRunDate(Date.parse('2026-10-20T01:30:00Z'))).toBeNull(); // 07:00 IST
    expect(R.reconcileRunDate(Date.parse('2026-10-19T17:00:00Z'))).toBeNull(); // 22:30 IST, MCX trading
  });
});
