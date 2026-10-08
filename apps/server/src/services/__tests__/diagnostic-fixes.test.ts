// ============================================================
// DIAGNOSTIC FIXES (2026-10-09)
// ============================================================
//   H1  the trade slot is only updated / cleared if it still holds the trade
//       the caller read (a stale copy never overwrites a newer trade)
//   H2  a close is idempotent (only an OPEN row) and never dropped (queued
//       when the database refuses it); recovery never revives a superseded
//       row and closes lost intraday rows TRACKING_LOST (voided)
//   H3  the anomalous session-close bar is detected (real live bars of
//       8 Oct) and flattened for grading only
//   MCX order flow: Dhan MCX_COMM futures resolved and subscribed
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An in-memory Redis whose eval runs the CAS scripts' rule (sameTrade).
const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), list: [] as string[] }));
vi.mock('../../lib/redis.js', async () => {
  const { sameTrade } = await vi.importActual<typeof import('../../lib/slot-cas.js')>('../../lib/slot-cas.js');
  return {
    redis: {
      get: async (k: string) => mem.kv.get(k) ?? null,
      set: async (k: string, v: string) => (mem.kv.set(k, v), 'OK'),
      del: async (k: string) => (mem.kv.delete(k) ? 1 : 0),
      eval: async (script: string, _n: number, key: string, expected: string, value?: string) => {
        if (!sameTrade(mem.kv.get(key) ?? null, expected)) return 0;
        if (script.includes("redis.call('DEL'")) mem.kv.delete(key);
        else mem.kv.set(key, value!);
        return 1;
      },
      rpush: async (_k: string, v: string) => mem.list.push(v),
      lrange: async () => [...mem.list],
      lrem: async (_k: string, _c: number, v: string) => {
        const i = mem.list.indexOf(v);
        if (i >= 0) mem.list.splice(i, 1);
        return i >= 0 ? 1 : 0;
      },
    },
    scanKeys: async (p: string) => [...mem.kv.keys()].filter((k) => k.startsWith(p.replace('*', ''))),
  };
});
const db = vi.hoisted(() => ({ fail: false, updates: [] as string[] }));
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (db.fail) return Promise.reject(new Error('could not write init file: No space left on device'));
    db.updates.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return Promise.resolve(Object.assign([{ id: 'x' }], { count: 1 }));
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const CAS = await import('../../lib/slot-cas.js');
const PO = await import('../pending-outcomes.js');
const SR = await import('../state-recovery.js');
const BA = await import('../bar-anomaly.js');
const P = await import('../../lib/dhan-feed-packets.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(HERE, f), 'utf8');

describe('H1: the slot is only written by a caller that still holds the same trade', () => {
  const KEY = 'trade_setup:NSE:NIFTY:INTRADAY';
  const A = { available: true, signalId: 'A', generatedAt: 1, strike: 22450 };
  const B = { available: true, signalId: 'B', generatedAt: 2, strike: 22450 };
  beforeEach(() => mem.kv.clear());

  it('the 8 Oct race: the poll minted B; the monitor\'s stale copy of A can no longer overwrite it', async () => {
    mem.kv.set(KEY, JSON.stringify(B));
    expect(await CAS.setSlotIfSame(KEY, CAS.slotIdentity(A), { ...A, excursion: {} }, 60)).toBe(false);
    expect(JSON.parse(mem.kv.get(KEY)!).signalId).toBe('B');
    expect(await CAS.delSlotIfSame(KEY, CAS.slotIdentity(A))).toBe(false);
    expect(mem.kv.has(KEY)).toBe(true);
  });
  it('the holder of the current trade updates and clears it as before', async () => {
    mem.kv.set(KEY, JSON.stringify(A));
    expect(await CAS.setSlotIfSame(KEY, CAS.slotIdentity(A), { ...A, stopLoss: 10 }, 60)).toBe(true);
    expect(JSON.parse(mem.kv.get(KEY)!).stopLoss).toBe(10);
    expect(await CAS.delSlotIfSame(KEY, CAS.slotIdentity(A))).toBe(true);
    expect(mem.kv.has(KEY)).toBe(false);
  });
  it('identity: the signals row id, else the generation time (a trade whose row is not written yet)', () => {
    expect(CAS.slotIdentity(A)).toBe('sig:A');
    expect(CAS.slotIdentity({ generatedAt: 1791471889323 })).toBe('gen:1791471889323');
    expect(CAS.slotIdentity(null)).toBeNull();
    expect(CAS.sameTrade(JSON.stringify({ generatedAt: 5 }), 'gen:5')).toBe(true);
  });
  it('every update or clear of an existing trade in market-bias goes through the CAS (no plain SET / DEL of a read copy)', () => {
    const mb = read('../market-bias.ts');
    expect(mb.match(/redis\.del\(key\)/g) ?? []).toHaveLength(0);
    // The only plain trade-slot SET left is the mint of a NEW trade (under the mint lock);
    // the other plain SET in the file is the vote-state key, not a trade slot.
    const plain = mb.match(/redis\.set\(key, JSON\.stringify\((\w+)\)/g) ?? [];
    expect(plain.sort()).toEqual(['redis.set(key, JSON.stringify(state)', 'redis.set(key, JSON.stringify(toStore)']);
  });
});

describe('H2: a close is idempotent and never dropped; recovery never revives a lost trade', () => {
  beforeEach(() => {
    mem.list.length = 0;
    db.fail = false;
    db.updates.length = 0;
  });
  it('the close only updates an OPEN row (a second closer is a no-op) and is queued when the database refuses it', () => {
    const mb = read('../market-bias.ts');
    expect(mb).toMatch(/WHERE id = \$\{stored\.signalId\} AND \(inputs->>'outcome'\) IS NULL\s+RETURNING id/);
    expect(mb).toMatch(/status = rows\.length > 0 \? 'RECORDED' : 'DUPLICATE';/);
    expect(mb).toMatch(/await queuePendingOutcome\(\{ signalId: stored\.signalId, patch, returnPercent \}\)/);
    expect(mb).toMatch(/if \(status === 'DUPLICATE'\) \{[\s\S]{0,200}return status;/);
  });
  it('queued closes are applied once the database accepts writes, oldest first, and kept while it refuses', async () => {
    await PO.queuePendingOutcome({ signalId: 's1', patch: { outcome: 'WIN' }, returnPercent: 3 });
    await PO.queuePendingOutcome({ signalId: 's2', patch: { outcome: 'LOSS' }, returnPercent: -20 });
    db.fail = true;
    expect(await PO.drainPendingOutcomes()).toEqual({ applied: 0, remaining: 2 });
    db.fail = false;
    expect(await PO.drainPendingOutcomes()).toEqual({ applied: 2, remaining: 0 });
    expect(db.updates.every((u) => /AND \(inputs->>'outcome'\) IS NULL/.test(u))).toBe(true);
  });
  it('recovery: a row a later trade on the same slot superseded is not revived', () => {
    const row = { id: '8c7d', time: '2026-10-08T07:03:00Z' };
    expect(SR.isSuperseded(row, [{ id: 'ec21', time: '2026-10-08T12:02:56Z' }])).toBe(true);
    expect(SR.isSuperseded(row, [{ id: 'old', time: '2026-10-08T06:00:00Z' }, row])).toBe(false);
  });
  it('recovery applies queued closes first, then the trade slots, then the lost-trade sweep', () => {
    const src = read('../state-recovery.ts');
    const a = src.indexOf("await step('pending_outcomes'");
    const b = src.indexOf("await step('trade_setup'");
    const c = src.indexOf("await step('lost_trades'");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
  it('the monitor drains the queue every sweep and runs the lost-trade sweep every 30 minutes', () => {
    const src = read('../trade-setup-monitor.ts');
    expect(src).toMatch(/await drainPendingOutcomes\(\)/);
    expect(src).toMatch(/LOST_TRADE_SWEEP_MS = 30 \* 60 \* 1000/);
  });
});

describe('H3: anomalous session-close bar', () => {
  const live = JSON.parse(read('fixtures/live-close-bars.json')).series as Record<string, number[][]>;
  const hist = JSON.parse(read('fixtures/regression-bars.json')).series as Record<string, number[][]>;
  const bars = (rows: number[][]) => rows.map(([time, open, high, low, close]) => ({ time, open, high, low, close }));

  it('flags the bar the live engine read at 15:30 on 8 Oct (NIFTY, BANKNIFTY)', () => {
    for (const sym of ['NIFTY', 'BANKNIFTY']) {
      const b = bars(live[sym]);
      const a = BA.sessionCloseBarAnomalyAt(b, b.length - 1, 'NSE');
      expect(a, sym).not.toBeNull();
      expect(new Date(a!.barTime).toISOString()).toBe('2026-10-08T09:45:00.000Z');
    }
  });
  it('no false flags on 12 normal sessions of broker history (NIFTY, BANKNIFTY); MCX is out of scope (a genuine late CRUDEOIL move is left alone)', () => {
    for (const sym of ['NIFTY', 'BANKNIFTY']) expect(BA.sessionCloseBarAnomalies(bars(hist[sym]), 'NSE'), sym).toEqual([]);
    expect(BA.sessionCloseBarAnomalies(bars(hist.CRUDEOIL), 'MCX')).toEqual([]);
  });
  it('grading flattens it to its close; every other bar is untouched', () => {
    const b = bars(live.NIFTY);
    const s = BA.sanitizeSessionCloseBars(b, 'NSE');
    expect(s[s.length - 1]).toMatchObject({ open: b[b.length - 1].close, high: b[b.length - 1].close, low: b[b.length - 1].close });
    expect(s.slice(0, -1)).toEqual(b.slice(0, -1));
  });
  it('only the session\'s FINAL bar can be flagged (a mid-session expansion is a market move)', () => {
    const b = bars(live.NIFTY);
    const mid = b.length - 10;
    const bumped = b.map((x, i) => (i === mid ? { ...x, high: x.high + 500 } : x));
    expect(BA.sessionCloseBarAnomalyAt(bumped, mid, 'NSE')).toBeNull();
  });
  it('the live engines are unchanged by it (recorded only); grading uses the flattened bars', () => {
    expect(read('../market-bias.ts')).toMatch(/await recordCloseBarAnomaly\(underlying, exchange, closedNow\);/);
    expect(read('../forward-validation.ts').match(/sanitizeSessionCloseBars\(/g) ?? []).toHaveLength(2);
  });
});

describe('MCX order flow (Dhan MCX_COMM)', () => {
  const csv = [
    'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
    'MCX,M,569900,FUTCOM,0,CRUDEOIL-19Oct2026-FUT,1.0,CRUDEOIL OCT FUT,2026-10-19 23:30:00,0.00000,XX,100.0000,M,FUTCOM,2,CRUDEOIL',
    'MCX,M,569901,FUTCOM,0,CRUDEOILM-19Oct2026-FUT,1.0,CRUDEOILM OCT FUT,2026-10-19 23:30:00,0.00000,XX,100.0000,M,FUTCOM,2,CRUDEOILM',
    'MCX,M,573422,FUTCOM,0,CRUDEOIL-19Nov2026-FUT,1.0,CRUDEOIL NOV FUT,2026-11-19 23:30:00,0.00000,XX,100.0000,M,FUTCOM,2,CRUDEOIL',
    'MCX,M,495213,FUTCOM,0,GOLD-04Dec2026-FUT,1.0,GOLD DEC FUT,2026-12-04 23:30:00,0.00000,XX,100.0000,M,FUTCOM,2,GOLD',
    'NSE,D,48704,FUTIDX,0,NIFTY-Oct2026-FUT,65.0,NIFTY OCT FUT,2026-10-27 14:30:00,-0.01000,XX,10.0000,M,FUT,,',
  ].join('\n');
  it('resolves the nearest MCX futures (exact root: CRUDEOIL is not CRUDEOILM) beside the NSE index futures', () => {
    const r = P.resolveNearestFutures(csv, [{ symbol: 'CRUDEOIL', exchange: 'MCX' }, { symbol: 'GOLD', exchange: 'MCX' }, { symbol: 'NIFTY', exchange: 'NSE' }], Date.parse('2026-10-09T10:00:00+05:30'));
    expect(r.CRUDEOIL).toEqual({ securityId: '569900', tradingSymbol: 'CRUDEOIL-19Oct2026-FUT', expiry: '2026-10-19 23:30:00', segment: 'MCX_COMM', exchange: 'MCX' });
    expect(r.GOLD.securityId).toBe('495213');
    expect(r.NIFTY).toMatchObject({ securityId: '48704', segment: 'NSE_FNO', exchange: 'NSE' });
    expect(P.resolveNearestFutures(csv, [{ symbol: 'CRUDEOIL', exchange: 'MCX' }], Date.parse('2026-10-20T10:00:00+05:30')).CRUDEOIL.securityId).toBe('573422');
  });
  it('subscribes each instrument on its own segment; packet keys carry the segment code', () => {
    expect(JSON.parse(P.fullSubscription([{ securityId: '569900', segment: 'MCX_COMM' }, { securityId: '48704', segment: 'NSE_FNO' }])).InstrumentList).toEqual([
      { ExchangeSegment: 'MCX_COMM', SecurityId: '569900' },
      { ExchangeSegment: 'NSE_FNO', SecurityId: '48704' },
    ]);
    expect(P.DHAN_SEGMENT_CODE).toEqual({ NSE_FNO: 2, MCX_COMM: 5 });
    expect(read('../dhan-feed.ts')).toMatch(/const ikey = `\$\{p\.header\.segment\}:\$\{p\.header\.securityId\}`;/);
  });
});
