// ============================================================
// FULL REPLAY — end to end. The REAL buildMarketBias (indicator engine,
// safety gates, option build, slot arbitration, settlement) runs once live
// with its tape recorded, then — days later on the wall clock — is replayed
// from the tape alone: every real Redis / SQL / broker / network access is
// set to fail, and the result must equal the live one.
// ============================================================

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { MarketQuote, OHLCV } from '@fno/shared';

// ---- the live boundaries: in-memory Redis and SQL, behind the real tape wrappers ----
const io = { liveCalls: 0, blocked: false };
const mem = new Map<string, string>();
const touch = () => {
  io.liveCalls++;
  if (io.blocked) throw new Error('REAL I/O DURING REPLAY');
};
const memRedis = {
  get: async (k: string) => (touch(), mem.get(k) ?? null),
  mget: async (...ks: string[]) => (touch(), ks.map((k) => mem.get(k) ?? null)),
  set: async (k: string, v: string, ...a: unknown[]) => {
    touch();
    if (a.includes('NX') && mem.has(k)) return null;
    mem.set(k, String(v));
    return 'OK';
  },
  del: async (...ks: string[]) => (touch(), ks.filter((k) => mem.delete(k)).length),
  expire: async () => (touch(), 1),
  incr: async (k: string) => {
    touch();
    const n = Number(mem.get(k) ?? 0) + 1;
    mem.set(k, String(n));
    return n;
  },
  zadd: async () => (touch(), 1),
  zremrangebyscore: async () => (touch(), 0),
  exists: async (k: string) => (touch(), mem.has(k) ? 1 : 0),
  ttl: async (k: string) => (touch(), mem.has(k) ? 60 : -2),
  scan: async () => (touch(), ['0', []]),
  on: () => undefined,
};
let sigSeq = 0;
const rawSql: any = (strings: TemplateStringsArray, ...args: unknown[]) => {
  const q: any = {
    strings,
    args,
    then(res: any, rej: any) {
      try {
        touch();
      } catch (e) {
        return Promise.reject(e).then(res, rej);
      }
      const text = strings.join('?');
      const rows = /RETURNING id/i.test(text) ? [{ id: `00000000-0000-4000-8000-${String(++sigSeq).padStart(12, '0')}` }] : [];
      return Promise.resolve(rows).then(res, rej);
    },
    catch(rej: any) {
      return q.then(undefined, rej);
    },
  };
  return q;
};
rawSql.json = (value: unknown) => ({ value, type: 3802, array: false });

vi.mock('../../lib/redis.js', async () => {
  const { tapedRedis } = await import('../../lib/io-tape.js');
  return { redis: tapedRedis(memRedis), scanKeys: async () => [] };
});
vi.mock('../../lib/db.js', async () => {
  const { tapedSql } = await import('../../lib/io-tape.js');
  return { sql: tapedSql(rawSql), pingDb: async () => ({ healthy: true }) };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true, captureSchemaStatus: () => null }));

// The store: capture what the live poll persisted (the snapshot and its tape).
const stored: { snap: any; tape: any; live: any } = { snap: null, tape: null, live: null };
vi.mock('../decision-record-store.js', async () => {
  const { encode, decode } = await import('../../lib/io-tape.js');
  return {
    DECISION_TAPE_ENABLED: true,
    persistSnapshot: async (s: any) => ((stored.snap = s), true),
    persistDecisionRecord: async () => true,
    persistTape: async (_id: string, tape: any, live: any) => {
      stored.tape = JSON.parse(JSON.stringify(tape));
      stored.live = decode(JSON.parse(JSON.stringify(encode(live))));
    },
    loadSnapshot: async () => stored.snap,
    loadTape: async () => (stored.tape ? { tape: stored.tape, liveResult: stored.live, entries: stored.tape.length, bytes: 0 } : null),
  };
});

// ---- a synthetic NIFTY market served by a fake broker ----
const M15 = 15 * 60 * 1000;
const ist = (s: string) => Date.parse(`${s}+05:30`);
const isoIst = (t: number) => new Date(t + 330 * 60_000).toISOString().replace('Z', '+05:30');
type Bar = [number, number, number, number];
const sessionBars = (date: string, p: Bar[]) => p.map(([o, h, l, c], k) => ({ t: ist(`${date}T09:15:00`) + k * M15, o, h, l, c }));
const quiet = (date: string) =>
  sessionBars(date, Array.from({ length: 25 }, (_, k) => {
    const o = 25000 + ((k % 4) - 1.5) * 20;
    const c = 25000 + (((k + 1) % 4) - 1.5) * 20;
    return [o, Math.max(o, c) + 40, Math.min(o, c) - 40, c] as Bar;
  }));
const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
const today = sessionBars('2026-08-10', [
  [25000, 25040, 24960, 25020], [25020, 25060, 24990, 25040], [25040, 25070, 25010, 25050], [25050, 25120, 25030, 25040],
  [25040, 25050, 25000, 25010], [25010, 25030, 24980, 25020], [25020, 25040, 24990, 25000], [25000, 25010, 24940, 24950],
  [24950, 24960, 24930, 24945],
]);
const bars15 = [...days.flatMap(quiet), ...today];
const toOhlcv = (b: { t: number; o: number; h: number; l: number; c: number }): OHLCV => ({ timestamp: isoIst(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: 1000 });
const hourly = (() => {
  const by = new Map<number, typeof bars15>();
  for (const b of bars15) {
    const h = b.t - ((b.t - ist('2026-01-01T09:15:00')) % (60 * 60_000));
    by.set(h, [...(by.get(h) ?? []), b]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => ({ t, o: xs[0].o, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs[xs.length - 1].c }));
})();

const SPOT = 24945;
const EXPIRY = '2026-08-13';
const STRIKES = Array.from({ length: 21 }, (_, k) => 24500 + k * 50);
const instruments = [
  ...STRIKES.flatMap((k) => (['CE', 'PE'] as const).map((side) => ({ token: `${side}${k}`, symbol: `NIFTY13AUG26${k}${side}`, name: 'NIFTY', exchange: 'NSE', segment: 'FO', instrumentType: 'OPTIDX', underlying: 'NIFTY', strike: k, optionType: side, expiry: EXPIRY, lotSize: 75, tickSize: 0.05, isFnO: true }))),
  { token: 'FUT1', symbol: 'NIFTY26AUGFUT', name: 'NIFTY', exchange: 'NSE', segment: 'FO', instrumentType: 'FUTIDX', underlying: 'NIFTY', expiry: '2026-08-27', lotSize: 75, tickSize: 0.05, isFnO: true },
];
const premium = (side: string, k: number) => Math.max(5, (side === 'CE' ? SPOT - k : k - SPOT) + 120 - Math.abs(SPOT - k) * 0.15);
const quote = (token: string): MarketQuote => {
  const m = /^(CE|PE)(\d+)$/.exec(token);
  const ltp = m ? Math.round(premium(m[1], Number(m[2])) * 20) / 20 : token === 'FUT1' ? SPOT + 40 : token === '99926017' ? 13.2 : SPOT;
  return { token, symbol: token, exchange: 'NSE', ltp, change: 0, changePercent: 0, open: ltp, high: ltp, low: ltp, close: ltp * 0.995, volume: 200_000, oi: 3_000_000, bid: ltp - 0.05, ask: ltp + 0.05, timestamp: ist('2026-08-10T11:17:30') };
};
const liveProvider: any = {
  name: 'test-broker',
  isAuthenticated: () => (touch(), true),
  getHistoricalData: async (p: { interval: string }) => (touch(), (p.interval === 'ONE_HOUR' ? hourly : bars15).map(toOhlcv)),
  getQuote: async (_seg: string, tokens: string[]) => (touch(), tokens.map(quote)),
  getInstrumentMaster: async () => (touch(), instruments),
  getExpiries: async () => (touch(), [EXPIRY, '2026-08-20']),
  getOptionGreeks: async () => (touch(), []),
  searchInstruments: async () => (touch(), []),
};

const POLL = ist('2026-08-10T11:18:00');

let live: any;
let report: any;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(POLL);
  const { buildMarketBias } = await import('../market-bias.js');
  live = await buildMarketBias(liveProvider, 'NIFTY', 'NSE', 'INTRADAY');
  await new Promise((r) => setImmediate(r));
  // Days later; every real boundary now fails if touched.
  vi.setSystemTime(ist('2026-08-14T15:00:00'));
  io.blocked = true;
  io.liveCalls = 0;
  const { replayFull } = await import('../full-replay.js');
  report = await replayFull(stored.snap?.snapshotId ?? 'none');
}, 120_000);
afterAll(() => {
  io.blocked = false;
  vi.useRealTimers();
});

describe('full replay of the real decision path', () => {
  it('the live poll ran the full path and stored a snapshot and its tape', () => {
    expect(live.bias).toBeTruthy();
    expect(live.tradeSetup).toBeTruthy();
    expect(stored.snap?.snapshotId).toBeTruthy();
    expect(stored.tape.length).toBeGreaterThan(10);
    const chs = new Set(stored.tape.map((e: any) => e.ch));
    for (const ch of ['redis', 'provider', 'input']) expect(chs.has(ch), ch).toBe(true);
  });

  // Regression guard (2026-10-09): the whole live decision of the indicator
  // engine + S1 + families + arbitration + option leg on this market, hashed
  // on main before the Order Block fix / OF1. It must not change.
  it('the live decision is identical to main (end-to-end fingerprint)', async () => {
    const { stripVolatile } = await import('../full-replay.js');
    const { createHash } = await import('node:crypto');
    const fp = createHash('sha256').update(JSON.stringify(stripVolatile(JSON.parse(JSON.stringify(live))))).digest('hex').slice(0, 16);
    if (process.env.PRINT_FINGERPRINT) console.log(`FP e2e '${fp}'`);
    expect(fp).toBe('872813b6a2bd4d8c');
  });

  it('replays to the same result — no divergence, no real I/O, days later on the wall clock', () => {
    expect(report.error).toBeNull();
    expect(report.divergences).toEqual([]);
    expect(report.diff).toEqual([]);
    expect(report.status).toBe('MATCH');
    expect(io.liveCalls).toBe(0);
  });

  it('the replay makes the same writes, as effects only', () => {
    expect(report.effects.replay).toBeGreaterThan(0);
    expect(report.effects.onlyLive).toEqual([]);
    expect(report.effects.onlyReplay).toEqual([]);
  });

  it('the live poll went through the option build and the slot, and minted; the replay settles identically', () => {
    // The fixture is built so a family candidate mints: the full chain ran (gates, option build, arbitration, settlement).
    expect(live.tradeSetup.available).toBe(true);
    expect(report.replayed).toMatchObject({ available: true, strike: live.tradeSetup.strike, strategy: live.tradeSetup.strategy ?? null });
    // Settlement writes, reproduced as effects (never executed): the paper trade row and the slot.
    expect(report.effects.onlyLive).toEqual([]);
    const tapeWrites = stored.tape.filter((e: any) => e.write).map((e: any) => e.key);
    expect(tapeWrites.some((k: string) => k.includes('INSERT INTO signals'))).toBe(true);
    expect(tapeWrites.some((k: string) => k.includes('trade_setup:NSE:NIFTY:INTRADAY'))).toBe(true);
  });

  it('a tampered tape (a removed read) is a divergence, never answered with current data', async () => {
    const { runReplay, replayProvider } = await import('../../lib/io-tape.js');
    const { withDecisionTime } = await import('../decision-clock.js');
    const { buildMarketBias } = await import('../market-bias.js');
    const firstProviderRead = stored.tape.findIndex((e: any) => e.ch === 'input' || e.ch === 'provider');
    const tampered = stored.tape.filter((_: any, i: number) => i !== firstProviderRead);
    io.liveCalls = 0;
    const out = await runReplay(tampered, () => withDecisionTime(POLL, () => buildMarketBias(replayProvider('test-broker'), 'NIFTY', 'NSE', 'INTRADAY')), { now: POLL });
    expect(out.divergences.length).toBeGreaterThan(0);
    expect(io.liveCalls).toBe(0);
  });
});
