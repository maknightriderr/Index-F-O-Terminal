// ============================================================
// LIFE-1 (audit 2026-10-18): the lost-trade sweep covers every mode.
// e41a6899 (CRUDEOIL PE 8950, POSITIONAL, opened 8 Oct, expiry 15 Oct) stayed open past its expiry: only intraday
// rows were swept, and the boot check only looked at the newest open row of each slot.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: async (k: string) => mem.kv.get(k) ?? null,
    // The DEL_IF_SAME script's rule (lib/slot-cas.ts): only while the slot still holds that trade.
    eval: async (_script: string, _n: number, key: string, expected: string) => {
      const raw = mem.kv.get(key);
      if (!raw || `sig:${JSON.parse(raw).signalId}` !== expected) return 0;
      mem.kv.delete(key);
      return 1;
    },
  },
  scanKeys: async (p: string) => [...mem.kv.keys()].filter((k) => k.startsWith(p.replace('*', ''))),
}));
const db = vi.hoisted(() => ({
  open: [] as any[],
  later: [] as any[],
  closes: [] as any[],
  updates: [] as Array<{ text: string; values: unknown[] }>,
}));
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    if (text.startsWith('UPDATE signals')) {
      db.updates.push({ text, values });
      const ids = values.find((v) => Array.isArray(v)) as string[] | undefined;
      const one = values.find((v) => typeof v === 'string' && /^[a-z0-9-]{4,}$/.test(v)) as string | undefined;
      return Promise.resolve((ids ?? [one]).filter(Boolean).map((id) => ({ id })));
    }
    if (text.includes('FROM option_plans p JOIN option_plan_events')) return Promise.resolve(db.closes);
    if (text.includes("(inputs->>'outcome') IS NULL AND time > NOW()")) return Promise.resolve(db.open);
    if (text.includes("WHERE signal_type = 'TRADE_SETUP' AND time >")) return Promise.resolve(db.later);
    return Promise.resolve([]);
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));

const SR = await import('../state-recovery.js');

const row = (id: string, time: string, symbol: string, mode: string, expiry: string | null, exchange = 'MCX') => ({ id, time, symbol, exchange, mode, expiry });
const TODAY = '2026-10-18';

describe('lostTradeVerdicts (pure)', () => {
  const e41 = row('e41a6899', '2026-10-08T07:01:56Z', 'CRUDEOIL', 'POSITIONAL', '2026-10-15');
  it('a superseded POSITIONAL row is lost even when it is not the newest open row on its slot', () => {
    const newer = row('8fd5eff2', '2026-10-08T16:18:50Z', 'CRUDEOIL', 'POSITIONAL', '2026-10-15');
    const v = SR.lostTradeVerdicts({ open: [e41, newer], trades: [e41, newer], held: new Set(['8fd5eff2']), today: TODAY });
    expect(v).toEqual([{ id: 'e41a6899', why: SR.LOST_SUPERSEDED }]);
  });
  it('an unheld row whose option has expired is lost; on its expiry day it is not', () => {
    const lone = row('p1', '2026-10-13T05:00:00Z', 'GOLD', 'POSITIONAL', '2026-10-17');
    expect(SR.lostTradeVerdicts({ open: [lone], trades: [lone], held: new Set(), today: TODAY })).toEqual([{ id: 'p1', why: 'its option expired on 2026-10-17 and no slot can price it' }]);
    expect(SR.lostTradeVerdicts({ open: [lone], trades: [lone], held: new Set(), today: '2026-10-17' })).toEqual([]);
  });
  it('held rows are never touched; another mode or exchange is another slot; today’s unheld intraday row is kept', () => {
    const held = row('h1', '2026-10-01T05:00:00Z', 'GOLD', 'POSITIONAL', '2026-10-10');
    const pos = row('a', '2026-10-16T05:00:00Z', 'NIFTY', 'POSITIONAL', '2026-10-27', 'NSE');
    const intradayLater = row('b', '2026-10-16T06:00:00Z', 'NIFTY', 'INTRADAY', '2026-10-21', 'NSE');
    const otherExchange = row('c', '2026-10-16T07:00:00Z', 'NIFTY', 'POSITIONAL', '2026-10-27', 'BSE');
    const todayIntraday = row('d', '2026-10-18T05:00:00Z', 'CRUDEOIL', 'INTRADAY', '2026-11-17');
    const v = SR.lostTradeVerdicts({ open: [held, pos, todayIntraday], trades: [held, pos, intradayLater, otherExchange, todayIntraday], held: new Set(['h1']), today: TODAY });
    expect(v).toEqual([]);
  });
  it('an intraday row from an earlier session is lost, as before', () => {
    const old = row('i1', '2026-10-16T05:00:00Z', 'NIFTY', 'INTRADAY', '2026-10-21', 'NSE');
    expect(SR.lostTradeVerdicts({ open: [old], trades: [old], held: new Set(), today: TODAY })).toEqual([{ id: 'i1', why: SR.LOST_EARLIER_SESSION }]);
  });
  it('isPastExpiry ignores a missing or non-ISO expiry', () => {
    expect(SR.isPastExpiry('2026-10-15', TODAY)).toBe(true);
    expect(SR.isPastExpiry(null, TODAY)).toBe(false);
    expect(SR.isPastExpiry('15OCT2026', TODAY)).toBe(false);
  });
});

describe('planCloseOf (pure)', () => {
  it('reads the close the plan recorded', () => {
    expect(SR.planCloseOf('EXPIRED (BIAS_REVERSED) at 257.1')).toEqual({ outcome: 'EXPIRED', closeReason: 'BIAS_REVERSED', exitPrice: 257.1 });
    expect(SR.planCloseOf('WIN (TARGET) at 328.4')).toEqual({ outcome: 'WIN', closeReason: 'TARGET', exitPrice: 328.4 });
    expect(SR.planCloseOf('LOSS (STOP_LOSS) at 184')).toEqual({ outcome: 'LOSS', closeReason: 'STOP_LOSS', exitPrice: 184 });
  });
  it('no price, or anything else, is not a usable close', () => {
    expect(SR.planCloseOf('EXPIRED (BIAS_REVERSED)')).toBeNull();
    expect(SR.planCloseOf('Plan at the mint.')).toBeNull();
    expect(SR.planCloseOf(null)).toBeNull();
  });
});

describe('sweepLostTrades (IO shell)', () => {
  beforeEach(() => {
    mem.kv.clear();
    db.open = [];
    db.later = [];
    db.closes = [];
    db.updates = [];
  });

  it('applies the close the plan recorded instead of voiding; voids the rest; releases a slot whose option expired', async () => {
    const e41 = row('e41a6899', '2026-10-08T07:01:56Z', 'CRUDEOIL', 'POSITIONAL', '2026-10-15');
    const newer = row('8fd5eff2', '2026-10-17T16:18:50Z', 'CRUDEOIL', 'POSITIONAL', '2026-11-17');
    const expiredHeld = row('g0ld0001', '2026-10-01T05:00:00Z', 'GOLD', 'POSITIONAL', '2026-10-10');
    const lostNoPlan = row('n1fty001', '2026-10-16T05:00:00Z', 'NIFTY', 'INTRADAY', '2026-10-21', 'NSE');
    db.open = [e41, newer, expiredHeld, lostNoPlan];
    db.later = [e41, newer, expiredHeld, lostNoPlan];
    mem.kv.set('trade_setup:MCX:CRUDEOIL:POSITIONAL', JSON.stringify({ signalId: '8fd5eff2', available: true }));
    mem.kv.set('trade_setup:MCX:GOLD:POSITIONAL', JSON.stringify({ signalId: 'g0ld0001', available: true }));
    // The plan's FIRST close is the one applied (the query orders by time ascending, DISTINCT ON the signal).
    db.closes = [{ signal_id: 'e41a6899', reason: 'EXPIRED (BIAS_REVERSED) at 257.1', at: new Date('2026-10-08T11:16:49.334Z'), minted: new Date('2026-10-08T07:01:56Z') }];

    const n = await SR.sweepLostTrades(Date.parse('2026-10-18T06:00:00Z'));
    expect(n).toBe(3);
    // The expired option's slot is released; the live slot is kept.
    expect(mem.kv.has('trade_setup:MCX:GOLD:POSITIONAL')).toBe(false);
    expect(mem.kv.has('trade_setup:MCX:CRUDEOIL:POSITIONAL')).toBe(true);
    const recovered = db.updates.find((u) => u.values.includes('e41a6899'));
    expect(recovered?.values[0]).toMatchObject({ outcome: 'EXPIRED', closeReason: 'BIAS_REVERSED', exitPrice: 257.1, exitTime: 1791458209334, holdMinutes: 255, recoveredFrom: 'OPTION_PLAN_CLOSED_EVENT' });
    expect(recovered?.text).toMatch(/AND \(inputs->>'outcome'\) IS NULL/);
    const voids = db.updates.filter((u) => u.text.includes('id = ANY'));
    expect(voids.map((u) => u.values[1])).toEqual(expect.arrayContaining([['g0ld0001'], ['n1fty001']]));
    for (const u of voids) expect(u.values[0]).toMatchObject({ outcome: 'EXPIRED', closeReason: 'TRACKING_LOST', voided: true });
    // The held, live trade is never written.
    expect(db.updates.some((u) => JSON.stringify(u.values).includes('8fd5eff2'))).toBe(false);
  });

  it('nothing open, or everything held and live: no writes', async () => {
    expect(await SR.sweepLostTrades()).toBe(0);
    db.open = [row('t1', '2026-10-16T05:00:00Z', 'TCS', 'POSITIONAL', '2026-10-27', 'NSE')];
    mem.kv.set('trade_setup:NSE:TCS:POSITIONAL', JSON.stringify({ signalId: 't1' }));
    expect(await SR.sweepLostTrades(Date.parse('2026-10-18T06:00:00Z'))).toBe(0);
    expect(db.updates).toEqual([]);
  });
});
